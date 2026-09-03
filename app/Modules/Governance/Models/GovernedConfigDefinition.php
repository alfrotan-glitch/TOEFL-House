<?php

declare(strict_types=1);

namespace App\Modules\Governance\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Governance boundary of the governed configuration registry (WP-2 S1). A
 * governed configuration key exists only after it is explicitly ratified here
 * with a fixed config_type. This encodes "a value becomes governed only when
 * the approved governance design identifies it": arbitrary keys are never
 * accepted, and arbitrary constants are never auto-converted. Definitions are
 * append-only and immutable (DB trigger behind the guard) — the type of a key
 * can never be silently changed under its value history.
 *
 * @property string $id
 * @property string $config_key
 * @property string $config_type
 * @property string $title
 * @property string $ratified_by
 */
final class GovernedConfigDefinition extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'config_key', 'config_type', 'title', 'ratified_by',
    ];
}
