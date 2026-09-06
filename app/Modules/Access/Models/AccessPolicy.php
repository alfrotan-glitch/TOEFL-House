<?php

declare(strict_types=1);

namespace App\Modules\Access\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Versioned policy row: either a position bound to a role (grants_type
 * role) or a role granted a permission (grants_type permission, grants_id
 * null). Publishing a new version closes the overlapping open row; history
 * is retained.
 *
 * @property string $id
 * @property string $binding_type
 * @property string $binding_id
 * @property string $grants_type
 * @property string|null $grants_id
 * @property string $permission
 * @property string $effective_from
 * @property string|null $effective_to
 */
final class AccessPolicy extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'binding_type', 'binding_id', 'grants_type', 'grants_id',
        'permission', 'effective_from', 'effective_to', 'published_by',
    ];

    public const GRANTS_ROLE = 'role';

    public const GRANTS_PERMISSION = 'permission';
}
