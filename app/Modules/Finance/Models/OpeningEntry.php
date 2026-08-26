<?php

declare(strict_types=1);

namespace App\Modules\Finance\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * One opening financial fact from the paper era: immutable evidence with
 * its category, amount, responsible party, source reference, and
 * effective opening date.
 *
 * @property string $id
 * @property string $category
 * @property string $amount
 */
final class OpeningEntry extends Model
{
    public const CATEGORY_STUDENT_RECEIVABLE = 'student_receivable';

    public const CATEGORY_TEACHER_SALARY_PAYABLE = 'teacher_salary_payable';

    public const CATEGORY_BOOK_RECEIVABLE = 'book_receivable';

    public const CATEGORY_OTHER_RECEIVABLE = 'other_receivable';

    public const CATEGORY_OTHER_PAYABLE = 'other_payable';

    public const CATEGORY_CASH_POSITION = 'cash_position';

    public const CATEGORIES = [
        self::CATEGORY_STUDENT_RECEIVABLE,
        self::CATEGORY_TEACHER_SALARY_PAYABLE,
        self::CATEGORY_BOOK_RECEIVABLE,
        self::CATEGORY_OTHER_RECEIVABLE,
        self::CATEGORY_OTHER_PAYABLE,
        self::CATEGORY_CASH_POSITION,
    ];

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'opening_state_id', 'category', 'amount', 'currency', 'person_id', 'student_id', 'employment_id', 'asset_account_id', 'equity_account_id', 'source_ref', 'effective_on', 'description', 'prepared_by'];

    protected $casts = ['effective_on' => 'date'];
}
