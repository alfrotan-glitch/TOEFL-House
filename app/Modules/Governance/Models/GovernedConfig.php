<?php

declare(strict_types=1);

namespace App\Modules\Governance\Models;

use App\Support\Errors\BusinessRejection;
use Carbon\CarbonImmutable;
use Illuminate\Database\Eloquent\Model;

/**
 * An effective, versioned, audited value of a ratified governed configuration
 * key (WP-2 S1). A row is one version covering the half-open window
 * [effective_from, effective_to) — a NULL effective_to is the single OPEN
 * (active) version that runs to the present/future. Version rows are appended
 * never overwritten: retiring an OPEN version into a finite window is the only
 * permitted mutation, after which the version is immutable history. Database
 * triggers enforce type/value validity, window consistency, monotonic
 * versioning, no overlapping effective windows, one OPEN version per key, and
 * immutability behind the domain commands.
 *
 * @property string $id
 * @property string $config_key
 * @property string $config_type
 * @property int $version_no
 * @property array{v: int|string} $value
 * @property CarbonImmutable $effective_from
 * @property CarbonImmutable|null $effective_to
 * @property string|null $supersedes_id
 * @property string $lifecycle_state
 * @property string|null $review_cycle
 * @property string $approved_by
 */
final class GovernedConfig extends Model
{
    public const STATE_ACTIVE = 'active';

    public const STATE_ENDED = 'ended';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'config_key', 'config_type', 'version_no', 'value',
        'effective_from', 'effective_to', 'supersedes_id', 'lifecycle_state',
        'review_cycle', 'approved_by',
    ];

    protected $casts = [
        'value' => 'array',
        'effective_from' => 'immutable_date',
        'effective_to' => 'immutable_date',
    ];

    public function isActive(): bool
    {
        return $this->lifecycle_state === self::STATE_ACTIVE;
    }

    public function isOpen(): bool
    {
        return $this->effective_to === null;
    }

    /** The typed scalar held by the value envelope. */
    public function typedValue(): int|string
    {
        $value = $this->value['v'] ?? null;

        if (! is_int($value) && ! is_string($value)) {
            throw BusinessRejection::forCode('governance.invalid_stored_value', 'the stored governed value is not a valid typed scalar');
        }

        return $value;
    }
}
