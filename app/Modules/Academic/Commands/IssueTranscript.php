<?php

declare(strict_types=1);

namespace App\Modules\Academic\Commands;

use App\Modules\Academic\Domain\TranscriptComposer;
use App\Modules\Academic\Models\ProgramVersion;
use App\Modules\Academic\Models\Transcript;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Documents\Commands\RegisterDocument;
use App\Modules\Documents\Commands\TransitionDocument;
use App\Modules\Documents\Models\Document;
use App\Modules\Documents\Models\DocumentClassification;
use App\Modules\Students\Models\Student;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use App\Support\Signing\CanonicalJson;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * Issues the official transcript: composes the record from immutable
 * Academic facts, freezes the canonical payload with its SHA-256 hash,
 * registers and submits the managed transcript document, and stores the
 * immutable issuance row. Prints render the stored payload, never a
 * re-derivation. Re-issuance after new achievements produces a new record;
 * the idempotency key guards double submission, not content change.
 */
final class IssueTranscript
{
    public const CAPABILITY_ISSUE = 'academic.transcript_issue';

    public const DOCUMENT_CATEGORY = 'academic.transcript';

    public const SCHEMA_VERSION = 'transcript/v1';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
        private readonly TranscriptComposer $composer,
        private readonly RegisterDocument $registerDocument,
        private readonly TransitionDocument $transitionDocument,
    ) {}

    /** @return array{transcript_id: string, document_id: string, content_hash: string, correlation_id: string} */
    public function issue(Actor $issuer, string $studentId, string $programVersionId, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.transcript.issue', $studentId, $programVersionId, $issuer->actorId]));

        try {
            return $this->idempotency->execute('academic.transcript.issue', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($issuer, $studentId, $programVersionId, $idempotencyKey): array {
                    $outcome = $this->access->decide($issuer, self::CAPABILITY_ISSUE, null);
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('academic.transcript_denied', $outcome->reason);
                    }

                    /** @var Student $student */
                    $student = Student::query()->findOrFail($studentId);
                    ProgramVersion::query()->findOrFail($programVersionId);

                    $classificationId = DocumentClassification::query()
                        ->where('category', self::DOCUMENT_CATEGORY)
                        ->value('id');
                    if (! is_string($classificationId) || $classificationId === '') {
                        throw BusinessRejection::forCode('academic.transcript_classification_missing', 'issuance requires the registrar to define the academic.transcript document classification first');
                    }

                    $transcriptId = RandomIdentifier::new();
                    $issuedAt = CarbonImmutable::now()->toIso8601String();
                    $content = $this->composer->compose((string) $student->id, $programVersionId);
                    $frozen = array_merge([
                        'schema' => self::SCHEMA_VERSION,
                        'transcript_id' => $transcriptId,
                        'issued_by' => $issuer->actorId,
                        'issued_at' => $issuedAt,
                    ], $content);
                    $canonical = CanonicalJson::encode($frozen);
                    $contentHash = hash('sha256', $canonical);

                    $title = sprintf(
                        'Transcript %s · %s · %s',
                        (string) ($content['student']['student_code'] ?? $student->id),
                        (string) ($content['program']['program_name'] ?? $programVersionId),
                        substr($issuedAt, 0, 10),
                    );
                    $storageRef = 'transcripts:'.$transcriptId;
                    $registered = $this->registerDocument->register(
                        $issuer,
                        (string) $student->person_id,
                        $classificationId,
                        $title,
                        $contentHash,
                        $storageRef,
                        $idempotencyKey.':document',
                    );
                    $document = Document::query()->findOrFail($registered['document_id']);
                    $this->transitionDocument->submit($issuer, $document, $contentHash, $storageRef, $idempotencyKey.':submit');

                    $transcript = Transcript::query()->create([
                        'id' => $transcriptId,
                        'student_id' => $student->id,
                        'program_version_id' => $programVersionId,
                        'payload' => $frozen,
                        'content_hash' => $contentHash,
                        'document_id' => $registered['document_id'],
                        'issued_by' => $issuer->actorId,
                        'issued_at' => $issuedAt,
                    ]);
                    $event = $this->audit->record($issuer->actorId, 'academic.transcript.issue', 'transcript', $transcript->id, null, [
                        'student_id' => $student->id,
                        'program_version_id' => $programVersionId,
                        'document_id' => $registered['document_id'],
                        'content_hash' => $contentHash,
                    ]);

                    return [
                        'transcript_id' => $transcript->id,
                        'document_id' => $registered['document_id'],
                        'content_hash' => $contentHash,
                        'correlation_id' => $event->correlation_id,
                    ];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $issuer, 'academic.transcript.issue', 'transcript', $studentId);
        }
    }
}
