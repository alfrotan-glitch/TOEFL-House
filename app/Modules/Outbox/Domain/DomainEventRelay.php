<?php

declare(strict_types=1);

namespace App\Modules\Outbox\Domain;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Outbox\Models\ConsumerReceipt;
use App\Modules\Outbox\Models\DomainEvent;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Throwable;

/**
 * At-least-once relay for the immutable domain event log. One receipt exists
 * per (event, consumer), claims expire, failures retry with bounded backoff,
 * and a consumer's successful effect is never run twice after a succeeded
 * receipt. Consumers are allowlisted and may only update projections.
 */
final class DomainEventRelay
{
    public const CAPABILITY = 'integrations.process';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{considered: int, succeeded: int, failed: int, dead_letter: int, skipped: int} */
    public function relay(Actor $actor, int $batch = 100): array
    {
        try {
            $this->require($actor);
            $consumerKeys = EventConsumerCatalog::keys();
            $eligibleAt = now();
            $events = DomainEvent::query()
                // An event remains eligible while any consumer is due. This
                // must be OR, not AND: one consumer may succeed before
                // another is first claimed. Future backoff rows and active
                // leases are excluded so old failures cannot starve new work.
                ->where(function ($query) use ($consumerKeys, $eligibleAt): void {
                    foreach ($consumerKeys as $consumerKey) {
                        $query->orWhere(function ($eligible) use ($consumerKey, $eligibleAt): void {
                            $eligible->whereNotExists(function ($missing) use ($consumerKey): void {
                                $missing->selectRaw('1')
                                    ->from('event_consumer_receipts')
                                    ->whereColumn('event_consumer_receipts.event_id', 'domain_events.id')
                                    ->where('event_consumer_receipts.consumer_key', $consumerKey);
                            })->orWhereExists(function ($receipt) use ($consumerKey, $eligibleAt): void {
                                $receipt->selectRaw('1')
                                    ->from('event_consumer_receipts')
                                    ->whereColumn('event_consumer_receipts.event_id', 'domain_events.id')
                                    ->where('event_consumer_receipts.consumer_key', $consumerKey)
                                    ->where(function ($state) use ($eligibleAt): void {
                                        $state->where('status', 'pending')
                                            ->orWhere(function ($failed) use ($eligibleAt): void {
                                                $failed->where('status', 'failed')
                                                    ->where(fn ($due) => $due->whereNull('next_attempt_at')->orWhere('next_attempt_at', '<=', $eligibleAt));
                                            })
                                            ->orWhere(function ($processing) use ($eligibleAt): void {
                                                $processing->where('status', 'processing')
                                                    ->where(fn ($expired) => $expired->whereNull('lease_until')->orWhere('lease_until', '<=', $eligibleAt));
                                            });
                                    });
                            });
                        });
                    }
                })
                ->orderBy('occurred_at')
                ->orderBy('id')
                ->limit(max(1, min($batch, 500)))
                ->get();
            $summary = ['considered' => 0, 'succeeded' => 0, 'failed' => 0, 'dead_letter' => 0, 'skipped' => 0];

            foreach ($events as $event) {
                foreach (EventConsumerCatalog::keys() as $consumerKey) {
                    $consumer = app(EventConsumerCatalog::consumerFor($consumerKey));
                    if (! $consumer->supports($event)) {
                        $this->recordNotApplicable($event, $consumerKey);
                        $summary['skipped']++;
                        continue;
                    }
                    $summary['considered']++;
                    $outcome = $this->deliver($event, $consumerKey);
                    $summary[$outcome]++;
                }
            }

            return $summary;
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'outbox.relay', 'domain_event', 'batch');
        }
    }

    private function recordNotApplicable(DomainEvent $event, string $consumerKey): void
    {
        try {
            DB::transaction(function () use ($event, $consumerKey): void {
                ConsumerReceipt::query()->firstOrCreate(
                    ['event_id' => $event->id, 'consumer_key' => $consumerKey],
                    [
                        'id' => RandomIdentifier::new(),
                        'status' => 'succeeded',
                        'attempts' => 0,
                        'max_attempts' => 1,
                        'last_error' => 'not_applicable_to_event',
                        'processed_at' => now(),
                    ],
                );
            });
        } catch (QueryException $failure) {
            // Concurrent non-applicability recording is harmless once the
            // receipt's unique key has selected the winner.
            if ($failure->getCode() !== '23505') {
                throw $failure;
            }
        }
    }

    /** @return 'succeeded'|'failed'|'dead_letter'|'skipped' */
    private function deliver(DomainEvent $event, string $consumerKey): string
    {
        $receipt = $this->claim($event, $consumerKey);
        if ($receipt === null) {
            return 'skipped';
        }

        $consumer = app(EventConsumerCatalog::consumerFor($consumerKey));
        try {
            $processed = DB::transaction(function () use ($consumer, $event, $receipt): bool {
                // Re-lock the claim for the whole consumer transaction. A
                // lease-expired worker must not update a newer attempt's
                // receipt, and effects plus the success receipt stay atomic.
                $locked = ConsumerReceipt::query()->whereKey($receipt->id)->lockForUpdate()->first();
                if ($locked === null
                    || $locked->status !== 'processing'
                    || (int) $locked->attempts !== (int) $receipt->attempts) {
                    return false;
                }
                $consumer->consume($event);
                $locked->forceFill([
                    'status' => 'succeeded',
                    'processed_at' => now(),
                    'next_attempt_at' => null,
                    'lease_until' => null,
                    'last_error' => null,
                ]);
                $locked->save();

                return true;
            });

            return $processed ? 'succeeded' : 'skipped';
        } catch (Throwable $failure) {
            return $this->markFailure($receipt, $failure);
        }
    }

    /** @return 'failed'|'dead_letter'|'skipped' */
    private function markFailure(ConsumerReceipt $claimed, Throwable $failure): string
    {
        return DB::transaction(function () use ($claimed, $failure): string {
            $receipt = ConsumerReceipt::query()->whereKey($claimed->id)->lockForUpdate()->first();
            if ($receipt === null
                || $receipt->status !== 'processing'
                || (int) $receipt->attempts !== (int) $claimed->attempts) {
                return 'skipped';
            }
            $attempts = (int) $receipt->attempts;
            $deadLetter = $attempts >= (int) $receipt->max_attempts;
            $receipt->forceFill([
                'status' => $deadLetter ? 'dead_letter' : 'failed',
                'next_attempt_at' => $deadLetter ? null : now()->addMinutes(min(60, 2 ** min($attempts, 6))),
                'lease_until' => null,
                'last_error' => $failure->getMessage(),
            ]);
            $receipt->save();

            return $deadLetter ? 'dead_letter' : 'failed';
        });
    }

    private function claim(DomainEvent $event, string $consumerKey): ?ConsumerReceipt
    {
        try {
            return DB::transaction(fn (): ?ConsumerReceipt => $this->claimOrCreate($event, $consumerKey));
        } catch (QueryException $failure) {
            // Two relays can observe the same absent receipt. The unique
            // (event_id, consumer_key) index is the arbiter; after the losing
            // insert rolls back, claim the winner's row instead of failing the
            // event permanently.
            if ($failure->getCode() !== '23505') {
                throw $failure;
            }

            return DB::transaction(function () use ($event, $consumerKey, $failure): ?ConsumerReceipt {
                $receipt = ConsumerReceipt::query()
                    ->where('event_id', $event->id)
                    ->where('consumer_key', $consumerKey)
                    ->lockForUpdate()
                    ->first();
                if ($receipt === null) {
                    throw $failure;
                }

                return $this->prepareClaim($receipt);
            });
        }
    }

    private function claimOrCreate(DomainEvent $event, string $consumerKey): ?ConsumerReceipt
    {
        /** @var ConsumerReceipt|null $receipt */
        $receipt = ConsumerReceipt::query()
            ->where('event_id', $event->id)
            ->where('consumer_key', $consumerKey)
            ->lockForUpdate()
            ->first();
        if ($receipt === null) {
            $receipt = ConsumerReceipt::query()->create([
                'id' => RandomIdentifier::new(),
                'event_id' => $event->id,
                'consumer_key' => $consumerKey,
                'status' => 'pending',
                'attempts' => 0,
                'max_attempts' => 5,
            ]);
        }

        return $this->prepareClaim($receipt);
    }

    private function prepareClaim(ConsumerReceipt $receipt): ?ConsumerReceipt
    {
        if ($receipt->status === 'succeeded' || $receipt->status === 'dead_letter') {
            return null;
        }
        if ($receipt->next_attempt_at !== null && $receipt->next_attempt_at->isFuture()) {
            return null;
        }
        if ($receipt->status === 'processing' && $receipt->lease_until !== null && $receipt->lease_until->isFuture()) {
            return null;
        }

        $receipt->forceFill([
            'status' => 'processing',
            'attempts' => ((int) $receipt->attempts) + 1,
            'claimed_at' => now(),
            'lease_until' => now()->addMinutes(5),
        ]);
        $receipt->save();

        return $receipt->fresh();
    }

    private function require(Actor $actor): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('outbox.relay_denied', $outcome->reason);
        }
    }
}
