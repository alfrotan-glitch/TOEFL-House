<?php

declare(strict_types=1);

namespace App\Modules\Privacy\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Identity\Models\Person;
use App\Modules\Privacy\Models\Consent;
use App\Modules\Privacy\Models\Disclosure;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * Subject data export: purpose-based authorization, minimum disclosure,
 * and audit. The export descriptor is derived read-only; the disclosure
 * row is the immutable evidence of the release. Bulk exports covering the
 * whole organization require two distinct eligible approvers.
 */
final class ExportSubjectData
{
    public const CAPABILITY = 'privacy.export';

    public const CAPABILITY_BULK_APPROVE = 'privacy.approve_bulk_export';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /**
     * @param  list<Actor>  $bulkApprovers
     * @return array{export_id: string, disclosure_id: string, dataset: array<string, mixed>, correlation_id: string}
     */
    public function export(Actor $exporter, string $subjectPersonId, string $purpose, string $scopeType, string $scopeId, array $bulkApprovers, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['privacy.export', $subjectPersonId, $purpose, $scopeType, $scopeId, $exporter->actorId]));

        try {
            return $this->idempotency->execute('privacy.export', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($exporter, $subjectPersonId, $purpose, $scopeType, $scopeId, $bulkApprovers): array {
                    $outcome = $this->access->decide($exporter, self::CAPABILITY, null);
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('privacy.export_denied', $outcome->reason);
                    }
                    $subject = Person::query()->find($subjectPersonId);
                    if ($subject === null) {
                        throw BusinessRejection::forCode('privacy.export_subject_unknown', 'export requires a known subject');
                    }
                    if ($purpose === '') {
                        throw BusinessRejection::forCode('privacy.export_purpose_missing', 'export requires a stated purpose');
                    }
                    if ($scopeType === 'organization') {
                        $this->requireTwoDistinctBulkApprovers($bulkApprovers, $scopeId);
                    }

                    $dataset = [
                        'subject' => ['person_id' => $subjectPersonId, 'legal_name' => $subject->legal_name],
                        'consents' => Consent::query()->where('subject_person_id', $subjectPersonId)
                            ->get(['id', 'purpose_id', 'lifecycle_state', 'effective_from', 'effective_to'])
                            ->map(static fn (Consent $consent): array => [
                                'consent_id' => trim((string) $consent->id),
                                'purpose_id' => trim((string) $consent->purpose_id),
                                'lifecycle_state' => $consent->lifecycle_state,
                                'effective_from' => $consent->effective_from,
                                'effective_to' => $consent->effective_to,
                            ])->all(),
                        'disclosures' => Disclosure::query()->where('subject_person_id', $subjectPersonId)
                            ->get(['id', 'recipient', 'purpose', 'disclosed_category', 'created_at'])
                            ->map(static fn (Disclosure $disclosure): array => [
                                'disclosure_id' => trim((string) $disclosure->id),
                                'recipient' => $disclosure->recipient,
                                'purpose' => $disclosure->purpose,
                                'disclosed_category' => $disclosure->disclosed_category,
                                'at' => $disclosure->created_at?->toDateTimeString(),
                            ])->all(),
                    ];

                    $disclosure = Disclosure::query()->create([
                        'id' => RandomIdentifier::new(),
                        'subject_person_id' => $subjectPersonId,
                        'recipient' => 'data-export:'.$exporter->actorId,
                        'purpose' => $purpose,
                        'authority' => self::CAPABILITY,
                        'scope_type' => $scopeType,
                        'scope_id' => $scopeId,
                        'disclosed_category' => 'subject-data-export',
                        'disclosed_by' => $exporter->actorId,
                    ]);

                    $event = $this->audit->record($exporter->actorId, 'privacy.export', 'disclosure', $disclosure->id, null, [
                        'subject_person_id' => $subjectPersonId,
                        'purpose' => $purpose,
                        'scope' => $scopeType.':'.$scopeId,
                        'as_of' => (new CarbonImmutable)->toDateString(),
                    ]);

                    return [
                        'export_id' => RandomIdentifier::new(),
                        'disclosure_id' => $disclosure->id,
                        'dataset' => $dataset,
                        'correlation_id' => $event->correlation_id,
                    ];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $exporter, 'privacy.export', 'disclosure', $subjectPersonId);
        }
    }

    /**
     * @param  list<Actor>  $approvers
     */
    private function requireTwoDistinctBulkApprovers(array $approvers, string $organizationId): void
    {
        if (count($approvers) < 2) {
            throw AuthorizationDenied::forCode('privacy.bulk_export_owner_count', 'two distinct owner approvals required for organization-wide exports');
        }
        $seen = [];
        foreach ($approvers as $approver) {
            if (in_array($approver->actorId, $seen, true)) {
                throw AuthorizationDenied::forCode('privacy.bulk_export_single_actor', 'organization-wide exports require two distinct approvers');
            }
            $seen[] = $approver->actorId;
            $outcome = $this->access->decide($approver, self::CAPABILITY_BULK_APPROVE, null);
            if (! $outcome->allowed) {
                throw AuthorizationDenied::forCode('privacy.bulk_export_approver_denied', $outcome->reason);
            }
        }
    }
}
