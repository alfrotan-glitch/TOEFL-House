<?php

declare(strict_types=1);

namespace App\Modules\Payroll\Domain;

use App\Support\Errors\BusinessRejection;
use Illuminate\Support\Facades\DB;

/**
 * Payroll-owned state transition for a settlement proposal.
 *
 * Finance owns the recorded monetary settlement and authorization decision,
 * but it must not write Payroll's workflow-evidence table directly. This
 * narrow port keeps the proposal lifecycle mutation inside Payroll while the
 * caller remains responsible for the Finance settlement transaction.
 */
final class SettlementProposalApproval
{
    public function approve(string $proposalId, string $approverId): void
    {
        $updated = DB::table('settlement_proposals')
            ->where('id', $proposalId)
            ->where('lifecycle_state', 'proposed')
            ->update([
                'lifecycle_state' => 'approved',
                'approved_by' => $approverId,
                'updated_at' => now(),
            ]);

        if ($updated !== 1) {
            throw BusinessRejection::forCode(
                'payroll.settlement_proposal_closed',
                'the settlement proposal was closed before Payroll could record approval',
            );
        }
    }
}
