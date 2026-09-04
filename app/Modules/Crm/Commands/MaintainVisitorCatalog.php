<?php

declare(strict_types=1);

namespace App\Modules\Crm\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Crm\Domain\CrmAccess;
use App\Modules\Crm\Models\VisitorCampaign;
use App\Modules\Crm\Models\VisitorSource;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * CRM acquisition catalog: sources and campaigns. This is metadata only —
 * never money and never a parallel authority. Adding a source/campaign is
 * audited and idempotent; retiring closes it so historical attribution stays
 * intact (it is never rewritten or deleted).
 */
final class MaintainVisitorCatalog
{
    public const CAPABILITY = 'crm.catalog';

    public function __construct(
        private readonly CrmAccess $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{source_id: string, correlation_id: string} */
    public function defineSource(Actor $actor, string $key, string $name, ?string $category, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', [
            'crm.source.define', strtolower(trim($key)), trim($name), $category ?? '', $actor->actorId,
        ]));

        try {
            return $this->idempotency->execute('crm.source.define', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $key, $name, $category): array {
                    $this->access->require($actor, self::CAPABILITY, null, 'crm.catalog_denied');
                    $normalizedKey = strtolower(trim($key));
                    if ($normalizedKey === '' || trim($name) === '') {
                        throw BusinessRejection::forCode('crm.catalog_required', 'a source requires a key and a name');
                    }
                    if (VisitorSource::query()->where('key', $normalizedKey)->exists()) {
                        throw BusinessRejection::forCode('crm.source_key_exists', 'a source with this key already exists');
                    }

                    $source = VisitorSource::query()->create([
                        'id' => RandomIdentifier::new(),
                        'key' => $normalizedKey,
                        'name' => trim($name),
                        'category' => $category !== null && $category !== '' ? trim($category) : null,
                        'lifecycle_state' => VisitorSource::STATE_ACTIVE,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'crm.source.define', 'visitor_source', $source->id, null, [
                        'key' => $normalizedKey, 'name' => $source->name, 'category' => $source->category,
                    ]);

                    return ['source_id' => $source->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'crm.source.define', 'visitor_source', $key);
        }
    }

    /** @return array{source_id: string, lifecycle_state: string, correlation_id: string} */
    public function retireSource(Actor $actor, VisitorSource $source, string $idempotencyKey): array
    {
        return $this->transitionSource($actor, $source, VisitorSource::STATE_RETIRED, $idempotencyKey);
    }

    /** @return array{source_id: string, lifecycle_state: string, correlation_id: string} */
    private function transitionSource(Actor $actor, VisitorSource $source, string $toState, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['crm.source.transition', $source->id, $toState, $actor->actorId]));

        try {
            return $this->idempotency->execute('crm.source.transition', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $source, $toState): array {
                    $this->access->require($actor, self::CAPABILITY, null, 'crm.catalog_denied');
                    /** @var VisitorSource $locked */
                    $locked = VisitorSource::query()->whereKey($source->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state === $toState) {
                        throw BusinessRejection::forCode('crm.catalog_no_change', sprintf('source is already %s', $toState));
                    }

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => $toState]);
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'crm.source.transition', 'visitor_source', $locked->id, $before, [
                        'lifecycle_state' => $toState,
                    ]);

                    return ['source_id' => $locked->id, 'lifecycle_state' => $toState, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'crm.source.transition', 'visitor_source', $source->id);
        }
    }

    /** @return array{campaign_id: string, correlation_id: string} */
    public function defineCampaign(
        Actor $actor,
        string $key,
        string $name,
        ?string $sourceId,
        string $channel,
        CarbonImmutable $startsOn,
        ?CarbonImmutable $endsOn,
        string $idempotencyKey,
    ): array {
        $payload = hash('sha256', implode('|', [
            'crm.campaign.define', strtolower(trim($key)), trim($name), $sourceId ?? '', $channel,
            $startsOn->toDateString(), $endsOn?->toDateString() ?? '', $actor->actorId,
        ]));

        try {
            return $this->idempotency->execute('crm.campaign.define', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $key, $name, $sourceId, $channel, $startsOn, $endsOn): array {
                    $this->access->require($actor, self::CAPABILITY, null, 'crm.catalog_denied');
                    $normalizedKey = strtolower(trim($key));
                    if ($normalizedKey === '' || trim($name) === '') {
                        throw BusinessRejection::forCode('crm.catalog_required', 'a campaign requires a key and a name');
                    }
                    if (in_array($channel, ['walk_in', 'phone', 'whatsapp', 'email', 'social', 'website', 'referral', 'event', 'other'], true) === false) {
                        throw BusinessRejection::forCode('crm.campaign_channel_unknown', 'unknown campaign channel');
                    }
                    if ($endsOn !== null && $endsOn->toDateString() < $startsOn->toDateString()) {
                        throw BusinessRejection::forCode('crm.campaign_window', 'a campaign must end on or after it starts');
                    }
                    if (VisitorCampaign::query()->where('key', $normalizedKey)->exists()) {
                        throw BusinessRejection::forCode('crm.campaign_key_exists', 'a campaign with this key already exists');
                    }
                    if ($sourceId !== null && $sourceId !== '' && VisitorSource::query()->whereKey($sourceId)->where('lifecycle_state', VisitorSource::STATE_ACTIVE)->doesntExist()) {
                        throw BusinessRejection::forCode('crm.campaign_source_not_active', 'a campaign can only reference an active source');
                    }

                    $campaign = VisitorCampaign::query()->create([
                        'id' => RandomIdentifier::new(),
                        'key' => $normalizedKey,
                        'name' => trim($name),
                        'source_id' => $sourceId !== '' ? $sourceId : null,
                        'channel' => $channel,
                        'starts_on' => $startsOn->toDateString(),
                        'ends_on' => $endsOn?->toDateString(),
                        'lifecycle_state' => VisitorCampaign::STATE_ACTIVE,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'crm.campaign.define', 'visitor_campaign', $campaign->id, null, [
                        'key' => $normalizedKey, 'name' => $campaign->name, 'source_id' => $campaign->source_id, 'channel' => $channel,
                        'starts_on' => $campaign->starts_on, 'ends_on' => $campaign->ends_on,
                    ]);

                    return ['campaign_id' => $campaign->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'crm.campaign.define', 'visitor_campaign', $key);
        }
    }

    /** @return array{campaign_id: string, lifecycle_state: string, correlation_id: string} */
    public function retireCampaign(Actor $actor, VisitorCampaign $campaign, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['crm.campaign.transition', $campaign->id, VisitorCampaign::STATE_RETIRED, $actor->actorId]));

        try {
            return $this->idempotency->execute('crm.campaign.transition', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $campaign): array {
                    $this->access->require($actor, self::CAPABILITY, null, 'crm.catalog_denied');
                    /** @var VisitorCampaign $locked */
                    $locked = VisitorCampaign::query()->whereKey($campaign->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state === VisitorCampaign::STATE_RETIRED) {
                        throw BusinessRejection::forCode('crm.catalog_no_change', 'campaign is already retired');
                    }

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => VisitorCampaign::STATE_RETIRED]);
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'crm.campaign.transition', 'visitor_campaign', $locked->id, $before, [
                        'lifecycle_state' => VisitorCampaign::STATE_RETIRED,
                    ]);

                    return ['campaign_id' => $locked->id, 'lifecycle_state' => VisitorCampaign::STATE_RETIRED, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'crm.campaign.transition', 'visitor_campaign', $campaign->id);
        }
    }
}
