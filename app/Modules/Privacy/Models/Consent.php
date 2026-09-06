<?php

declare(strict_types=1);

namespace App\Modules\Privacy\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Subject authorization for one purpose, effective-dated with evidence.
 * Expiry and revocation stop future use; the record is never erased.
 *
 * @property string $id
 * @property string $subject_person_id
 * @property string $purpose_id
 * @property string $lifecycle_state
 * @property string $effective_from
 * @property string|null $effective_to
 * @property string $evidence_ref
 */
final class Consent extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'subject_person_id', 'purpose_id', 'lifecycle_state', 'effective_from', 'effective_to', 'evidence_ref', 'recorded_by'];

    /** @return BelongsTo<ConsentPurpose, $this> */
    public function purpose(): BelongsTo
    {
        return $this->belongsTo(ConsentPurpose::class);
    }
}
