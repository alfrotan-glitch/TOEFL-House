<?php

declare(strict_types=1);

namespace App\Modules\Privacy\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Privacy\Models\ConsentPurpose;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Defines a purpose of personal-data use. Communication and marketing
 * purposes are defined as separate rows; conflating them is rejected.
 */
final class DefineConsentPurpose
{
    public const CAPABILITY = 'privacy.define_purpose';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{purpose_id: string, correlation_id: string} */
    public function define(Actor $definer, string $name, string $channel, string $category, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['privacy.purpose.define', $name, $channel, $category, $definer->actorId]));

        try {
            return $this->idempotency->execute('privacy.purpose.define', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($definer, $name, $channel, $category): array {
                    $this->requireDefiner($definer);

                    /** @var ConsentPurpose $purpose */
                    $purpose = ConsentPurpose::query()->create([
                        'id' => RandomIdentifier::new(),
                        'name' => $name,
                        'channel' => $channel,
                        'category' => $category,
                    ]);

                    $event = $this->audit->record($definer->actorId, 'privacy.purpose.define', 'consent_purpose', $purpose->id, null, [
                        'name' => $name, 'channel' => $channel, 'category' => $category,
                    ]);

                    return ['purpose_id' => $purpose->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $definer, 'privacy.purpose.define', 'consent_purpose', $name);
        }
    }

    private function requireDefiner(Actor $definer): void
    {
        $outcome = $this->access->decide($definer, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('privacy.purpose_denied', $outcome->reason);
        }
    }
}
