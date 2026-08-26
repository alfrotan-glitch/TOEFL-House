<?php

declare(strict_types=1);

namespace App\Modules\Resources\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Resources\Models\Asset;
use App\Modules\Resources\Models\AssetDisposal;
use App\Modules\Resources\Models\Custody;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Asset disposal (authority registry): the custodian/manager requests,
 * and disposal needs TWO distinct approvers (material-action rule, applied
 * fail-closed until a materiality threshold exists as configuration).
 * Disposal closes the open custody, flips the asset to disposed, and
 * leaves an immutable record.
 */
final class DisposeAsset
{
    public const CAPABILITY_REQUEST = 'resources.dispose_request';

    public const CAPABILITY_APPROVE = 'resources.dispose_approve';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{disposal_id: string, correlation_id: string} */
    public function dispose(Actor $requester, Actor $approverOne, Actor $approverTwo, Asset $asset, string $method, string $reason, string $disposedOn, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['resources.asset.dispose', $asset->id, $method, $reason, $disposedOn, $requester->actorId, $approverOne->actorId, $approverTwo->actorId]));

        try {
            return $this->idempotency->execute('resources.asset.dispose', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($requester, $approverOne, $approverTwo, $asset, $method, $reason, $disposedOn): array {
                    $this->require($requester, self::CAPABILITY_REQUEST);
                    $this->require($approverOne, self::CAPABILITY_APPROVE);
                    $this->require($approverTwo, self::CAPABILITY_APPROVE);
                    $actors = [$requester->actorId, $approverOne->actorId, $approverTwo->actorId];
                    if (count(array_unique($actors)) !== 3) {
                        throw AuthorizationDenied::forCode('resources.disposal_not_independent', 'disposal needs a requester and two distinct approvers');
                    }
                    if ($reason === '') {
                        throw BusinessRejection::forCode('resources.disposal_reason', 'a disposal requires a reason');
                    }
                    if (! in_array($method, ['sale', 'scrap', 'donation'], true)) {
                        throw BusinessRejection::forCode('resources.disposal_method', sprintf('unknown disposal method %s', $method));
                    }

                    /** @var Asset $locked */
                    $locked = Asset::query()->whereKey($asset->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state !== 'in_service') {
                        throw BusinessRejection::forCode('resources.asset_not_in_service', 'only an in-service asset can be disposed');
                    }
                    if (AssetDisposal::query()->where('asset_id', $locked->id)->exists()) {
                        throw BusinessRejection::forCode('resources.disposal_exists', 'this asset is already disposed');
                    }

                    /** @var Custody|null $open */
                    $open = Custody::query()->where('asset_id', $locked->id)->whereNull('released_on')->lockForUpdate()->first();
                    if ($open !== null) {
                        $open->forceFill(['released_on' => $disposedOn]);
                        $open->save();
                    }

                    $disposal = AssetDisposal::query()->create([
                        'id' => RandomIdentifier::new(),
                        'asset_id' => $locked->id,
                        'method' => $method,
                        'reason' => $reason,
                        'disposed_on' => $disposedOn,
                        'requested_by' => $requester->actorId,
                        'approver_one' => $approverOne->actorId,
                        'approver_two' => $approverTwo->actorId,
                    ]);
                    $locked->forceFill(['lifecycle_state' => 'disposed']);
                    $locked->save();
                    $event = $this->audit->record($requester->actorId, 'resources.asset.dispose', 'asset_disposal', $disposal->id, null, [
                        'asset_id' => $locked->id, 'method' => $method,
                    ]);

                    return ['disposal_id' => $disposal->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $requester, 'resources.asset.dispose', 'asset_disposal', $asset->id);
        }
    }

    private function require(Actor $actor, string $capability): void
    {
        $outcome = $this->access->decide($actor, $capability, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('resources.disposal_denied', $outcome->reason);
        }
    }
}
