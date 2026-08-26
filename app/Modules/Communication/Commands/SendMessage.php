<?php

declare(strict_types=1);

namespace App\Modules\Communication\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Communication\Domain\MessageLifecycle;
use App\Modules\Communication\Models\Message;
use App\Modules\Privacy\Models\Consent;
use App\Modules\Privacy\Models\ConsentPurpose;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Communication: a message is queued post-commit only under an ACTIVE
 * consent for the subject and purpose, on the purpose's own channel
 * (communication and marketing consent are separate). Revocation blocks
 * future use without erasing history; delivered messages are retained.
 */
final class SendMessage
{
    public const CAPABILITY = 'communication.send';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{message_id: string, correlation_id: string} */
    public function queue(Actor $actor, string $subjectPersonId, string $purposeId, string $channel, string $contentRef, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['communication.message.queue', $subjectPersonId, $purposeId, $channel, $contentRef, $actor->actorId]));

        try {
            return $this->idempotency->execute('communication.message.queue', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $subjectPersonId, $purposeId, $channel, $contentRef): array {
                    $this->require($actor);
                    if ($contentRef === '') {
                        throw BusinessRejection::forCode('communication.content', 'a message requires its content reference');
                    }

                    /** @var ConsentPurpose|null $purpose */
                    $purpose = ConsentPurpose::query()->find($purposeId);
                    if ($purpose === null) {
                        throw BusinessRejection::forCode('communication.purpose_unknown', 'the referenced consent purpose does not exist');
                    }
                    if ($purpose->channel !== $channel) {
                        throw BusinessRejection::forCode('communication.channel_mismatch', sprintf('purpose %s is registered for channel %s', $purpose->name, $purpose->channel));
                    }

                    $today = now()->toDateString();
                    $consented = Consent::query()
                        ->where('subject_person_id', $subjectPersonId)
                        ->where('purpose_id', $purpose->id)
                        ->where('lifecycle_state', 'active')
                        ->where('effective_from', '<=', $today)
                        ->where(fn ($query) => $query->whereNull('effective_to')->orWhere('effective_to', '>', $today))
                        ->exists();
                    if (! $consented) {
                        throw BusinessRejection::forCode('communication.consent_missing', 'no active consent covers this subject, purpose, and time');
                    }

                    $message = Message::query()->create([
                        'id' => RandomIdentifier::new(),
                        'subject_person_id' => $subjectPersonId,
                        'purpose_id' => $purpose->id,
                        'channel' => $channel,
                        'content_ref' => $contentRef,
                        'lifecycle_state' => MessageLifecycle::STATE_QUEUED,
                        'created_by' => $actor->actorId,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'communication.message.queue', 'message', $message->id, null, [
                        'subject' => $subjectPersonId, 'purpose' => $purpose->id, 'channel' => $channel,
                    ]);

                    return ['message_id' => $message->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'communication.message.queue', 'message', $subjectPersonId);
        }
    }

    /** @return array{message_id: string, lifecycle_state: string, correlation_id: string} */
    public function markDelivered(Actor $actor, Message $message, string $deliveryRef, string $idempotencyKey): array
    {
        return $this->transition($actor, $message, MessageLifecycle::STATE_SENT, $deliveryRef, $idempotencyKey);
    }

    /** @return array{message_id: string, lifecycle_state: string, correlation_id: string} */
    public function markFailed(Actor $actor, Message $message, string $deliveryRef, string $idempotencyKey): array
    {
        return $this->transition($actor, $message, MessageLifecycle::STATE_FAILED, $deliveryRef, $idempotencyKey);
    }

    /** @return array{message_id: string, lifecycle_state: string, correlation_id: string} */
    private function transition(Actor $actor, Message $message, string $toState, string $deliveryRef, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['communication.message.deliver', $message->id, $toState, $actor->actorId]));

        try {
            return $this->idempotency->execute('communication.message.deliver', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $message, $toState, $deliveryRef): array {
                    $this->require($actor);
                    if ($deliveryRef === '') {
                        throw BusinessRejection::forCode('communication.delivery_evidence', 'a delivery result requires its provider reference');
                    }

                    /** @var Message $locked */
                    $locked = Message::query()->whereKey($message->id)->lockForUpdate()->firstOrFail();
                    MessageLifecycle::requireTransition($locked->lifecycle_state, $toState);

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => $toState, 'delivery_ref' => $deliveryRef]);
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'communication.message.deliver', 'message', $locked->id, $before, ['lifecycle_state' => $toState]);

                    return ['message_id' => $locked->id, 'lifecycle_state' => $toState, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'communication.message.deliver', 'message', $message->id);
        }
    }

    private function require(Actor $actor): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('communication.denied', $outcome->reason);
        }
    }
}
