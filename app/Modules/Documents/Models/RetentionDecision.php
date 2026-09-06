<?php

declare(strict_types=1);

namespace App\Modules\Documents\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Recorded retention outcome for a document under a rule: retain or
 * archive, with basis and deciding actor. Append-only.
 *
 * @property string $id
 * @property string $document_id
 * @property string $rule_id
 * @property string $action
 * @property string $basis
 * @property string $decided_by
 */
final class RetentionDecision extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'document_id', 'rule_id', 'action', 'basis', 'decided_by'];
}
