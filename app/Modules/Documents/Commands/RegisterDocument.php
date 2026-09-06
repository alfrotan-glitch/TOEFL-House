<?php

declare(strict_types=1);

namespace App\Modules\Documents\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Crm\Domain\CrmInteractionTraceRecorder;
use App\Modules\Documents\Models\Document;
use App\Modules\Documents\Models\DocumentClassification;
use App\Modules\Documents\Models\DocumentVersion;
use App\Modules\Identity\Models\Person;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * Registers a subject evidence document as a draft with its first
 * immutable content version. The storage reference locates content; it is
 * never authority — download and disclosure always require current
 * authorization.
 */
final class RegisterDocument
{
    public const CAPABILITY = 'documents.register';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
        private readonly CrmInteractionTraceRecorder $crmTrace,
    ) {}

    /**
     * @return array{document_id: string, version_no: int, correlation_id: string}
     */
    public function register(Actor $registrar, string $subjectPersonId, string $classificationId, string $title, string $contentHash, string $storageRef, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['documents.register', $subjectPersonId, $classificationId, $title, $contentHash, $registrar->actorId]));

        try {
            return $this->idempotency->execute('documents.register', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($registrar, $subjectPersonId, $classificationId, $title, $contentHash, $storageRef): array {
                    $outcome = $this->access->decide($registrar, self::CAPABILITY, null);
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('documents.register_denied', $outcome->reason);
                    }
                    if (! Person::query()->whereKey($subjectPersonId)->exists()) {
                        throw BusinessRejection::forCode('documents.subject_unknown', 'a document requires a known subject');
                    }
                    if (! DocumentClassification::query()->whereKey($classificationId)->exists()) {
                        throw BusinessRejection::forCode('documents.classification_unknown', 'a document requires a defined classification');
                    }
                    if ($contentHash === '' || $storageRef === '') {
                        throw BusinessRejection::forCode('documents.content_missing', 'a document version requires content hash and storage reference');
                    }

                    $document = Document::query()->create([
                        'id' => RandomIdentifier::new(),
                        'subject_person_id' => $subjectPersonId,
                        'classification_id' => $classificationId,
                        'title' => $title,
                        'lifecycle_state' => 'draft',
                    ]);
                    DocumentVersion::query()->create([
                        'id' => RandomIdentifier::new(),
                        'document_id' => $document->id,
                        'version_no' => 1,
                        'content_hash' => $contentHash,
                        'storage_ref' => $storageRef,
                        'uploaded_by' => $registrar->actorId,
                    ]);

                    $event = $this->audit->record($registrar->actorId, 'documents.register', 'document', $document->id, null, [
                        'subject_person_id' => $subjectPersonId,
                        'classification_id' => $classificationId,
                        'lifecycle_state' => 'draft',
                        'version_no' => 1,
                    ]);
                    $this->traceVisitor($registrar, $subjectPersonId, $document->id, $title);

                    return ['document_id' => $document->id, 'version_no' => 1, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $registrar, 'documents.register', 'document', $subjectPersonId);
        }
    }

    private function traceVisitor(Actor $actor, string $subjectPersonId, string $documentId, string $title): void
    {
        $visitorId = $this->crmTrace->visitorIdForPerson($subjectPersonId);
        if ($visitorId === null) {
            return;
        }
        $this->crmTrace->record(
            $actor,
            $visitorId,
            'inbound',
            'document',
            'other',
            sprintf('Document "%s" registered for the lead subject.', $title),
            CarbonImmutable::now(),
            documentId: $documentId,
        );
    }
}
