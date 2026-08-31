<?php

declare(strict_types=1);

namespace App\Modules\Privacy\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Identity\Models\Person;
use App\Modules\Privacy\Models\Consent;
use App\Modules\Privacy\Models\Disclosure;
use App\Modules\Privacy\Models\PrivacyExportRequest;
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
 * row is the immutable evidence of the release.
 *
 * Organization-wide exports are STAGED (000114): an exporter session
 * requests, two distinct approver sessions each sign in their own
 * session, and only then may an exporter session execute. The two
 * signatures are never typed into one request.
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

    /** @return array{export_id: string, disclosure_id: string, dataset: array<string, mixed>, correlation_id: string} */
    public function export(Actor $exporter, string $subjectPersonId, string $purpose, string $scopeType, string $scopeId, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['privacy.export', $subjectPersonId, $purpose, $scopeType, $scopeId, $exporter->actorId]));

        try {
            return $this->idempotency->execute('privacy.export', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($exporter, $subjectPersonId, $purpose, $scopeType, $scopeId): array {
                    $this->requireCapability($exporter, self::CAPABILITY, 'privacy.export_denied');
                    if ($scopeType === 'organization') {
                        throw BusinessRejection::forCode('privacy.export_bulk_requires_request', 'organization-wide exports proceed only through the staged approval chain');
                    }
                    $this->requireSubjectAndPurpose($subjectPersonId, $purpose);

                    $dataset = $this->deriveDataset($subjectPersonId);

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

    /** @return array{request_id: string, correlation_id: string} */
    public function request(Actor $requester, string $subjectPersonId, string $purpose, string $organizationId, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['privacy.export.request', $subjectPersonId, $purpose, $organizationId, $requester->actorId]));

        try {
            return $this->idempotency->execute('privacy.export.request', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($requester, $subjectPersonId, $purpose, $organizationId): array {
                    $this->requireCapability($requester, self::CAPABILITY, 'privacy.export_denied');
                    $this->requireSubjectAndPurpose($subjectPersonId, $purpose);

                    $request = PrivacyExportRequest::query()->create([
                        'id' => RandomIdentifier::new(),
                        'subject_person_id' => $subjectPersonId,
                        'purpose' => $purpose,
                        'organization_id' => $organizationId,
                        'lifecycle_state' => 'requested',
                        'requested_by' => $requester->actorId,
                    ]);
                    $event = $this->audit->record($requester->actorId, 'privacy.export.request', 'privacy_export_request', $request->id, null, [
                        'subject_person_id' => $subjectPersonId,
                        'purpose' => $purpose,
                        'organization_id' => $organizationId,
                    ]);

                    return ['request_id' => $request->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $requester, 'privacy.export.request', 'privacy_export_request', $subjectPersonId);
        }
    }

    /** @return array{request_id: string, lifecycle_state: string, correlation_id: string} */
    public function approve(Actor $approver, PrivacyExportRequest $request, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['privacy.export.approve', $request->id, $approver->actorId]));

        try {
            return $this->idempotency->execute('privacy.export.approve', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($approver, $request): array {
                    $this->requireCapability($approver, self::CAPABILITY_BULK_APPROVE, 'privacy.bulk_export_approver_denied');

                    /** @var PrivacyExportRequest $locked */
                    $locked = PrivacyExportRequest::query()->whereKey($request->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state !== 'requested') {
                        throw BusinessRejection::forCode('privacy.export_request_state', sprintf('the request is already %s; approvals only count while it is requested', $locked->lifecycle_state));
                    }

                    if ($locked->approver_one_id === null) {
                        $locked->forceFill(['approver_one_id' => $approver->actorId]);
                        $state = 'requested';
                    } else {
                        if (trim((string) $locked->approver_one_id) === $approver->actorId) {
                            throw AuthorizationDenied::forCode('privacy.bulk_export_single_actor', 'organization-wide exports require two distinct approvers');
                        }
                        $locked->forceFill(['approver_two_id' => $approver->actorId, 'lifecycle_state' => 'approved']);
                        $state = 'approved';
                    }
                    $locked->save();

                    $event = $this->audit->record($approver->actorId, 'privacy.export.approve', 'privacy_export_request', $locked->id, null, [
                        'lifecycle_state' => $state,
                        'approver_one_id' => $locked->approver_one_id,
                        'approver_two_id' => $locked->approver_two_id,
                    ]);

                    return ['request_id' => $locked->id, 'lifecycle_state' => $state, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $approver, 'privacy.export.approve', 'privacy_export_request', $request->id);
        }
    }

    /** @return array{export_id: string, disclosure_id: string, dataset: array<string, mixed>, correlation_id: string} */
    public function execute(Actor $exporter, PrivacyExportRequest $request, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['privacy.export.execute', $request->id, $exporter->actorId]));

        try {
            return $this->idempotency->execute('privacy.export.execute', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($exporter, $request): array {
                    $this->requireCapability($exporter, self::CAPABILITY, 'privacy.export_denied');

                    /** @var PrivacyExportRequest $locked */
                    $locked = PrivacyExportRequest::query()->whereKey($request->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state !== 'approved') {
                        throw BusinessRejection::forCode('privacy.export_request_state', sprintf('the request must be approved before execution; it is %s', $locked->lifecycle_state));
                    }

                    $dataset = $this->deriveDataset($locked->subject_person_id);

                    $disclosure = Disclosure::query()->create([
                        'id' => RandomIdentifier::new(),
                        'subject_person_id' => $locked->subject_person_id,
                        'recipient' => 'data-export:'.$exporter->actorId,
                        'purpose' => $locked->purpose,
                        'authority' => self::CAPABILITY,
                        'scope_type' => 'organization',
                        'scope_id' => $locked->organization_id,
                        'disclosed_category' => 'subject-data-export',
                        'disclosed_by' => $exporter->actorId,
                    ]);

                    $locked->forceFill([
                        'lifecycle_state' => 'exported',
                        'exported_by' => $exporter->actorId,
                        'disclosure_id' => $disclosure->id,
                    ]);
                    $locked->save();

                    $event = $this->audit->record($exporter->actorId, 'privacy.export.execute', 'disclosure', $disclosure->id, null, [
                        'subject_person_id' => $locked->subject_person_id,
                        'purpose' => $locked->purpose,
                        'scope' => 'organization:'.$locked->organization_id,
                        'request_id' => $locked->id,
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
            $this->attemptedOperation->deniedByActor($denial, $exporter, 'privacy.export.execute', 'privacy_export_request', $request->id);
        }
    }

    /** @return array<string, mixed> */
    private function deriveDataset(string $subjectPersonId): array
    {
        /** @var Person $subject */
        $subject = Person::query()->findOrFail($subjectPersonId);

        return [
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
    }

    private function requireSubjectAndPurpose(string $subjectPersonId, string $purpose): void
    {
        if (! Person::query()->whereKey($subjectPersonId)->exists()) {
            throw BusinessRejection::forCode('privacy.export_subject_unknown', 'export requires a known subject');
        }
        if ($purpose === '') {
            throw BusinessRejection::forCode('privacy.export_purpose_missing', 'export requires a stated purpose');
        }
    }

    private function requireCapability(Actor $actor, string $capability, string $denialCode): void
    {
        $outcome = $this->access->decide($actor, $capability, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode($denialCode, $outcome->reason);
        }
    }
}
