<?php

declare(strict_types=1);

namespace App\Modules\Communication\Domain;

use App\Modules\Communication\Models\Notification;
use App\Modules\Identity\Models\Person;
use App\Modules\Identity\Models\UserAccount;
use App\Modules\Organization\Models\Branch;
use App\Modules\Organization\Models\Campus;
use App\Modules\Organization\Models\Organization;
use App\Modules\Outbox\Domain\EventConsumer;
use App\Modules\Outbox\Models\DomainEvent;
use App\Support\Identifiers\RandomIdentifier;

/**
 * Consumes only explicit notification intents from committed event payloads.
 * It never guesses recipients from the event actor and never changes a
 * source-domain lifecycle. Unique event/recipient dedupe makes replay safe.
 */
final class NotificationProjectionConsumer implements EventConsumer
{
    public function key(): string
    {
        return 'communication.notification_projection';
    }

    public function supports(DomainEvent $event): bool
    {
        // An explicit notification intent is applicable even when malformed.
        // consume() owns validation so bad intents remain observable and
        // retry/dead-letter instead of becoming a silent success receipt.
        return is_array($this->intent($event));
    }

    public function consume(DomainEvent $event): void
    {
        /** @var array<string, mixed> $intent */
        $intent = $this->intent($event) ?? [];
        $recipient = trim((string) ($intent['recipient_actor_id'] ?? ''));
        $title = trim((string) ($intent['title'] ?? ''));
        $sourceType = trim((string) ($intent['source_type'] ?? $event->aggregate_type));
        $sourceId = trim((string) ($intent['source_id'] ?? $event->aggregate_id));
        if ($recipient === '' || $title === '' || $sourceType === '' || $sourceId === '') {
            throw \App\Support\Errors\BusinessRejection::forCode('communication.notification_intent_invalid', 'a notification requires recipient, title, and source identity');
        }
        if ($sourceType !== trim((string) $event->aggregate_type)
            || $sourceId !== trim((string) $event->aggregate_id)) {
            throw \App\Support\Errors\BusinessRejection::forCode('communication.notification_source_mismatch', 'a notification source must match its domain event aggregate');
        }
        $intentBranch = trim((string) ($intent['branch_id'] ?? ''));
        $eventBranch = trim((string) ($event->context['branch_id'] ?? ''));
        $eventOrganization = trim((string) ($event->context['organization_id'] ?? ''));
        $scopeType = trim((string) ($event->context['scope_type'] ?? 'unknown'));
        if (! $this->recipientIsActive($recipient)) {
            throw \App\Support\Errors\BusinessRejection::forCode('communication.notification_recipient_unknown', 'a notification requires an active recipient identity');
        }
        if (($intentBranch !== '' && $eventBranch === '') || ($intentBranch !== '' && $intentBranch !== $eventBranch)) {
            throw \App\Support\Errors\BusinessRejection::forCode('communication.notification_branch_invalid', 'a notification branch must match the event envelope provenance');
        }
        if (! in_array($scopeType, ['branch', 'organization'], true)) {
            throw \App\Support\Errors\BusinessRejection::forCode('communication.notification_scope_unknown', 'an event without organization or branch provenance cannot create a notification');
        }
        if (($scopeType === 'organization' && ($eventBranch !== '' || $intentBranch !== '' || $eventOrganization === ''))
            || ($scopeType === 'branch' && ($eventBranch === '' || $eventOrganization === ''))) {
            throw \App\Support\Errors\BusinessRejection::forCode('communication.notification_branch_invalid', 'notification scope must match the event envelope provenance');
        }
        if (! Organization::query()->whereKey($eventOrganization)->where('lifecycle_state', 'active')->exists()) {
            throw \App\Support\Errors\BusinessRejection::forCode('communication.notification_organization_unknown', 'a notification requires an existing organization provenance');
        }
        if ($eventBranch !== '' && ! $this->branchBelongsToOrganization($eventBranch, $eventOrganization)) {
            throw \App\Support\Errors\BusinessRejection::forCode('communication.notification_scope_invalid', 'branch and organization notification provenance must agree');
        }
        $branchId = $eventBranch !== '' ? $eventBranch : ($intentBranch !== '' ? $intentBranch : null);
        if ($branchId !== null && ! Branch::query()->whereKey($branchId)->where('lifecycle_state', 'active')->exists()) {
            throw \App\Support\Errors\BusinessRejection::forCode('communication.notification_branch_unknown', 'a notification requires an existing branch provenance');
        }
        $severity = $intent['severity'] ?? 'info';
        if (! in_array($severity, ['info', 'warning', 'critical'], true)) {
            throw \App\Support\Errors\BusinessRejection::forCode('communication.notification_severity_invalid', 'a notification severity is not governed');
        }
        $dedupe = trim((string) ($intent['dedupe_key'] ?? $event->id.'|'.$recipient));

        Notification::query()->firstOrCreate(
            ['dedupe_key' => $dedupe],
            [
                'id' => RandomIdentifier::new(),
                'event_id' => $event->id,
                'recipient_actor_id' => $recipient,
                'source_type' => $sourceType,
                'source_id' => $sourceId,
                'title' => $title,
                'body_ref' => isset($intent['body_ref']) ? trim((string) $intent['body_ref']) : null,
                'severity' => $severity,
                'scope_type' => $scopeType,
                'organization_id' => $eventOrganization,
                'branch_id' => $branchId,
                'lifecycle_state' => 'unread',
                'expires_at' => isset($intent['expires_at']) ? $intent['expires_at'] : null,
            ],
        );
    }

    private function branchBelongsToOrganization(string $branchId, string $organizationId): bool
    {
        /** @var Branch|null $branch */
        $branch = Branch::query()
            ->whereKey($branchId)
            ->where('lifecycle_state', 'active')
            ->first();
        $assignment = $branch?->activeCampusAssignment();
        if ($assignment === null) {
            return false;
        }

        return Campus::query()
            ->whereKey($assignment->campus_id)
            ->where('organization_id', $organizationId)
            ->where('lifecycle_state', 'active')
            ->exists();
    }

    private function recipientIsActive(string $recipient): bool
    {
        return Person::query()
            ->whereKey($recipient)
            ->where('verification_state', Person::VERIFICATION_VERIFIED)
            ->exists()
            && UserAccount::query()
                ->where('person_id', $recipient)
                ->where('account_state', UserAccount::STATE_ACTIVE)
                ->exists();
    }

    /** @return array<string, mixed>|null */
    private function intent(DomainEvent $event): ?array
    {
        $after = $event->payload['after'] ?? null;
        $intent = $event->payload['notification'] ?? (is_array($after) ? ($after['notification'] ?? null) : null);

        return is_array($intent) ? $intent : null;
    }
}
