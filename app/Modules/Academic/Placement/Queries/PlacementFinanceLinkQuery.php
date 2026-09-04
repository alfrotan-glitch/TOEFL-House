<?php

declare(strict_types=1);

namespace App\Modules\Academic\Placement\Queries;

use App\Modules\Academic\Placement\Models\PlacementProfile;
use Illuminate\Support\Facades\DB;

/**
 * Read-side finance lineage for a placement profile: obligations and
 * payments belonging to the same person (via the student record). Placement
 * never creates or modifies Finance facts; this query only exposes the
 * Finance-authoritative records for the placement decision UI.
 */
final class PlacementFinanceLinkQuery
{
    /** @return array<string, mixed> */
    public function for(PlacementProfile $profile): array
    {
        $studentId = DB::table('students')->where('person_id', $profile->person_id)->value('id');
        if ($studentId === null) {
            return ['person_id' => $profile->person_id, 'student_id' => null, 'obligations' => [], 'payments' => []];
        }

        $obligations = DB::table('obligations')
            ->where('student_id', $studentId)
            ->orderByDesc('created_at')
            ->limit(50)
            ->get(['id', 'student_id', 'source', 'original_amount', 'reason', 'created_at']);

        $payments = DB::table('payments')
            ->where('student_id', $studentId)
            ->orderByDesc('created_at')
            ->limit(50)
            ->get(['id', 'student_id', 'amount', 'method', 'payer_ref', 'received_on', 'created_at']);

        return [
            'person_id' => $profile->person_id,
            'student_id' => $studentId,
            'obligations' => $obligations,
            'payments' => $payments,
        ];
    }
}
