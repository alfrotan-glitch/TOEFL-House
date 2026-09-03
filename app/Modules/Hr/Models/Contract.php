<?php

declare(strict_types=1);

namespace App\Modules\Hr\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Agreed contractual terms; signing fixes the terms and the signed terms
 * are immutable once used (schema trigger); a later contract closes this
 * one.
 *
 * @property string $id
 * @property string $employment_id
 * @property string $terms_summary
 * @property string|null $signed_ref
 * @property string $lifecycle_state
 * @property string $effective_from
 * @property string|null $effective_to
 * @property string|null $originating_branch_id
 * @property string|null $current_home_branch_id
 */
final class Contract extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'employment_id', 'terms_summary', 'signed_ref', 'lifecycle_state', 'effective_from', 'effective_to', 'signed_by', 'originating_branch_id', 'current_home_branch_id'];
}
