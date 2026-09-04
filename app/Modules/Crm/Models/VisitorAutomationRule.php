<?php

declare(strict_types=1);

namespace App\Modules\Crm\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Deterministic CRM automation: when an interaction outcome matches the rule,
 * the domain schedules the configured follow-up in the same transaction.
 * Rules are additive and may be activated/deactivated — never silent.
 *
 * @property string $id
 * @property string $key
 * @property string $name
 * @property string $trigger_type
 * @property string $trigger_value
 * @property string $action_type
 * @property array<string, mixed> $action_config
 * @property bool $is_active
 * @property string $created_by
 */
final class VisitorAutomationRule extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'key', 'name', 'trigger_type', 'trigger_value', 'action_type',
        'action_config', 'is_active', 'created_by',
    ];

    /** @return array<string, mixed> */
    protected function casts(): array
    {
        return [
            'action_config' => 'array',
            'is_active' => 'boolean',
        ];
    }
}
