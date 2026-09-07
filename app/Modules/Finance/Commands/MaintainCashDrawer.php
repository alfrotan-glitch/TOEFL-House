<?php

declare(strict_types=1);

namespace App\Modules\Finance\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Finance\Models\CashDrawer;
use App\Modules\Finance\Models\CashMovement;
use App\Modules\Finance\Queries\CashDrawerBalanceQuery;
use App\Modules\Organization\Models\Branch;
use App\Modules\Organization\Models\Organization;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use App\Support\MoneyAmount;
use Illuminate\Support\Facades\DB;

/**
 * Cash desk custody (BR-FIN-00x): a drawer opens with a custodian and float,
 * records cash in/out movements (a draw never exceeds the cash in the till),
 * and closes with a counted balance, variance, and documented reason. The
 * running balance is always derived, never stored.
 */
final class MaintainCashDrawer
{
    public const CAPABILITY_MANAGE = 'finance.cash_drawer_manage';

    public const CAPABILITY_MOVE = 'finance.cash_drawer_move';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
        private readonly CashDrawerBalanceQuery $balances,
    ) {}

    /** @return array{drawer_id: string, correlation_id: string} */
    public function open(Actor $actor, string $branchId, string $custodianId, string $openingBalance, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.cash_drawer.open', $branchId, $custodianId, $openingBalance, $actor->actorId]));

        try {
            return $this->idempotency->execute('finance.cash_drawer.open', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $branchId, $custodianId, $openingBalance): array {
                    if (! MoneyAmount::nonNegative($openingBalance)) {
                        throw BusinessRejection::forCode('finance.cash_drawer_opening', 'the opening float must be a non-negative number');
                    }
                    if (trim($custodianId) === '') {
                        throw BusinessRejection::forCode('finance.cash_drawer_custodian', 'a cash drawer requires its custodian');
                    }
                    $branch = $this->branch($branchId);
                    if ($branch === null) {
                        throw BusinessRejection::forCode('finance.cash_drawer_provenance_required', 'a cash drawer requires known active branch provenance');
                    }
                    $scope = $branch->structureScope();
                    if ($scope->organizationId === '' || ! Organization::query()->whereKey($scope->organizationId)->where('lifecycle_state', 'active')->exists()) {
                        throw BusinessRejection::forCode('finance.cash_drawer_provenance_required', 'a cash drawer requires active organization provenance');
                    }
                    $this->require($actor, self::CAPABILITY_MANAGE, $scope);
                    if (CashDrawer::query()->where('branch_id', $branch->id)->where('custodian_id', $custodianId)->where('lifecycle_state', CashDrawer::STATE_OPEN)->exists()) {
                        throw BusinessRejection::forCode('finance.cash_drawer_already_open', 'this custodian already has an open cash drawer at this branch');
                    }

                    $drawer = CashDrawer::query()->create([
                        'id' => RandomIdentifier::new(),
                        'organization_id' => $scope->organizationId,
                        'branch_id' => $branch->id,
                        'custodian_id' => $custodianId,
                        'opening_balance' => $openingBalance,
                        'opened_by' => $actor->actorId,
                        'opened_at' => now(),
                        'lifecycle_state' => CashDrawer::STATE_OPEN,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'finance.cash_drawer.open', 'cash_drawer', $drawer->id, null, [
                        'branch_id' => $branch->id, 'organization_id' => $scope->organizationId, 'custodian_id' => $custodianId, 'opening_balance' => $openingBalance,
                    ]);

                    return ['drawer_id' => $drawer->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'finance.cash_drawer.open', 'cash_drawer', $branchId);
        }
    }

    /** @return array{movement_id: string, correlation_id: string} */
    public function recordMovement(Actor $actor, CashDrawer $drawer, string $type, string $amount, string $reason, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.cash_drawer.move', $drawer->id, $type, $amount, $reason, $actor->actorId]));

        try {
            return $this->idempotency->execute('finance.cash_drawer.move', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $drawer, $type, $amount, $reason): array {
                    if (! in_array($type, [CashMovement::TYPE_IN, CashMovement::TYPE_OUT], true)) {
                        throw BusinessRejection::forCode('finance.cash_drawer_move_type', 'a cash movement is cash in or cash out');
                    }
                    if ($reason === '') {
                        throw BusinessRejection::forCode('finance.cash_drawer_move_reason', 'a cash movement requires its documented reason');
                    }
                    if (! MoneyAmount::positive($amount)) {
                        throw BusinessRejection::forCode('finance.cash_drawer_move_amount', 'the cash movement amount must be a positive number');
                    }

                    /** @var CashDrawer $lockedDrawer */
                    $lockedDrawer = CashDrawer::query()->whereKey($drawer->id)->lockForUpdate()->firstOrFail();
                    if ($lockedDrawer->lifecycle_state !== CashDrawer::STATE_OPEN) {
                        throw BusinessRejection::forCode('finance.cash_drawer_not_open', 'cash movements record only into an open cash drawer');
                    }
                    $branch = $this->branch((string) $lockedDrawer->branch_id);
                    if ($branch === null) {
                        throw BusinessRejection::forCode('finance.cash_drawer_provenance_required', 'a cash movement requires known active branch provenance');
                    }
                    $this->require($actor, self::CAPABILITY_MOVE, $branch->structureScope());

                    if ($type === CashMovement::TYPE_OUT) {
                        $running = $this->balances->currentCash($lockedDrawer);
                        if (bccomp($amount, $running, 2) === 1) {
                            throw BusinessRejection::forCode('finance.cash_drawer_insufficient', sprintf('a cash draw cannot exceed the cash in the drawer (%s)', $running));
                        }
                    }

                    $movement = CashMovement::query()->create([
                        'id' => RandomIdentifier::new(),
                        'drawer_id' => $lockedDrawer->id,
                        'type' => $type,
                        'amount' => $amount,
                        'reason' => $reason,
                        'recorded_by' => $actor->actorId,
                        'occurred_at' => now(),
                    ]);
                    $event = $this->audit->record($actor->actorId, 'finance.cash_drawer.move', 'cash_movement', $movement->id, null, [
                        'drawer_id' => $lockedDrawer->id, 'branch_id' => $branch->id, 'organization_id' => $branch->structureScope()->organizationId, 'type' => $type, 'amount' => $amount,
                    ]);

                    return ['movement_id' => $movement->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'finance.cash_drawer.move', 'cash_movement', $drawer->id);
        }
    }

    /** @return array{drawer_id: string, lifecycle_state: string, variance: string, correlation_id: string} */
    public function close(Actor $actor, CashDrawer $drawer, string $countedBalance, string $reason, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.cash_drawer.close', $drawer->id, $countedBalance, $reason, $actor->actorId]));

        try {
            return $this->idempotency->execute('finance.cash_drawer.close', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $drawer, $countedBalance, $reason): array {
                    if (! MoneyAmount::nonNegative($countedBalance)) {
                        throw BusinessRejection::forCode('finance.cash_drawer_count', 'the counted balance must be a non-negative number');
                    }
                    if ($reason === '') {
                        throw BusinessRejection::forCode('finance.cash_drawer_close_reason', 'a closed cash drawer requires its documented reason');
                    }

                    /** @var CashDrawer $lockedDrawer */
                    $lockedDrawer = CashDrawer::query()->whereKey($drawer->id)->lockForUpdate()->firstOrFail();
                    if ($lockedDrawer->lifecycle_state !== CashDrawer::STATE_OPEN) {
                        throw BusinessRejection::forCode('finance.cash_drawer_not_open', 'only an open cash drawer can be closed');
                    }
                    if (trim((string) $lockedDrawer->custodian_id) === $actor->actorId) {
                        throw AuthorizationDenied::forCode('finance.cash_drawer_not_independent', 'the closer must differ from the custodian');
                    }
                    $branch = $this->branch((string) $lockedDrawer->branch_id);
                    if ($branch === null) {
                        throw BusinessRejection::forCode('finance.cash_drawer_provenance_required', 'a cash drawer requires known active branch provenance');
                    }
                    $this->require($actor, self::CAPABILITY_MANAGE, $branch->structureScope());

                    $expected = $this->balances->currentCash($lockedDrawer);
                    $variance = bcsub(MoneyAmount::decimal($countedBalance), $expected, 2);

                    $before = ['lifecycle_state' => $lockedDrawer->lifecycle_state];
                    $lockedDrawer->forceFill([
                        'lifecycle_state' => CashDrawer::STATE_CLOSED,
                        'counted_balance' => $countedBalance,
                        'close_variance' => $variance,
                        'close_reason' => $reason,
                        'closed_by' => $actor->actorId,
                        'closed_at' => now(),
                    ])->save();
                    $event = $this->audit->record($actor->actorId, 'finance.cash_drawer.close', 'cash_drawer', $lockedDrawer->id, $before, [
                        'lifecycle_state' => CashDrawer::STATE_CLOSED,
                        'variance' => $variance,
                        'counted_balance' => $countedBalance,
                        'branch_id' => $branch->id,
                        'organization_id' => $branch->structureScope()->organizationId,
                    ]);

                    return ['drawer_id' => $lockedDrawer->id, 'lifecycle_state' => CashDrawer::STATE_CLOSED, 'variance' => $variance, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'finance.cash_drawer.close', 'cash_drawer', $drawer->id);
        }
    }

    private function branch(string $branchId): ?Branch
    {
        $branchId = trim($branchId);
        if ($branchId === '') {
            return null;
        }
        /** @var Branch|null $branch */
        $branch = Branch::query()->whereKey($branchId)->first();

        return $branch !== null && $branch->lifecycle_state === 'active' ? $branch : null;
    }

    private function require(Actor $actor, string $capability, \App\Support\Authorization\StructureScope $scope): void
    {
        $outcome = $this->access->decide($actor, $capability, $scope);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('finance.cash_drawer_denied', $outcome->reason);
        }
    }
}
