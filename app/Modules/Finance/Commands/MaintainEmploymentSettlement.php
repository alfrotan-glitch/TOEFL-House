<?php

declare(strict_types=1);

namespace App\Modules\Finance\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Finance\Models\EmploymentSettlement;
use App\Modules\Hr\Domain\EmploymentLifecycle;
use App\Modules\Hr\Models\Employment;
use App\Modules\Payroll\Domain\SettlementProposalApproval;
use App\Modules\Identity\Models\Person;
use App\Modules\Organization\Models\Branch;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use App\Support\MoneyAmount;
use Illuminate\Support\Facades\DB;

/**
 * Finance boundary for termination settlements. Payroll owns calculation
 * inputs and HR/Finance clearance evidence; Finance owns the recorded money
 * fact and its branch-scoped approval.
 */
final class MaintainEmploymentSettlement
{
    public const CAPABILITY = 'finance.employment_settlement';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
        private readonly SettlementProposalApproval $proposalApproval,
    ) {}

    /** @return array{settlement_id: string, correlation_id: string} */
    public function record(Actor $approver, Employment $employment, string $proposalId, string $amount, string $basis, string $preparedBy, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.employment_settlement.record', $employment->id, $proposalId, $amount, $basis, $preparedBy, $approver->actorId]));

        try {
            return $this->idempotency->execute('finance.employment_settlement.record', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($approver, $employment, $proposalId, $amount, $basis, $preparedBy): array {
                    if ($basis === '' || ! MoneyAmount::nonNegative($amount)) {
                        throw BusinessRejection::forCode('finance.employment_settlement_terms', 'a settlement requires a non-negative amount and evidence basis');
                    }
                    if (trim($preparedBy) === $approver->actorId) {
                        throw AuthorizationDenied::forCode('finance.employment_settlement_not_independent', 'settlement preparation and Finance approval require distinct actors');
                    }
                    $proposal = DB::table('settlement_proposals')->where('id', $proposalId)->lockForUpdate()->first();
                    if ($proposal === null || $proposal->lifecycle_state !== 'proposed'
                        || (string) $proposal->employment_id !== (string) $employment->id
                        || bccomp((string) $proposal->amount, $amount, 2) !== 0
                        || (string) $proposal->basis !== $basis
                        || (string) $proposal->prepared_by !== $preparedBy) {
                        throw BusinessRejection::forCode('finance.employment_settlement_proposal_invalid', 'Finance may record only the matching proposed Payroll settlement');
                    }

                    /** @var Employment $locked */
                    $locked = Employment::query()->whereKey($employment->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state !== EmploymentLifecycle::STATE_TERMINATED) {
                        throw BusinessRejection::forCode('finance.employment_settlement_requires_termination', 'a settlement requires terminated employment');
                    }
                    if (EmploymentSettlement::query()->where('employment_id', $locked->id)->exists()) {
                        throw BusinessRejection::forCode('finance.employment_settlement_exists', 'this employment already has a Finance settlement');
                    }
                    $person = Person::query()->whereKey($locked->person_id)->first();
                    $branchId = trim((string) ($person?->home_branch_id ?? ''));
                    $branch = $branchId === '' ? null : Branch::query()->whereKey($branchId)->first();
                    if ($branch === null || $branch->lifecycle_state !== 'active' || $branch->structureScope()->organizationId === '') {
                        throw BusinessRejection::forCode('finance.employment_settlement_provenance_required', 'a settlement requires active employee home branch and organization provenance');
                    }
                    $scope = $branch->structureScope();
                    $outcome = $this->access->decide($approver, self::CAPABILITY, $scope);
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('finance.employment_settlement_denied', $outcome->reason);
                    }
                    if (trim((string) $locked->person_id) === $approver->actorId) {
                        throw AuthorizationDenied::forCode('finance.employment_settlement_beneficiary', 'the beneficiary may not approve their own settlement');
                    }

                    $settlement = EmploymentSettlement::query()->create([
                        'id' => RandomIdentifier::new(),
                        'employment_id' => $locked->id,
                        'proposal_id' => $proposalId,
                        'amount' => $amount,
                        'basis' => $basis,
                        'prepared_by' => $preparedBy,
                        'approved_by' => $approver->actorId,
                    ]);
                    // Payroll owns proposal lifecycle state. Finance records its
                    // fact first, then asks Payroll to close the matching evidence
                    // through its application boundary; Finance never writes the
                    // Payroll table directly.
                    $this->proposalApproval->approve($proposalId, $approver->actorId);
                    $event = $this->audit->record($approver->actorId, 'finance.employment_settlement.record', 'employment_settlement', $settlement->id, null, [
                        'employment_id' => $locked->id,
                        'branch_id' => $branch->id,
                        'organization_id' => $scope->organizationId,
                        'proposal_id' => $proposalId,
                        'amount' => $amount,
                        'prepared_by' => $preparedBy,
                    ]);

                    return ['settlement_id' => $settlement->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $approver, 'finance.employment_settlement.record', 'employment_settlement', $employment->id);
        }
    }
}
