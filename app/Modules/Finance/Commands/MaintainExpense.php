<?php

declare(strict_types=1);

namespace App\Modules\Finance\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Finance\Domain\FinanceLifecycle;
use App\Modules\Finance\Models\Account;
use App\Modules\Finance\Models\Expense;
use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Organization\Models\Branch;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Authorization\StructureScope;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use App\Support\MoneyAmount;
use Illuminate\Support\Facades\DB;

/**
 * Finance-owned operating expense (BR-FIN-00x): proposed with its supplier,
 * purpose, category, source reference, and a valid expense account; approved
 * by a distinct actor in an open financial period. An approved expense is an
 * immutable source fact and is journalized exactly once through PostJournal
 * (source_type 'expense').
 */
final class MaintainExpense
{
    public const CAPABILITY_PROPOSE = 'finance.expense';

    public const CAPABILITY_APPROVE = 'finance.expense_approve';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
        private readonly LedgerPoster $ledger,
    ) {}

    /** @return array{expense_id: string, correlation_id: string} */
    public function propose(Actor $requester, FinancialPeriod $period, string $branchId, string $supplier, string $purpose, string $category, string $sourceRef, string $amount, string $expenseAccountId, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.expense.propose', $period->id, $branchId, $supplier, $purpose, $category, $sourceRef, $amount, $expenseAccountId, $requester->actorId]));

        try {
            return $this->idempotency->execute('finance.expense.propose', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($requester, $period, $branchId, $supplier, $purpose, $category, $sourceRef, $amount, $expenseAccountId): array {
                    $this->validate($amount, $supplier, $purpose, $category, $sourceRef, $expenseAccountId);

                    /** @var FinancialPeriod $lockedPeriod */
                    $lockedPeriod = FinancialPeriod::query()->whereKey($period->id)->lockForUpdate()->firstOrFail();
                    if ($lockedPeriod->lifecycle_state !== FinanceLifecycle::PERIOD_OPEN) {
                        throw BusinessRejection::forCode('finance.period_not_open', 'expenses attach only to an open financial period');
                    }

                    $branch = $this->branch($branchId);
                    if ($branch === null || $branch->structureScope()->organizationId === '') {
                        throw BusinessRejection::forCode('finance.expense_provenance_required', 'an expense requires active branch and organization provenance');
                    }
                    $this->require($requester, self::CAPABILITY_PROPOSE, $branch->structureScope());

                    if (Expense::query()->where('originating_branch_id', $branch->id)->where('source_ref', $sourceRef)->exists()) {
                        throw BusinessRejection::forCode('finance.expense_source_exists', 'this expense source reference already exists at this branch');
                    }

                    $expense = Expense::query()->create([
                        'id' => RandomIdentifier::new(),
                        'period_id' => $lockedPeriod->id,
                        'supplier' => $supplier,
                        'purpose' => $purpose,
                        'category' => $category,
                        'amount' => $amount,
                        'source_ref' => $sourceRef,
                        'expense_account_id' => $expenseAccountId,
                        'lifecycle_state' => Expense::STATE_PROPOSED,
                        'requested_by' => $requester->actorId,
                        'originating_branch_id' => $branch->id,
                        'current_home_branch_id' => $branch->id,
                    ]);
                    $event = $this->audit->record($requester->actorId, 'finance.expense.propose', 'expense', $expense->id, null, [
                        'period_id' => $lockedPeriod->id,
                        'branch_id' => $branch->id,
                        'organization_id' => $branch->structureScope()->organizationId,
                        'supplier' => $supplier,
                        'category' => $category,
                        'amount' => $amount,
                        'source_ref' => $sourceRef,
                    ]);

                    return ['expense_id' => $expense->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $requester, 'finance.expense.propose', 'expense', $sourceRef);
        }
    }

    /** @return array{expense_id: string, lifecycle_state: string, correlation_id: string} */
    public function approve(Actor $approver, Expense $expense, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.expense.approve', $expense->id, $approver->actorId]));

        try {
            return $this->idempotency->execute('finance.expense.approve', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($approver, $expense): array {
                    /** @var Expense $locked */
                    $locked = Expense::query()->whereKey($expense->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state !== Expense::STATE_PROPOSED) {
                        throw BusinessRejection::forCode('finance.expense_not_proposed', sprintf('only a proposed expense can be approved (state: %s)', $locked->lifecycle_state));
                    }
                    if (trim((string) $locked->requested_by) === $approver->actorId) {
                        throw AuthorizationDenied::forCode('finance.expense_not_independent', 'the expense requester and approver must differ');
                    }

                    /** @var FinancialPeriod $period */
                    $period = FinancialPeriod::query()->whereKey($locked->period_id)->lockForUpdate()->firstOrFail();
                    if ($period->lifecycle_state !== FinanceLifecycle::PERIOD_OPEN) {
                        throw BusinessRejection::forCode('finance.period_not_open', 'an expense can be approved only in its open financial period');
                    }
                    $branch = $this->branch((string) ($locked->current_home_branch_id ?? $locked->originating_branch_id ?? ''));
                    if ($branch === null || $branch->structureScope()->organizationId === '') {
                        throw BusinessRejection::forCode('finance.expense_provenance_required', 'an expense requires active branch and organization provenance');
                    }
                    $this->require($approver, self::CAPABILITY_APPROVE, $branch->structureScope());

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill([
                        'lifecycle_state' => Expense::STATE_APPROVED,
                        'approved_by' => $approver->actorId,
                        'approved_at' => now(),
                    ])->save();
                    $event = $this->audit->record($approver->actorId, 'finance.expense.approve', 'expense', $locked->id, $before, [
                        'lifecycle_state' => Expense::STATE_APPROVED,
                        'branch_id' => $branch->id,
                        'organization_id' => $branch->structureScope()->organizationId,
                        'amount' => $locked->amount,
                    ]);
                    $ledger = $this->ledger->post($approver, 'expense', $locked->id);

                    return ['expense_id' => $locked->id, 'lifecycle_state' => Expense::STATE_APPROVED, 'correlation_id' => $event->correlation_id, 'journal_id' => $ledger['journal_id'], 'debit_account_id' => $ledger['debit_account_id'], 'credit_account_id' => $ledger['credit_account_id']];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $approver, 'finance.expense.approve', 'expense', $expense->id);
        }
    }

    private function validate(string $amount, string $supplier, string $purpose, string $category, string $sourceRef, string $expenseAccountId): void
    {
        if ($supplier === '' || $purpose === '' || $category === '' || $sourceRef === '') {
            throw BusinessRejection::forCode('finance.expense_terms', 'an expense requires its supplier, purpose, category, and source reference');
        }
        if (! MoneyAmount::positive($amount)) {
            throw BusinessRejection::forCode('finance.expense_amount', 'the expense amount must be a positive number');
        }
        /** @var Account|null $account */
        $account = Account::query()->whereKey($expenseAccountId)->first();
        if ($account === null || $account->type !== 'expense') {
            throw BusinessRejection::forCode('finance.expense_account_invalid', 'an expense requires a valid expense account');
        }
    }

    private function branch(string $branchId): ?Branch
    {
        $branchId = trim($branchId);
        if ($branchId === '') {
            return null;
        }
        /** @var Branch|null $branch */
        $branch = Branch::query()->whereKey($branchId)->first();

        return $branch !== null && $branch->lifecycle_state === 'active' ? $branch : null;
    }

    private function require(Actor $actor, string $capability, ?StructureScope $scope): void
    {
        $outcome = $this->access->decide($actor, $capability, $scope);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('finance.expense_denied', $outcome->reason);
        }
    }
}
