<?php

declare(strict_types=1);

namespace App\Modules\Resources\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Resources\Models\Asset;
use App\Modules\Resources\Models\Custody;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Assets and custody: catalog entries with unique codes; one open custody
 * per asset; transfer closes the prior custody row (history retained) and
 * disposal closes custody (handled by the disposal command).
 */
final class MaintainAsset
{
    public const CAPABILITY = 'resources.asset';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{asset_id: string, correlation_id: string} */
    public function register(Actor $actor, string $code, string $name, string $category, string $location, string $acquiredOn, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['resources.asset.register', $code, $name, $category, $location, $acquiredOn, $actor->actorId]));

        try {
            return $this->idempotency->execute('resources.asset.register', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $code, $name, $category, $location, $acquiredOn): array {
                    $this->require($actor);
                    if (Asset::query()->where('code', $code)->exists()) {
                        throw BusinessRejection::forCode('resources.asset_code_exists', 'this asset code already exists');
                    }

                    $asset = Asset::query()->create([
                        'id' => RandomIdentifier::new(),
                        'code' => $code,
                        'name' => $name,
                        'category' => $category,
                        'location' => $location,
                        'acquired_on' => $acquiredOn,
                        'lifecycle_state' => 'in_service',
                    ]);
                    $event = $this->audit->record($actor->actorId, 'resources.asset.register', 'asset', $asset->id, null, ['code' => $code]);

                    return ['asset_id' => $asset->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'resources.asset.register', 'asset', $code);
        }
    }

    /** @return array{custody_id: string, correlation_id: string} */
    public function assignCustody(Actor $actor, Asset $asset, string $custodianPersonId, string $assignedOn, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['resources.custody.assign', $asset->id, $custodianPersonId, $assignedOn, $actor->actorId]));

        try {
            return $this->idempotency->execute('resources.custody.assign', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $asset, $custodianPersonId, $assignedOn): array {
                    $this->require($actor);

                    /** @var Asset $locked */
                    $locked = Asset::query()->whereKey($asset->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state !== 'in_service') {
                        throw BusinessRejection::forCode('resources.asset_not_in_service', 'custody attaches only to an in-service asset');
                    }

                    /** @var Custody|null $open */
                    $open = Custody::query()->where('asset_id', $locked->id)->whereNull('released_on')->lockForUpdate()->first();
                    if ($open !== null) {
                        if (trim((string) $open->custodian_person_id) === $custodianPersonId) {
                            throw BusinessRejection::forCode('resources.custody_same_custodian', 'this custodian already holds the asset');
                        }
                        $open->forceFill(['released_on' => $assignedOn]);
                        $open->save();
                    }

                    $custody = Custody::query()->create([
                        'id' => RandomIdentifier::new(),
                        'asset_id' => $locked->id,
                        'custodian_person_id' => $custodianPersonId,
                        'assigned_on' => $assignedOn,
                        'assigned_by' => $actor->actorId,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'resources.custody.assign', 'custody', $custody->id, null, [
                        'asset_id' => $locked->id, 'custodian' => $custodianPersonId,
                    ]);

                    return ['custody_id' => $custody->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'resources.custody.assign', 'custody', $asset->id);
        }
    }

    /** @return array{custody_id: string, correlation_id: string} */
    public function releaseCustody(Actor $actor, Asset $asset, string $releasedOn, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['resources.custody.release', $asset->id, $releasedOn, $actor->actorId]));

        try {
            return $this->idempotency->execute('resources.custody.release', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $asset, $releasedOn): array {
                    $this->require($actor);

                    /** @var Custody $open */
                    $open = Custody::query()->where('asset_id', $asset->id)->whereNull('released_on')->lockForUpdate()->firstOrFail();
                    $open->forceFill(['released_on' => $releasedOn]);
                    $open->save();
                    $event = $this->audit->record($actor->actorId, 'resources.custody.release', 'custody', $open->id, null, ['asset_id' => $asset->id]);

                    return ['custody_id' => $open->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'resources.custody.release', 'custody', $asset->id);
        }
    }

    private function require(Actor $actor): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('resources.asset_denied', $outcome->reason);
        }
    }
}
