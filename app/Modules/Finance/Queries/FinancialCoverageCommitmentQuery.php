<?php

declare(strict_types=1);

namespace App\Modules\Finance\Queries;

use App\Modules\Finance\Models\EnrollmentInstallmentPlan;
use App\Modules\Finance\Models\FinancialCoverageCommitment;
use App\Modules\Finance\Models\FinancialCoverageRevocation;
use App\Modules\Finance\Models\FinancialCredit;
use App\Modules\Finance\Models\FinancialGateException;
use App\Support\MoneyAmount;

/**
 * Read model for approved enrollment-gate coverage commitments.
 *
 * A commitment is usable only when its immutable source is still valid, has
 * not been append-only revoked for future assessments, and its complete,
 * source-total allocation can be demonstrated. This deliberately excludes
 * pre-materialization/legacy source rows rather than guessing which
 * obligation they covered. Monetary truth continues to come exclusively from
 * FinancialBalanceQuery; this query is only the attributed gate-authorization
 * layer consumed by FinancialGateQuery and coverage approval commands.
 */
final class FinancialCoverageCommitmentQuery
{
    /**
     * Returns all currently usable commitments for a student's full obligation
     * set, without applying an enrollment target scope. This is used only
     * while Finance materializes a newly approved source under the canonical
     * student lock.
     *
     * @param list<string> $obligationIds
     * @return list<FinancialCoverageCommitment>
     */
    public function activeForCoverageAllocation(array $obligationIds, string $asOf): array
    {
        return $this->active($obligationIds, $asOf, null, null, false, false);
    }

    /**
     * Returns commitments whose source is valid for the exact enrollment
     * target. A scoped plan or exception cannot satisfy another offering or
     * class merely because the student has unrelated debt.
     *
     * @param list<string> $obligationIds
     * @return list<FinancialCoverageCommitment>
     */
    public function activeForEnrollment(array $obligationIds, ?string $offeringId, ?string $classId, string $asOf): array
    {
        return $this->active($obligationIds, $asOf, $this->nullableId($offeringId), $this->nullableId($classId), true, false);
    }

    /**
     * Generic student clearance has no enrollment target. Only genuinely
     * student-wide sources can clear it; offering/class-specific plans and
     * exceptions remain limited to their declared enrollment scope.
     *
     * @param list<string> $obligationIds
     * @return list<FinancialCoverageCommitment>
     */
    public function activeForStudentClearance(array $obligationIds, string $asOf): array
    {
        return $this->active($obligationIds, $asOf, null, null, false, true);
    }

