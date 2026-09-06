<?php

declare(strict_types=1);

namespace App\Modules\Hr\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Compensation rule of one contract version, addressable by
 * method + optional skill + optional scale. Per-unit rates (session or
 * hourly) share one resolution space per version and may never overlap;
 * fixed and allowance lines are additive. Rules freeze when the version
 * leaves draft (schema trigger).
 *
 * @property string $id
 * @property string $contract_version_id
 * @property string $method
 * @property string|null $skill_id
 * @property string|null $scale_id
 * @property string|null $label
 * @property string $rate
 */
final class CompensationRule extends Model
{
    public const METHOD_FIXED = 'fixed_monthly';

    public const METHOD_ALLOWANCE = 'allowance';

    public const METHOD_SESSION = 'session_rate';

    public const METHOD_HOURLY = 'hourly_rate';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'contract_version_id', 'method', 'skill_id', 'scale_id', 'label', 'rate'];
}
