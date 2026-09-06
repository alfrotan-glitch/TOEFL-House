<?php

declare(strict_types=1);

namespace App\Modules\Crm\Domain;

use App\Modules\Admissions\Models\Applicant;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Crm\Models\Visitor;
use App\Modules\Crm\Models\VisitorConversion;
use App\Modules\Students\Models\Student;
use App\Support\Authorization\Actor;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Cross-module conversion lineage recorder. The AUTHORIZING workflow is
 * always the caller — Admissions/Students owns the conversion, and this
 * recorder only persists the CRM trace, status, and audit inside the same
 * transaction. It deliberately performs no separate capability decision so
 * that an Admissions conversion can never be split into a "successful
 * student, unlinked visitor" outcome when the actor happens to lack a CRM
 * flag; the public CRM command path wraps it with the CRM capability gate.
 */
final class VisitorConversionRecorder
{
    public function __construct(
        private readonly AuditRecorder $audit,
        private readonly IdempotentExecution $idempotency,
    ) {}

    /** @return array{conversion_id: string, visitor_id: string, status: string, correlation_id: string} */
    public function record(
        Actor $actor,
        Visitor $visitor,
        string $conversionType,
        string $downstreamEntity,
        string $downstreamId,
        string $idempotencyKey,
    ): array {
        $payload = hash('sha256', implode('|', [
            'crm.conversion.record', $visitor->id, $conversionType, $downstreamEntity, $downstreamId, $actor->actorId,
        ]));

        return $this->idempotency->execute('crm.conversion.record', $idempotencyKey, $payload,
            fn (): array => DB::transaction(function () use ($actor, $visitor, $conversionType, $downstreamEntity, $downstreamId): array {
                // Deduplicate: if the exact conversion already exists, the
                // idempotency map normally catches a repeat; the unique
                // visitor conversion is the hard truth either way.
                /** @var Visitor $locked */
                $locked = Visitor::query()->whereKey($visitor->id)->lockForUpdate()->firstOrFail();

                if (in_array($conversionType, ['applicant', 'student', 'enquiry'], true) === false) {
                    throw BusinessRejection::forCode('crm.conversion_type', 'unknown conversion type');
                }
                if (VisitorConversion::query()->where('visitor_id', $locked->id)->exists()) {
                    throw BusinessRejection::forCode('crm.conversion_exists', 'this visitor already has a conversion record');
                }
                if (! $locked->isOpen()) {
                    throw BusinessRejection::forCode('crm.conversion_visitor_closed', 'only an open visitor can be converted');
                }

                [$personId, $applicantId, $studentId] = $this->resolveDownstream($conversionType, $downstreamEntity, $downstreamId);
                $this->bindPerson($locked, $personId);

                $conversion = VisitorConversion::query()->create([
                    'id' => RandomIdentifier::new(),
                    'visitor_id' => $locked->id,
                    'conversion_type' => $conversionType,
                    'person_id' => $personId,
                    'applicant_id' => $applicantId,
                    'student_id' => $studentId,
                    'converted_by' => $actor->actorId,
                    'converted_at' => now()->toDateTimeString(),
                    'correlation_id' => RandomIdentifier::new(),
                ]);

                $before = ['status' => $locked->status];
                VisitorStatus::requireTransition($locked->status, Visitor::STATUS_CONVERTED);
                $locked->forceFill(['status' => Visitor::STATUS_CONVERTED]);
                $locked->save();

                $event = $this->audit->record($actor->actorId, 'crm.conversion.record', 'visitor_conversion', $conversion->id, null, [
                    'visitor_id' => $locked->id, 'conversion_type' => $conversionType,
                    'person_id' => $personId, 'applicant_id' => $applicantId, 'student_id' => $studentId,
                    'prev_status' => $before['status'], 'status' => Visitor::STATUS_CONVERTED,
                    'downstream_entity' => $downstreamEntity, 'downstream_id' => $downstreamId,
                ]);

                return ['conversion_id' => $conversion->id, 'visitor_id' => $locked->id, 'status' => Visitor::STATUS_CONVERTED, 'correlation_id' => $event->correlation_id];
            }),
        );
    }

    /** @return array{?string, ?string, ?string} */
    private function resolveDownstream(string $conversionType, string $downstreamEntity, string $downstreamId): array
    {
        if ($conversionType === 'enquiry') {
            if ($downstreamEntity !== 'enquiry') {
                throw BusinessRejection::forCode('crm.conversion_downstream', 'an enquiry conversion must reference an enquiry');
            }

            return [null, null, null];
        }

        if ($conversionType === 'applicant') {
            if ($downstreamEntity !== 'applicant') {
                throw BusinessRejection::forCode('crm.conversion_downstream', 'an applicant conversion must reference an applicant');
            }
            /** @var Applicant|null $applicant */
            $applicant = Applicant::query()->find($downstreamId);
            if ($applicant === null) {
                throw BusinessRejection::forCode('crm.downstream_missing', 'the applicant does not exist');
            }

            return [$applicant->person_id, $applicant->id, null];
        }

        if ($conversionType === 'student') {
            if ($downstreamEntity !== 'student') {
                throw BusinessRejection::forCode('crm.conversion_downstream', 'a student conversion must reference a student');
            }
            /** @var Student|null $student */
            $student = Student::query()->find($downstreamId);
            if ($student === null) {
                throw BusinessRejection::forCode('crm.downstream_missing', 'the student does not exist');
            }

            return [$student->person_id, null, $student->id];
        }

        throw BusinessRejection::forCode('crm.conversion_type', 'unknown conversion type');
    }

    private function bindPerson(Visitor &$visitor, ?string $personId): void
    {
        if ($personId === null) {
            return;
        }
        if ($visitor->person_id !== null && $visitor->person_id !== $personId) {
            throw BusinessRejection::forCode('crm.conversion_person_mismatch', 'the converted record belongs to a different person than the visitor');
        }
        if ($visitor->person_id === null) {
            $visitor->forceFill(['person_id' => $personId])->save();
        }
    }
}
