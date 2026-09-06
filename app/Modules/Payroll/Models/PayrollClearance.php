<?php

declare(strict_types=1);

namespace App\Modules\Payroll\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Termination clearance from one domain (HR or Finance); both must exist
 * before a final settlement.
 *
 * @property string $id
 * @property string $employment_id
 * @property string $domain
 * @property string $note
 */
final class PayrollClearance extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'employment_id', 'domain', 'note', 'cleared_by'];
}
