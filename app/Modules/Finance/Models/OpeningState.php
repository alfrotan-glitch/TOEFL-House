<?php

declare(strict_types=1);

namespace App\Modules\Finance\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * The organization's single opening financial snapshot: draft → submitted
 * → approved, created once, immutable after approval.
 *
 * @property string $id
 * @property string $status
 */
final class OpeningState extends Model
{
    public const STATUS_DRAFT = 'draft';

    public const STATUS_SUBMITTED = 'submitted';

    public const STATUS_APPROVED = 'approved';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'organization_id', 'status', 'effective_on', 'opening_period_key', 'prepared_by', 'submitted_at', 'approved_by', 'approved_at', 'approval_digest'];

    protected $casts = ['effective_on' => 'date', 'submitted_at' => 'datetime', 'approved_at' => 'datetime'];
}
