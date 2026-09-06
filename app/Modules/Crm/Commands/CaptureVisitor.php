<?php

declare(strict_types=1);

namespace App\Modules\Crm\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Crm\Domain\CrmAccess;
use App\Modules\Crm\Domain\VisitorContactKey;
use App\Modules\Crm\Models\Visitor;
use App\Modules\Crm\Models\VisitorCampaign;
use App\Modules\Crm\Models\VisitorSource;
use App\Modules\Identity\Models\Person;
use App\Modules\Organization\Models\Branch;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;

/**
 * Capture a visitor/lead. The lead may be anonymous (person_id NULL) or
 * identity-attached; it always records at least one contact channel so the
 * anti-duplicate controls can bind to reality. Branch provenance is captured
 * only when known — it is never fabricated, and once set it is immutable.
 */
final class CaptureVisitor
{
    public const CAPABILITY = 'crm.visitor';

    public function __construct(
        private readonly CrmAccess $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{visitor_id: string, visitor_code: string, status: string, correlation_id: string} */
    public function capture(
        Actor $actor,
        ?string $personId,
        string $fullName,
        ?string $phone,
        ?string $email,
        string $preferredChannel,
        string $visitorType,
        ?string $sourceId,
        ?string $campaignId,
        ?string $originBranchId,
        ?string $interest,
        ?string $notes,
        string $idempotencyKey,
    ): array {
        $payload = hash('sha256', implode('|', [
            'crm.visitor.capture', $personId ?? '', trim($fullName), $phone ?? '', strtolower(trim($email ?? '')),
            $preferredChannel, $visitorType, $sourceId ?? '', $campaignId ?? '', $originBranchId ?? '',
            $interest ?? '', $actor->actorId,
        ]));

        try {
            return $this->idempotency->execute('crm.visitor.capture', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $personId, $fullName, $phone, $email, $preferredChannel, $visitorType, $sourceId, $campaignId, $originBranchId, $interest, $notes): array {
                    $this->access->require($actor, self::CAPABILITY, $originBranchId, 'crm.visitor_capture_denied');
                    if (in_array($preferredChannel, ['phone', 'whatsapp', 'email', 'sms', 'in_person', 'other'], true) === false) {
                        throw BusinessRejection::forCode('crm.visitor_channel_unknown', 'unknown preferred contact channel');
                    }
                    if (in_array($visitorType, ['walk_in', 'online', 'phone', 'whatsapp', 'referral', 'admissions_event', 'social', 'other'], true) === false) {
                        throw BusinessRejection::forCode('crm.visitor_type_unknown', 'unknown visitor type');
                    }

                    $normalizedPersonId = trim((string) ($personId ?? ''));
                    if ($normalizedPersonId !== '') {
                        /** @var Person|null $person */
                        $person = Person::query()->whereKey($normalizedPersonId)->first();
                        if ($person === null) {
                            throw BusinessRejection::forCode('crm.person_unknown', 'the supplied person does not exist');
                        }
                        if (! $person->isVerified()) {
                            throw BusinessRejection::forCode('crm.person_unverified', 'a supplied visitor identity must be verified');
                        }
                    }
                    $personId = $normalizedPersonId === '' ? null : $normalizedPersonId;
                    $resolvedName = $this->resolveName($personId, $fullName);
                    if (mb_strlen($resolvedName) > 255 || ($phone !== null && mb_strlen($phone) > 255) || ($email !== null && mb_strlen($email) > 255)
                        || ($interest !== null && mb_strlen($interest) > 255) || ($notes !== null && mb_strlen($notes) > 2000)) {
                        throw BusinessRejection::forCode('crm.visitor_field_length', 'visitor fields exceed their permitted lengths');
                    }
                    $contactKey = VisitorContactKey::of($email, $phone);
                    if ($contactKey === '' && $personId === null) {
                        throw BusinessRejection::forCode('crm.visitor_contact_required', 'a visitor needs at least a phone, email, or verified identity');
                    }

                    $resolvedSource = $this->resolveSource($sourceId);
                    $resolvedCampaign = $this->resolveCampaign($campaignId, $resolvedSource?->id);
                    // A campaign attributes its source when the capture did not
                    // name one explicitly — attribution is never left ambiguous.
                    if ($resolvedSource === null && $resolvedCampaign !== null && $resolvedCampaign->source_id !== null) {
                        $resolvedSource = $this->resolveSource($resolvedCampaign->source_id);
                    }

                    if ($personId !== null && Visitor::query()
                        ->where('person_id', $personId)
                        ->whereIn('status', Visitor::openStatuses())
                        ->exists()) {
                        throw BusinessRejection::forCode('crm.duplicate_person', 'this person already has an open visitor record');
                    }
                    if ($contactKey !== '' && Visitor::query()
                        ->where('contact_key', $contactKey)
                        ->whereIn('status', Visitor::openStatuses())
                        ->exists()) {
                        throw BusinessRejection::forCode('crm.duplicate_contact', 'an open visitor already exists for this primary contact');
                    }

                    $visitor = Visitor::query()->create([
                        'id' => RandomIdentifier::new(),
                        'visitor_code' => self::visitorCode(),
                        'person_id' => $personId,
                        'source_id' => $resolvedSource?->id,
                        'campaign_id' => $resolvedCampaign?->id,
                        'full_name' => $resolvedName,
                        'phone' => $phone !== '' ? $phone : null,
                        'email' => $email !== '' ? $email : null,
                        'preferred_channel' => $preferredChannel,
                        'visitor_type' => $visitorType,
                        'status' => Visitor::STATUS_NEW,
                        'rating' => null,
                        'interest' => $interest !== '' ? $interest : null,
                        'notes' => $notes !== '' ? $notes : null,
                        'assigned_to' => $actor->actorId,
                        'origin_branch_id' => $originBranchId !== '' ? $originBranchId : null,
                        'created_by' => $actor->actorId,
                    ]);

                    $provenance = $this->visitorProvenance($visitor->origin_branch_id);
                    $event = $this->audit->record($actor->actorId, 'crm.visitor.capture', 'visitor', $visitor->id, null, [
                        'visitor_code' => $visitor->visitor_code, 'person_id' => $visitor->person_id, 'source_id' => $visitor->source_id,
                        'campaign_id' => $visitor->campaign_id, 'full_name' => $visitor->full_name, 'status' => Visitor::STATUS_NEW,
                        'origin_branch_id' => $visitor->origin_branch_id, 'contact_key' => $visitor->contact_key,
                        ...$provenance,
                    ]);

                    return ['visitor_id' => $visitor->id, 'visitor_code' => $visitor->visitor_code, 'status' => Visitor::STATUS_NEW, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'crm.visitor.capture', 'visitor', substr((string) ($personId ?? 'anonymous'), 0, 36));
        } catch (QueryException $exception) {
            if (str_contains($exception->getMessage(), 'visitors_one_active_per_person')) {
                throw BusinessRejection::forCode('crm.duplicate_person', 'this person already has an open visitor record');
            }
            if (str_contains($exception->getMessage(), 'visitors_one_active_per_contact')) {
                throw BusinessRejection::forCode('crm.duplicate_contact', 'an open visitor already exists for this primary contact');
            }
            throw $exception;
        }
    }

    /** @return array{branch_id?: string, organization_id?: string} */
    private function visitorProvenance(?string $originBranchId): array
    {
        $branchId = trim((string) ($originBranchId ?? ''));
        if ($branchId === '') {
            return [];
        }
        $branch = Branch::query()->whereKey($branchId)->first();
        if ($branch === null || $branch->lifecycle_state !== 'active') {
            throw BusinessRejection::forCode('crm.visitor_branch_inactive', 'visitor branch provenance must reference an active branch');
        }
        $topology = DB::table('branches as b')
            ->join('campus_assignments as ca', 'ca.branch_id', '=', 'b.id')
            ->join('campuses as c', 'c.id', '=', 'ca.campus_id')
            ->join('organizations as o', 'o.id', '=', 'c.organization_id')
            ->where('b.id', $branch->id)
            ->where('b.lifecycle_state', 'active')
            ->where('c.lifecycle_state', 'active')
            ->where('o.lifecycle_state', 'active')
            ->where('ca.effective_from', '<=', now()->toDateString())
            ->where(fn ($query) => $query->whereNull('ca.effective_to')->orWhere('ca.effective_to', '>', now()->toDateString()))
            ->first(['b.id as branch_id', 'c.organization_id']);
        if ($topology === null) {
            throw BusinessRejection::forCode('crm.visitor_organization_missing', 'visitor branch provenance requires an active campus organization');
        }

        return ['branch_id' => (string) $topology->branch_id, 'organization_id' => (string) $topology->organization_id];
    }

    private function resolveName(?string $personId, string $fullName): string
    {
        if (trim($fullName) !== '') {
            return trim($fullName);
        }
        if ($personId !== null && $personId !== '') {
            $name = Person::query()->whereKey($personId)->value('legal_name');
            if ($name !== null && trim((string) $name) !== '') {
                return trim((string) $name);
            }
        }
        throw BusinessRejection::forCode('crm.visitor_name_required', 'a visitor record requires a name');
    }

    private function resolveSource(?string $sourceId): ?VisitorSource
    {
        if ($sourceId === null || $sourceId === '') {
            return null;
        }
        /** @var VisitorSource|null $source */
        $source = VisitorSource::query()->where('lifecycle_state', VisitorSource::STATE_ACTIVE)->find($sourceId);
        if ($source === null) {
            throw BusinessRejection::forCode('crm.source_not_active', 'a visitor can only reference an active source');
        }

        return $source;
    }

    private function resolveCampaign(?string $campaignId, ?string $sourceId): ?VisitorCampaign
    {
        if ($campaignId === null || $campaignId === '') {
            return null;
        }
        /** @var VisitorCampaign|null $campaign */
        $campaign = VisitorCampaign::query()->where('lifecycle_state', VisitorCampaign::STATE_ACTIVE)->find($campaignId);
        if ($campaign === null) {
            throw BusinessRejection::forCode('crm.campaign_not_active', 'a visitor can only reference an active campaign');
        }
        if ($sourceId !== null && $campaign->source_id !== null && $campaign->source_id !== $sourceId) {
            throw BusinessRejection::forCode('crm.campaign_source_mismatch', 'the campaign belongs to a different source');
        }
        $today = CarbonImmutable::today()->toDateString();
        if ($campaign->starts_on > $today || ($campaign->ends_on !== null && $campaign->ends_on < $today)) {
            throw BusinessRejection::forCode('crm.campaign_window_inactive', 'a visitor can only reference a campaign active on the capture date');
        }

        return $campaign;
    }

    private static function visitorCode(): string
    {
        return 'VIS-'.strtoupper(substr(bin2hex(random_bytes(5)), 0, 9));
    }
}
