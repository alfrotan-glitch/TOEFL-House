<?php

declare(strict_types=1);

namespace App\Modules\Payroll\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Claim on one delivered session as payable teaching volume: created by a
 * payroll calculation from authoritative academic evidence; unique per
 * session so a session can never be paid twice, and a claim may migrate
 * only from a superseded calculation of the same period and employment
 * (schema trigger). Append-only retained evidence.
 *
 * @property string $id
 * @property string $payroll_calculation_id
 * @property string $session_id
 * @property string $skill_id
 * @property string $scheduled_on
 * @property string $hours
 */
final class TeachingDeliveryFact extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'payroll_calculation_id', 'session_id', 'skill_id', 'scheduled_on', 'hours'];
}
