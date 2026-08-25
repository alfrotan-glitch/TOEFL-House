<?php

declare(strict_types=1);

namespace App\Modules\Privacy\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Privacy\Domain\ConsentLifecycle;
use App\Modules\Privacy\Models\Consent;
use App\Modules\Privacy\Models\ConsentRevocation;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Explicit consent lifecycle transitions. The subject may submit or revoke
 * their own consent; every other transition requires the consent
 * capability. Revocation stops future use and records the withdrawal as
 * append-only evidence; nothing is erased.
 */
final class TransitionConsent
{
    public const CAPABILITY = 'privacy.consent';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{consent_id: string, lifecycle_state: string, correlation_id: string} */
    public function submit(Actor $actor, Consent $consent, string $idempotencyKey): array
    {
        return $this->transition($actor, $consent, ConsentLifecycle::STATE_SUBMITTED, 'submit', null, $idempotencyKey);
    }

    /** @return array{consent_id: string, lifecycle_state: string, correlation_id: string} */
    public function verify(Actor $actor, Consent $consent, string $idempotencyKey): array
    {
        return $this->transition($actor, $consent, ConsentLifecycle::STATE_VERIFIED, 'verify', self::CAPABILITY, $idempotencyKey);
    }

    /** @return array{consent_id: string, lifecycle_state: string, correlation_id: string} */
    public function activate(Actor $actor, Consent $consent, string $idempotencyKey): array
    {
        return $this->transition($actor, $consent, ConsentLifecycle::STATE_ACTIVE, 'activate', self::CAPABILITY, $idempotencyKey);
    }

    /** @return array{consent_id: string, lifecycle_state: string, correlation_id: string} */
    public function revoke(Actor $actor, Consent $consent, string $scope, string $effect, string $idempotencyKey): array
    {
        return $this->transition($actor, $consent, ConsentLifecycle::STATE_REVOKED, 'revoke', null, $idempotencyKey, compact('scope', 'effect'));
    }

    /** @return array{consent_id: string, lifecycle_state: string, correlation_id: string} */
    public function archive(Actor $actor, Consent $consent, string $idempotencyKey): array
    {
        return $this->transition($actor, $consent, ConsentLifecycle::STATE_ARCHIVED, 'archive', self::CAPABILITY, $idempotencyKey);
    }

    /**
     * @param  array{scope: string, effect: string}|null  $revocation
     * @return array{consent_id: string, lifecycle_state: string, correlation_id: string}
     */
    private function transition(Actor $actor, Consent $consent, string $toState, string $verb, ?string $capability, string $idempotencyKey, ?array $revocation = null): array
    {
        $payload = hash('sha256', implode('|', ['privacy.consent.'.$verb, $consent->id, $toState, $actor->actorId, $revocation['scope'] ?? '', $revocation['effect'] ?? '']));

        try {
            return $this->idempotency->execute('privacy.consent.'.$verb, $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $consent, $toState, $verb, $capability, $revocation): array {
                    if ($capability !== null || trim((string) $consent->subject_person_id) !== $actor->actorId) {
                        $outcome = $this->access->decide($actor, $capability ?? self::CAPABILITY, null);
                        if (! $outcome->allowed) {
                            throw AuthorizationDenied::forCode('privacy.consent_transition_denied', $outcome->reason);
                        }
                    }

                    /** @var Consent $locked */
                    $locked = Consent::query()->whereKey($consent->id)->lockForUpdate()->firstOrFail();
                    ConsentLifecycle::requireTransition($locked->lifecycle_state, $toState);

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => $toState]);
                    $locked->save();

                    if ($revocation !== null) {
                        ConsentRevocation::query()->create([
                            'id' => RandomIdentifier::new(),
                            'consent_id' => $locked->id,
                            'revoked_by' => $actor->actorId,
                            'scope' => $revocation['scope'],
                            'effect' => $revocation['effect'],
                        ]);
                    }

                    $event = $this->audit->record($actor->actorId, 'privacy.consent.'.$verb, 'consent', $locked->id, $before, ['lifecycle_state' => $toState]);

                    return ['consent_id' => $locked->id, 'lifecycle_state' => $toState, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'privacy.consent.'.$verb, 'consent', $consent->id);
        }
    }
}
