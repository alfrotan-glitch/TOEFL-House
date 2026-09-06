<?php

declare(strict_types=1);

namespace App\Modules\Identity\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Identity\Models\UserAccount;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Authorization\PersonBranchScope;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Errors\DomainError;
use App\Support\Idempotency\IdempotentExecution;
use Illuminate\Support\Facades\DB;

/**
 * Deactivation is the terminal identity outcome: the account row and its
 * history are retained and never erased.
 */
final class DeactivateUserAccount
{
    public const CAPABILITY = 'identity.admin';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{account_id: string, account_state: string, correlation_id: string} */
    public function deactivate(Actor $administrator, UserAccount $account, string $reason, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['identity.deactivate_account', $account->id, $reason, $administrator->actorId]));

        try {
            return $this->idempotency->execute('identity.deactivate_account', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($administrator, $account, $reason): array {
                    /** @var UserAccount $locked */
                    $locked = UserAccount::query()->whereKey($account->id)->lockForUpdate()->firstOrFail();
                    $scope = PersonBranchScope::resolve($locked->person_id);
                    $outcome = $this->access->decide($administrator, self::CAPABILITY, $scope);
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('identity.deactivate_denied', $outcome->reason);
                    }
                    if (! $locked->isActive()) {
                        throw BusinessRejection::forCode('identity.account_not_active', 'only an active account can be deactivated');
                    }

                    $locked->account_state = UserAccount::STATE_DEACTIVATED;
                    $locked->deactivated_at = now()->toDateTimeString();
                    $locked->deactivation_reason = $reason;
                    $locked->save();

                    $correlationId = DomainError::newCorrelationId();
                    $this->audit->record(
                        $administrator->actorId,
                        'identity.deactivate_account',
                        'user_account',
                        $locked->id,
                        ['account_state' => UserAccount::STATE_ACTIVE],
                        ['account_state' => UserAccount::STATE_DEACTIVATED, 'reason' => $reason, 'branch_id' => $scope->branchId, 'organization_id' => $scope->organizationId],
                        $correlationId,
                    );

                    return ['account_id' => $locked->id, 'account_state' => $locked->account_state, 'correlation_id' => $correlationId];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $administrator, 'identity.deactivate_account', 'user_account', $account->id);
        }
    }
}
