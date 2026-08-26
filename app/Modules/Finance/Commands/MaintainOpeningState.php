<?php

declare(strict_types=1);

namespace App\Modules\Finance\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Finance\Domain\OpeningEntryContract;
use App\Modules\Finance\Models\OpeningEntry;
use App\Modules\Finance\Models\OpeningState;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Opening financial state preparation (Finance Manager): the
 * organization's opening snapshot is created exactly once, prepared with
 * immutable opening entries while draft, then submitted for approval.
 * After approval every mutation path fails closed.
 */
final class MaintainOpeningState
{
    public const CAPABILITY = 'finance.opening.prepare';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{opening_state_id: string, correlation_id: string} */
    public function create(Actor $actor, string $organizationId, string $effectiveOn, string $openingPeriodKey, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.opening.create', $organizationId, $effectiveOn, $openingPeriodKey, $actor->actorId]));

        try {
            return $this->idempotency->execute('finance.opening.create', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $organizationId, $effectiveOn, $openingPeriodKey): array {
                    $this->require($actor);
                    if ($effectiveOn === '' || $openingPeriodKey === '') {
                        throw BusinessRejection::forCode('finance.opening_terms', 'the opening state carries its effective date and the opening period key');
                    }

                    $existing = OpeningState::query()->where('organization_id', $organizationId)->lockForUpdate()->first();
                    if ($existing !== null) {
                        if ($existing->status === OpeningState::STATUS_APPROVED) {
                            throw BusinessRejection::forCode('finance.opening_frozen', 'the approved opening state exists and can never be recreated');
                        }
                        throw BusinessRejection::forCode('finance.opening_exists', 'this organization already has its opening state');
                    }

                    $state = OpeningState::query()->create([
                        'id' => RandomIdentifier::new(),
                        'organization_id' => $organizationId,
                        'status' => OpeningState::STATUS_DRAFT,
                        'effective_on' => $effectiveOn,
                        'opening_period_key' => $openingPeriodKey,
                        'prepared_by' => $actor->actorId,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'finance.opening.create', 'opening_state', $state->id, null, [
                        'organization_id' => $organizationId, 'effective_on' => $effectiveOn, 'opening_period_key' => $openingPeriodKey,
                    ]);

                    return ['opening_state_id' => $state->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'finance.opening.create', 'opening_state', $organizationId);
        }
    }

    /** @return array{entry_id: string, correlation_id: string} */
    public function addEntry(Actor $actor, OpeningState $state, string $category, string $amount, ?string $studentId, ?string $personId, ?string $employmentId, ?string $assetAccountId, ?string $equityAccountId, string $sourceRef, string $effectiveOn, string $description, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.opening.entry', $state->id, $category, $amount, (string) $studentId, (string) $personId, (string) $employmentId, (string) $assetAccountId, (string) $equityAccountId, $sourceRef, $effectiveOn, $description, $actor->actorId]));

        try {
            return $this->idempotency->execute('finance.opening.entry', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $state, $category, $amount, $studentId, $personId, $employmentId, $assetAccountId, $equityAccountId, $sourceRef, $effectiveOn, $description): array {
                    $this->require($actor);
                    OpeningEntryContract::validateShape($category, $amount, $studentId, $personId, $employmentId, $assetAccountId, $equityAccountId);
                    if ($sourceRef === '' || $description === '' || $effectiveOn === '') {
                        throw BusinessRejection::forCode('finance.opening_evidence', 'an opening entry carries its paper source reference, description, and effective date');
                    }

                    /** @var OpeningState $locked */
                    $locked = OpeningState::query()->whereKey($state->id)->lockForUpdate()->firstOrFail();
                    if ($locked->status !== OpeningState::STATUS_DRAFT) {
                        throw BusinessRejection::forCode('finance.opening_not_draft', 'entries are recorded only while the opening state is a draft');
                    }
                    if (OpeningEntry::query()->where('opening_state_id', $locked->id)->where('source_ref', $sourceRef)->exists()) {
                        throw BusinessRejection::forCode('finance.opening_duplicate', 'this paper source reference is already recorded as an opening fact');
                    }
                    if ($studentId !== null && ! DB::table('students')->where('id', $studentId)->exists()) {
                        throw BusinessRejection::forCode('finance.opening_student_unknown', 'the referenced student does not exist');
                    }
                    if ($personId !== null && ! DB::table('people')->where('id', $personId)->exists()) {
                        throw BusinessRejection::forCode('finance.opening_person_unknown', 'the referenced person does not exist');
                    }
                    if ($employmentId !== null && ! DB::table('employments')->where('id', $employmentId)->exists()) {
                        throw BusinessRejection::forCode('finance.opening_employment_unknown', 'the referenced employment does not exist');
                    }

                    $entry = OpeningEntry::query()->create([
                        'id' => RandomIdentifier::new(),
                        'opening_state_id' => $locked->id,
                        'category' => $category,
                        'amount' => $amount,
                        'currency' => 'AFN',
                        'person_id' => $personId,
                        'student_id' => $studentId,
                        'employment_id' => $employmentId,
                        'asset_account_id' => $assetAccountId,
                        'equity_account_id' => $equityAccountId,
                        'source_ref' => $sourceRef,
                        'effective_on' => $effectiveOn,
                        'description' => $description,
                        'prepared_by' => $actor->actorId,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'finance.opening.entry', 'opening_entry', $entry->id, null, [
                        'category' => $category, 'amount' => $amount, 'source_ref' => $sourceRef,
                    ]);

                    return ['entry_id' => $entry->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'finance.opening.entry', 'opening_entry', $state->id);
        }
    }

    /** @return array{opening_state_id: string, status: string, correlation_id: string} */
    public function submit(Actor $actor, OpeningState $state, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.opening.submit', $state->id, $actor->actorId]));

        try {
            return $this->idempotency->execute('finance.opening.submit', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $state): array {
                    $this->require($actor);

                    /** @var OpeningState $locked */
                    $locked = OpeningState::query()->whereKey($state->id)->lockForUpdate()->firstOrFail();
                    if ($locked->status !== OpeningState::STATUS_DRAFT) {
                        throw BusinessRejection::forCode('finance.opening_not_draft', 'only a draft opening state can be submitted');
                    }
                    if (trim((string) $locked->prepared_by) !== $actor->actorId) {
                        throw AuthorizationDenied::forCode('finance.opening_not_preparer', 'only the preparer submits the opening state');
                    }
                    if (OpeningEntry::query()->where('opening_state_id', $locked->id)->count() === 0) {
                        throw BusinessRejection::forCode('finance.opening_empty', 'an opening state without entries cannot be submitted');
                    }

                    $locked->forceFill(['status' => OpeningState::STATUS_SUBMITTED, 'submitted_at' => now()]);
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'finance.opening.submit', 'opening_state', $locked->id, null, ['entries' => OpeningEntry::query()->where('opening_state_id', $locked->id)->count()]);

                    return ['opening_state_id' => $locked->id, 'status' => OpeningState::STATUS_SUBMITTED, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'finance.opening.submit', 'opening_state', $state->id);
        }
    }

    private function require(Actor $actor): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('finance.opening_prepare_denied', $outcome->reason);
        }
    }
}
