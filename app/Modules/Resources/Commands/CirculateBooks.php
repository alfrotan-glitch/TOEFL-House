<?php

declare(strict_types=1);

namespace App\Modules\Resources\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Resources\Domain\ResourceLifecycle;
use App\Modules\Resources\Models\BookCopy;
use App\Modules\Resources\Models\BookIssuance;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Book custody: immutable catalog copies; one open issuance per copy;
 * return and loss (with mandatory evidence) are terminal history; stock
 * and availability are derived from issuances.
 */
final class CirculateBooks
{
    public const CAPABILITY = 'resources.books';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{copy_id: string, correlation_id: string} */
    public function addCopy(Actor $actor, string $code, string $title, string $acquiredOn, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['resources.books.add', $code, $title, $acquiredOn, $actor->actorId]));

        try {
            return $this->idempotency->execute('resources.books.add', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $code, $title, $acquiredOn): array {
                    $this->require($actor);
                    if (BookCopy::query()->where('code', $code)->exists()) {
                        throw BusinessRejection::forCode('resources.copy_code_exists', 'this copy code already exists');
                    }

                    $copy = BookCopy::query()->create([
                        'id' => RandomIdentifier::new(),
                        'code' => $code,
                        'title' => $title,
                        'acquired_on' => $acquiredOn,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'resources.books.add', 'book_copy', $copy->id, null, ['code' => $code]);

                    return ['copy_id' => $copy->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'resources.books.add', 'book_copy', $code);
        }
    }

    /** @return array{issuance_id: string, correlation_id: string} */
    public function issue(Actor $actor, BookCopy $copy, string $borrowerPersonId, string $issuedOn, string $dueOn, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['resources.books.issue', $copy->id, $borrowerPersonId, $issuedOn, $dueOn, $actor->actorId]));

        try {
            return $this->idempotency->execute('resources.books.issue', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $copy, $borrowerPersonId, $issuedOn, $dueOn): array {
                    $this->require($actor);
                    if ($dueOn < $issuedOn) {
                        throw BusinessRejection::forCode('resources.issuance_due', 'the due date precedes the issue date');
                    }

                    /** @var BookCopy $lockedCopy */
                    $lockedCopy = BookCopy::query()->whereKey($copy->id)->lockForUpdate()->firstOrFail();
                    if (BookIssuance::query()->where('copy_id', $lockedCopy->id)->where('lifecycle_state', ResourceLifecycle::ISSUANCE_ISSUED)->exists()) {
                        throw BusinessRejection::forCode('resources.copy_already_issued', 'this copy has an open issuance');
                    }
                    if (BookIssuance::query()->where('copy_id', $lockedCopy->id)->where('lifecycle_state', ResourceLifecycle::ISSUANCE_LOST)->exists()) {
                        throw BusinessRejection::forCode('resources.copy_lost', 'a lost copy is permanently out of circulation');
                    }

                    $issuance = BookIssuance::query()->create([
                        'id' => RandomIdentifier::new(),
                        'copy_id' => $lockedCopy->id,
                        'borrower_person_id' => $borrowerPersonId,
                        'issued_on' => $issuedOn,
                        'due_on' => $dueOn,
                        'lifecycle_state' => ResourceLifecycle::ISSUANCE_ISSUED,
                        'issued_by' => $actor->actorId,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'resources.books.issue', 'book_issuance', $issuance->id, null, [
                        'copy_id' => $lockedCopy->id, 'borrower' => $borrowerPersonId,
                    ]);

                    return ['issuance_id' => $issuance->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'resources.books.issue', 'book_issuance', $copy->id);
        }
    }

    /** @return array{issuance_id: string, lifecycle_state: string, correlation_id: string} */
    public function returned(Actor $actor, BookIssuance $issuance, string $returnedOn, string $idempotencyKey): array
    {
        return $this->close($actor, $issuance, ResourceLifecycle::ISSUANCE_RETURNED, $returnedOn, null, $idempotencyKey);
    }

    /** @return array{issuance_id: string, lifecycle_state: string, correlation_id: string} */
    public function reportLoss(Actor $actor, BookIssuance $issuance, string $lossEvidence, string $idempotencyKey): array
    {
        if ($lossEvidence === '') {
            throw BusinessRejection::forCode('resources.loss_evidence', 'a loss report requires evidence');
        }

        return $this->close($actor, $issuance, ResourceLifecycle::ISSUANCE_LOST, null, $lossEvidence, $idempotencyKey);
    }

    /** @return array{issuance_id: string, lifecycle_state: string, correlation_id: string} */
    private function close(Actor $actor, BookIssuance $issuance, string $toState, ?string $returnedOn, ?string $lossEvidence, string $idempotencyKey): array
    {
        $verb = $toState === ResourceLifecycle::ISSUANCE_RETURNED ? 'return' : 'loss';
        $payload = hash('sha256', implode('|', ['resources.books.'.$verb, $issuance->id, $toState, $actor->actorId]));

        try {
            return $this->idempotency->execute('resources.books.'.$verb, $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $issuance, $toState, $returnedOn, $lossEvidence): array {
                    $this->require($actor);

                    /** @var BookIssuance $locked */
                    $locked = BookIssuance::query()->whereKey($issuance->id)->lockForUpdate()->firstOrFail();
                    ResourceLifecycle::requireIssuanceTransition($locked->lifecycle_state, $toState);

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => $toState]);
                    if ($returnedOn !== null) {
                        $locked->returned_on = $returnedOn;
                    }
                    if ($lossEvidence !== null) {
                        $locked->loss_evidence = $lossEvidence;
                    }
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'resources.books.close', 'book_issuance', $locked->id, $before, ['lifecycle_state' => $toState]);

                    return ['issuance_id' => $locked->id, 'lifecycle_state' => $toState, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'resources.books.'.$verb, 'book_issuance', $issuance->id);
        }
    }

    private function require(Actor $actor): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('resources.books_denied', $outcome->reason);
        }
    }
}
