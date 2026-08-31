<?php

declare(strict_types=1);

namespace App\Modules\Resources\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Resources\Models\Asset;
use App\Modules\Resources\Models\AssetDisposal;
use App\Modules\Resources\Models\AssetDisposalRequest;
use App\Modules\Resources\Models\Custody;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Asset disposal (authority registry), staged (000115): the custodian/
 * manager session requests, two DISTINCT approver sessions each sign in
 * their own session (material-action rule, applied fail-closed until a
 * materiality threshold exists as configuration), and the requesting
 * session executes. The two signatures are never typed into one request.
 *
 * Execution closes the open custody, flips the asset to disposed, and
 * leaves an immutable asset_disposal record.
 */
final class DisposeAsset
{
    public const CAPABILITY_REQUEST = 'resources.dispose_request';

    public const CAPABILITY_APPROVE = 'resources.dispose_approve';

    public const METHODS = ['sale', 'scrap', 'donation'];

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{request_id: string, correlation_id: string} */
    public function request(Actor $requester, Asset $asset, string $method, string $reason, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['resources.disposal.request', $asset->id, $method, $reason, $requester->actorId]));

        try {
            return $this->idempotency->execute('resources.disposal.request', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($requester, $asset, $method, $reason): array {
                    $this->require($requester, self::CAPABILITY_REQUEST);
                    if (! in_array($method, self::METHODS, true)) {
                        throw BusinessRejection::forCode('resources.disposal_method', sprintf('unknown disposal method %s', $method));
                    }
                    if (trim($reason) === '') {
                        throw BusinessRejection::forCode('resources.disposal_reason', 'a disposal requires a reason');
                    }

                    /** @var Asset $locked */
                    $locked = Asset::query()->whereKey($asset->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state !== 'in_service') {
                        throw BusinessRejection::forCode('resources.asset_not_in_service', 'only an in-service asset can be disposed');
                    }
                    if (AssetDisposal::query()->where('asset_id', $locked->id)->exists()) {
                        throw BusinessRejection::forCode('resources.disposal_exists', 'this asset is already disposed');
                    }
                    $pending = AssetDisposalRequest::query()->where('asset_id', $locked->id)->where('lifecycle_state', '!=', 'completed')->exists();
                    if ($pending) {
                        throw BusinessRejection::forCode('resources.disposal_pending', 'this asset already has a disposal request in progress');
                    }

                    $request = AssetDisposalRequest::query()->create([
                        'id' => RandomIdentifier::new(),
                        'asset_id' => $locked->id,
                        'method' => $method,
                        'reason' => $reason,
                        'lifecycle_state' => 'requested',
                        'requested_by' => $requester->actorId,
                    ]);
                    $event = $this->audit->record($requester->actorId, 'resources.disposal.request', 'asset_disposal_request', $request->id, null, [
                        'asset_id' => $locked->id, 'method' => $method,
                    ]);

                    return ['request_id' => $request->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $requester, 'resources.disposal.request', 'asset_disposal_request', $asset->id);
        }
    }

    /** @return array{request_id: string, lifecycle_state: string, correlation_id: string} */
    public function approve(Actor $approver, AssetDisposalRequest $request, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['resources.disposal.approve', $request->id, $approver->actorId]));

        try {
            return $this->idempotency->execute('resources.disposal.approve', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($approver, $request): array {
                    $this->require($approver, self::CAPABILITY_APPROVE);

                    /** @var AssetDisposalRequest $locked */
                    $locked = AssetDisposalRequest::query()->whereKey($request->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state !== 'requested') {
                        throw BusinessRejection::forCode('resources.disposal_request_state', sprintf('the request is already %s; approvals only count while it is requested', $locked->lifecycle_state));
                    }
                    if (trim((string) $locked->requested_by) === $approver->actorId) {
                        throw AuthorizationDenied::forCode('resources.disposal_not_independent', 'the approver must differ from the requester');
                    }

                    if ($locked->approver_one_id === null) {
                        $locked->forceFill(['approver_one_id' => $approver->actorId]);
                        $state = 'requested';
                    } else {
                        if (trim((string) $locked->approver_one_id) === $approver->actorId) {
                            throw AuthorizationDenied::forCode('resources.disposal_single_actor', 'asset disposal needs two distinct approvers');
                        }
                        $locked->forceFill(['approver_two_id' => $approver->actorId, 'lifecycle_state' => 'approved']);
                        $state = 'approved';
                    }
                    $locked->save();

                    $event = $this->audit->record($approver->actorId, 'resources.disposal.approve', 'asset_disposal_request', $locked->id, null, [
                        'asset_id' => $locked->asset_id,
                        'lifecycle_state' => $state,
                        'approver_one_id' => $locked->approver_one_id,
                        'approver_two_id' => $locked->approver_two_id,
                    ]);

                    return ['request_id' => $locked->id, 'lifecycle_state' => $state, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $approver, 'resources.disposal.approve', 'asset_disposal_request', $request->id);
        }
    }

    /** @return array{disposal_id: string, asset_id: string, correlation_id: string} */
    public function execute(Actor $executor, AssetDisposalRequest $request, string $disposedOn, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['resources.asset.dispose', $request->id, $disposedOn, $executor->actorId]));

        try {
            return $this->idempotency->execute('resources.asset.dispose', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($executor, $request, $disposedOn): array {
                    $this->require($executor, self::CAPABILITY_REQUEST);

                    /** @var AssetDisposalRequest $locked */
                    $locked = AssetDisposalRequest::query()->whereKey($request->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state !== 'approved') {
                        throw BusinessRejection::forCode('resources.disposal_request_state', sprintf('the request must be approved before execution; it is %s', $locked->lifecycle_state));
                    }
                    if (trim((string) $locked->requested_by) !== $executor->actorId) {
                        throw AuthorizationDenied::forCode('resources.disposal_executor', 'only the requesting session executes the approved disposal');
                    }

                    /** @var Asset $asset */
                    $asset = Asset::query()->whereKey($locked->asset_id)->lockForUpdate()->firstOrFail();
                    if ($asset->lifecycle_state !== 'in_service') {
                        throw BusinessRejection::forCode('resources.asset_not_in_service', 'only an in-service asset can be disposed');
                    }
                    if (AssetDisposal::query()->where('asset_id', $asset->id)->exists()) {
                        throw BusinessRejection::forCode('resources.disposal_exists', 'this asset is already disposed');
                    }

                    /** @var Custody|null $open */
                    $open = Custody::query()->where('asset_id', $asset->id)->whereNull('released_on')->lockForUpdate()->first();
                    if ($open !== null) {
                        $open->forceFill(['released_on' => $disposedOn]);
                        $open->save();
                    }

                    $disposal = AssetDisposal::query()->create([
                        'id' => RandomIdentifier::new(),
                        'asset_id' => $asset->id,
                        'method' => $locked->method,
                        'reason' => $locked->reason,
                        'disposed_on' => $disposedOn,
                        'requested_by' => $locked->requested_by,
                        'approver_one' => $locked->approver_one_id,
                        'approver_two' => $locked->approver_two_id,
                    ]);
                    $asset->forceFill(['lifecycle_state' => 'disposed']);
                    $asset->save();
                    $locked->forceFill([
                        'lifecycle_state' => 'completed',
                        'executed_by' => $executor->actorId,
                        'disposal_id' => $disposal->id,
                    ]);
                    $locked->save();

                    $event = $this->audit->record($executor->actorId, 'resources.asset.dispose', 'asset_disposal', $disposal->id, null, [
                        'asset_id' => $asset->id, 'method' => $locked->method, 'request_id' => $locked->id,
                    ]);

                    return ['disposal_id' => $disposal->id, 'asset_id' => $asset->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $executor, 'resources.asset.dispose', 'asset_disposal_request', $request->id);
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
