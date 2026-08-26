<?php

declare(strict_types=1);

namespace App\Modules\Finance\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * One debit or credit leg of a journal; immutable once posted.
 *
 * @property string $id
 * @property string $journal_id
 * @property string $account_id
 * @property string $direction
 * @property string $amount
 */
final class JournalLine extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'journal_id', 'account_id', 'direction', 'amount'];
}
