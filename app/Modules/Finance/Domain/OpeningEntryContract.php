<?php

declare(strict_types=1);

namespace App\Modules\Finance\Domain;

use App\Modules\Finance\Models\OpeningEntry;
use App\Modules\Finance\Models\OpeningState;
use App\Support\Errors\BusinessRejection;
use Illuminate\Support\Facades\DB;

/**
 * Opening-entry contract: the category decides the required shape (who
 * or what the fact binds to) and the materialization instrument. Amounts
 * stay in the certified fixed-point money representation.
 */
final class OpeningEntryContract
{
    /** @return array{category: string, amount: string, student_id: ?string, person_id: ?string, employment_id: ?string} */
    public const RECEIVABLE_CATEGORIES = [
        OpeningEntry::CATEGORY_STUDENT_RECEIVABLE,
        OpeningEntry::CATEGORY_BOOK_RECEIVABLE,
    ];

    public static function validateShape(string $category, string $amount, ?string $studentId, ?string $personId, ?string $employmentId, ?string $assetAccountId, ?string $equityAccountId): void
    {
        if (! in_array($category, OpeningEntry::CATEGORIES, true)) {
            throw BusinessRejection::forCode('finance.opening_category_unknown', sprintf('unknown opening category %s', $category));
        }
        if (! is_numeric($amount) || bccomp($amount, '0.00', 2) !== 1) {
            throw BusinessRejection::forCode('finance.opening_amount', 'an opening amount must be a positive number');
        }
        if (in_array($category, self::RECEIVABLE_CATEGORIES, true) && $studentId === null) {
            throw BusinessRejection::forCode('finance.opening_student_required', sprintf('%s binds to a student', $category));
        }
        if ($category === OpeningEntry::CATEGORY_TEACHER_SALARY_PAYABLE && $personId === null) {
            throw BusinessRejection::forCode('finance.opening_person_required', 'a teacher salary payable binds to a person');
        }
        if ($category === OpeningEntry::CATEGORY_CASH_POSITION && ($assetAccountId === null || $equityAccountId === null)) {
            throw BusinessRejection::forCode('finance.opening_cash_accounts', 'a cash position names its asset and equity accounts');
        }
    }

    /** Deterministic evidence digest over the complete entry set. */
    public static function digestFor(OpeningState $state): string
    {
        $parts = DB::table('opening_entries')
            ->where('opening_state_id', $state->id)
            ->orderBy('source_ref')
            ->get()
            ->map(fn ($entry): string => implode('|', [$entry->category, (string) $entry->amount, $entry->currency, (string) $entry->student_id, (string) $entry->person_id, (string) $entry->employment_id, (string) $entry->asset_account_id, (string) $entry->equity_account_id, $entry->source_ref, $entry->effective_on]))
            ->all();

        return hash('sha256', implode(';;', $parts));
    }
}
