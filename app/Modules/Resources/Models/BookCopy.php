<?php

declare(strict_types=1);

namespace App\Modules\Resources\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Immutable catalog copy with originating branch/organization provenance; circulation state derived from issuances.
 * @property string $id
 * @property string|null $organization_id
 * @property string|null $originating_branch_id
 * @property string $code
 * @property string $title
 * @property string $acquired_on
 */
final class BookCopy extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'organization_id', 'originating_branch_id', 'code', 'title', 'acquired_on'];
}