    /**
     * @param list<string> $obligationIds
     * @return list<FinancialCoverageCommitment>
     */
    private function active(array $obligationIds, string $asOf, ?string $offeringId, ?string $classId, bool $forEnrollment, bool $studentClearance): array
    {
        $obligationIds = array_values(array_unique(array_filter(array_map('strval', $obligationIds), static fn (string $id): bool => trim($id) !== '')));
        if ($obligationIds === []) {
            return [];
        }

        /** @var list<FinancialCoverageCommitment> $candidates */
        $candidates = FinancialCoverageCommitment::query()
            ->whereIn('obligation_id', $obligationIds)
            ->orderBy('coverage_source_type')
            ->orderBy('coverage_source_id')
            ->orderBy('obligation_id')
            ->orderBy('id')
            ->get()
            ->all();
        if ($candidates === []) {
            return [];
        }

        $sourceIdsByType = [
            FinancialCoverageCommitment::SOURCE_FINANCIAL_CREDIT => [],
            FinancialCoverageCommitment::SOURCE_INSTALLMENT_PLAN => [],
            FinancialCoverageCommitment::SOURCE_GATE_EXCEPTION => [],
        ];
        foreach ($candidates as $candidate) {
            if (array_key_exists($candidate->coverage_source_type, $sourceIdsByType)) {
                $sourceIdsByType[$candidate->coverage_source_type][] = (string) $candidate->coverage_source_id;
            }
        }
        foreach ($sourceIdsByType as $type => $ids) {
            $sourceIdsByType[$type] = array_values(array_unique($ids));
        }

        $credits = $sourceIdsByType[FinancialCoverageCommitment::SOURCE_FINANCIAL_CREDIT] === []
            ? []
            : FinancialCredit::query()
                ->whereIn('id', $sourceIdsByType[FinancialCoverageCommitment::SOURCE_FINANCIAL_CREDIT])
                ->where('lifecycle_state', FinancialCredit::STATE_APPROVED)
                ->get()
                ->keyBy('id')
                ->all();
        $plans = $sourceIdsByType[FinancialCoverageCommitment::SOURCE_INSTALLMENT_PLAN] === []
            ? []
            : EnrollmentInstallmentPlan::query()
                ->whereIn('id', $sourceIdsByType[FinancialCoverageCommitment::SOURCE_INSTALLMENT_PLAN])
                ->where('lifecycle_state', EnrollmentInstallmentPlan::STATE_APPROVED)
                ->get()
                ->keyBy('id')
                ->all();
        $exceptions = $sourceIdsByType[FinancialCoverageCommitment::SOURCE_GATE_EXCEPTION] === []
            ? []
            : FinancialGateException::query()
                ->whereIn('id', $sourceIdsByType[FinancialCoverageCommitment::SOURCE_GATE_EXCEPTION])
                ->where('lifecycle_state', FinancialGateException::STATE_APPROVED)
                ->where('effective_from', '<=', $asOf)
                ->where(function ($query) use ($asOf): void {
                    $query->whereNull('effective_to')->orWhere('effective_to', '>=', $asOf);
                })
                ->get()
                ->keyBy('id')
                ->all();

        // Validate source-total completeness across every commitment of each
        // source, not just the obligations selected by this particular read.
        // A malformed/partial source is unusable rather than silently treated
        // as spare authorization for a different student or gate context.
        $allSourceIds = array_values(array_unique(array_merge(
            $sourceIdsByType[FinancialCoverageCommitment::SOURCE_FINANCIAL_CREDIT],
            $sourceIdsByType[FinancialCoverageCommitment::SOURCE_INSTALLMENT_PLAN],
            $sourceIdsByType[FinancialCoverageCommitment::SOURCE_GATE_EXCEPTION],
        )));
        $revoked = [];
        if ($allSourceIds !== []) {
            foreach (FinancialCoverageRevocation::query()
                ->whereIn('coverage_source_type', array_keys($sourceIdsByType))
                ->whereIn('coverage_source_id', $allSourceIds)
                ->where('lifecycle_state', FinancialCoverageRevocation::STATE_RECORDED)
                ->get() as $revocation) {
                $revoked[$this->sourceKey((string) $revocation->coverage_source_type, (string) $revocation->coverage_source_id)] = true;
            }
        }

        /** @var list<FinancialCoverageCommitment> $allSourceCommitments */
        $allSourceCommitments = FinancialCoverageCommitment::query()
            ->whereIn('coverage_source_type', array_keys($sourceIdsByType))
            ->whereIn('coverage_source_id', $allSourceIds)
            ->get()
            ->all();
        $totals = [];
        foreach ($allSourceCommitments as $commitment) {
            $key = $this->sourceKey($commitment->coverage_source_type, (string) $commitment->coverage_source_id);
            try {
                $totals[$key] = bcadd($totals[$key] ?? '0.00', MoneyAmount::decimal($commitment->amount), 2);
            } catch (\InvalidArgumentException) {
                // A malformed raw row must never become usable gate evidence.
                $totals[$key] = null;
            }
        }

        $active = [];
        foreach ($candidates as $candidate) {
            $type = (string) $candidate->coverage_source_type;
            $id = (string) $candidate->coverage_source_id;
            $source = match ($type) {
                FinancialCoverageCommitment::SOURCE_FINANCIAL_CREDIT => $credits[$id] ?? null,
                FinancialCoverageCommitment::SOURCE_INSTALLMENT_PLAN => $plans[$id] ?? null,
                FinancialCoverageCommitment::SOURCE_GATE_EXCEPTION => $exceptions[$id] ?? null,
                default => null,
            };
            if (isset($revoked[$this->sourceKey($type, $id)])
                || $source === null
                || ! $this->isComplete($type, $id, $source, $totals)) {
                continue;
            }
            if (! $this->appliesToContext($type, $source, $offeringId, $classId, $forEnrollment, $studentClearance)) {
                continue;
            }
            try {
                if (! MoneyAmount::positive(MoneyAmount::decimal($candidate->amount))) {
                    continue;
                }
            } catch (\InvalidArgumentException) {
                continue;
            }

            $active[] = $candidate;
        }

        return $active;
    }

    /** @param FinancialCredit|EnrollmentInstallmentPlan|FinancialGateException $source */
    private function isComplete(string $type, string $sourceId, FinancialCredit|EnrollmentInstallmentPlan|FinancialGateException $source, array $totals): bool
    {
        $total = $totals[$this->sourceKey($type, $sourceId)] ?? null;
        if (! is_string($total)) {
            return false;
        }

        try {
            return bccomp($total, MoneyAmount::decimal($source->amount), 2) === 0;
        } catch (\InvalidArgumentException) {
            return false;
        }
    }

    /** @param EnrollmentInstallmentPlan|FinancialGateException|FinancialCredit $source */
    private function appliesToContext(string $type, FinancialCredit|EnrollmentInstallmentPlan|FinancialGateException $source, ?string $offeringId, ?string $classId, bool $forEnrollment, bool $studentClearance): bool
    {
        if ($type === FinancialCoverageCommitment::SOURCE_FINANCIAL_CREDIT) {
            return true;
        }

        if ($type === FinancialCoverageCommitment::SOURCE_INSTALLMENT_PLAN) {
            /** @var EnrollmentInstallmentPlan $source */
            $sourceOfferingId = $this->nullableId($source->offering_id);
            if ($studentClearance) {
                return $sourceOfferingId === null;
            }

            return ! $forEnrollment || $sourceOfferingId === null || $sourceOfferingId === $offeringId;
        }

        /** @var FinancialGateException $source */
        $sourceOfferingId = $this->nullableId($source->offering_id);
        $sourceClassId = $this->nullableId($source->class_id);
        if ($studentClearance) {
            return $sourceOfferingId === null && $sourceClassId === null;
        }

        return ! $forEnrollment
            || (($sourceOfferingId === null || $sourceOfferingId === $offeringId)
                && ($sourceClassId === null || $sourceClassId === $classId));
    }

    private function sourceKey(string $type, string $id): string
    {
        return $type.'|'.$id;
    }

    private function nullableId(?string $id): ?string
    {
        $id = trim((string) $id);

        return $id === '' ? null : $id;
    }
}
