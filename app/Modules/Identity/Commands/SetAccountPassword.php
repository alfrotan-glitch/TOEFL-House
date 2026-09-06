<?php

declare(strict_types=1);

namespace App\Modules\Identity\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Identity\Models\UserAccount;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Errors\ValidationError;
use App\Support\Idempotency\IdempotentExecution;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;

/**
 * Sets or resets the credential of a user account. The account must be
 * active and its person verified; the password is stored hashed and never
 * logged or echoed back. This is the single authoritative path for
 * employee credentials — an account created by linking has no credential
 * until it is set here.
 */
final class SetAccountPassword
{
    public const CAPABILITY = 'identity.admin';

    public const MIN_PASSWORD_LENGTH = 10;

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{account_id: string, correlation_id: string} */
    public function set(Actor $administrator, UserAccount $account, string $password, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['identity.set_account_password', $account->id, $administrator->actorId]));

        try {
            return $this->idempotency->execute('identity.set_account_password', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($administrator, $account, $password): array {
                    $outcome = $this->access->decide($administrator, self::CAPABILITY, null);
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('identity.set_password_denied', $outcome->reason);
                    }
                    if (mb_strlen($password) < self::MIN_PASSWORD_LENGTH) {
                        throw ValidationError::forCode('identity.password_length', sprintf('a password requires at least %d characters', self::MIN_PASSWORD_LENGTH));
                    }

                    /** @var UserAccount $locked */
                    $locked = UserAccount::query()->whereKey($account->id)->lockForUpdate()->firstOrFail();
                    if (! $locked->isActive()) {
                        throw BusinessRejection::forCode('identity.account_deactivated', 'a deactivated account cannot receive credentials');
                    }

                    $locked->forceFill([
                        'password_hash' => Hash::make($password),
                        'password_changed_at' => now(),
                    ])->save();

                    $event = $this->audit->record(
                        $administrator->actorId,
                        'identity.set_account_password',
                        'user_account',
                        $locked->id,
                        null,
                        ['person_id' => $locked->person_id, 'username' => $locked->username],
                    );

                    return ['account_id' => $locked->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $administrator, 'identity.set_account_password', 'user_account', $account->id);
        }
    }
}
