<?php

declare(strict_types=1);

namespace App\Modules\Resources\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Book issuance custody: issued, returned, or lost with evidence; one open issuance per copy. @property string $id @property string $copy_id @property string $lifecycle_state
 */
final class BookIssuance extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'copy_id', 'borrower_person_id', 'issued_on', 'due_on', 'returned_on', 'lifecycle_state', 'loss_evidence', 'issued_by'];
}
