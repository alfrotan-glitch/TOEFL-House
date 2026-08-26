<?php

declare(strict_types=1);

namespace App\Modules\Finance\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Finance\Models\Account;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Chart of accounts: unique codes, five canonical types, immutable once
 * defined — a changed definition is a new account.
 */
final class MaintainChartOfAccounts
{
    public const CAPABILITY = 'finance.chart';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{account_id: string, correlation_id: string} */
    public function define(Actor $actor, string $code, string $name, string $type, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.account.define', $code, $name, $type, $actor->actorId]));

        try {
            return $this->idempotency->execute('finance.account.define', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $code, $name, $type): array {
                    $this->require($actor);
                    if (! in_array($type, ['asset', 'liability', 'equity', 'revenue', 'expense'], true)) {
                        throw BusinessRejection::forCode('finance.account_type_unknown', sprintf('unknown account type %s', $type));
                    }
                    if (Account::query()->where('code', $code)->exists()) {
                        throw BusinessRejection::forCode('finance.account_code_exists', 'this account code already exists');
                    }

                    $account = Account::query()->create([
                        'id' => RandomIdentifier::new(),
                        'code' => $code,
                        'name' => $name,
                        'type' => $type,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'finance.account.define', 'account', $account->id, null, ['code' => $code, 'type' => $type]);

                    return ['account_id' => $account->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'finance.account.define', 'account', $code);
        }
    }

    private function require(Actor $actor): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('finance.chart_denied', $outcome->reason);
        }
    }
}
