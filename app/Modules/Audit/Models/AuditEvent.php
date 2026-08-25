<?php

declare(strict_types=1);

namespace App\Modules\Audit\Models;

use App\Support\Errors\BusinessRejection;
use Illuminate\Database\Eloquent\Model;

/**
 * Append-only material evidence of the audit contract. Rows are written in
 * the same owning transaction as the fact they evidence and can never be
 * rewritten; the database trigger adds structural protection behind the
 * application guard.
 *
 * @property string $id
 * @property string $actor_id
 * @property string $operation
 * @property string $target_type
 * @property string $target_id
 * @property string $correlation_id
 * @property array<string, mixed>|null $before_state
 * @property array<string, mixed>|null $after_state
 */
final class AuditEvent extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'actor_id', 'operation', 'target_type', 'target_id',
        'correlation_id', 'before_state', 'after_state', 'occurred_at',
    ];

    protected $casts = [
        'before_state' => 'array',
        'after_state' => 'array',
    ];

    public $timestamps = false;

    /** Mutation of recorded evidence is a business rejection, not a silent rewrite. */
    public function save(array $options = []): bool
    {
        if ($this->exists) {
            throw BusinessRejection::forCode('audit.immutable', 'audit evidence is append-only');
        }

        return parent::save($options);
    }

    public function delete(): bool
    {
        throw BusinessRejection::forCode('audit.immutable', 'audit evidence is append-only');
    }

    public function forceDelete(): bool
    {
        throw BusinessRejection::forCode('audit.immutable', 'audit evidence is append-only');
    }
}
