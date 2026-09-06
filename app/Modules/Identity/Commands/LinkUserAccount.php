<?php

declare(strict_types=1);

namespace App\Modules\Identity\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Identity\Models\Person;
use App\Modules\Identity\Models\UserAccount;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Errors\DomainError;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;

/**
 * Links a user account to a verified person; one active account per person
 * is enforced at the persistence boundary and unverified identities are
 * rejected with audit evidence per the identity boundary contract.
 */
final class LinkUserAccount
{
    public const CAPABILITY = 'identity.admin';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{account_id: string, person_id: string, username: string, correlation_id: string} */
    public function link(Actor $administrator, Person $person, string $username, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['identity.link_account', $person->id, $username, $administrator->actorId]));

        try {
            return $this->idempotency->execute('identity.link_account', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($administrator, $person, $username): array {
                    $outcome = $this->access->decide($administrator, self::CAPABILITY, null);
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('identity.link_denied', $outcome->reason);
                    }

                    /** @var Person $locked */
                    $locked = Person::query()->whereKey($person->id)->lockForUpdate()->firstOrFail();
                    if (! $locked->isVerified()) {
                        throw BusinessRejection::forCode('identity.person_unverified', 'user account requires a verified person');
                    }

                    $correlationId = DomainError::newCorrelationId();
                    $accountId = RandomIdentifier::new();
                    try {
                        UserAccount::query()->create([
                            'id' => $accountId,
                            'person_id' => $locked->id,
                            'username' => $username,
                            'account_state' => UserAccount::STATE_ACTIVE,
                            'deactivated_at' => null,
                            'deactivation_reason' => null,
                        ]);
                    } catch (UniqueConstraintViolationException) {
                        throw BusinessRejection::forCode('identity.account_conflict', 'username is taken or person already has an active account');
                    }

                    $this->audit->record(
                        $administrator->actorId,
                        'identity.link_account',
                        'person',
                        $locked->id,
                        null,
                        ['username' => $username, 'account_state' => UserAccount::STATE_ACTIVE, 'account_id' => $accountId],
                        $correlationId,
                    );

                    return [
                        'account_id' => $accountId,
                        'person_id' => $locked->id,
                        'username' => $username,
                        'correlation_id' => $correlationId,
                    ];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $administrator, 'identity.link_account', 'person', $person->id);
        }
    }
}
