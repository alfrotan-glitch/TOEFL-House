<?php

declare(strict_types=1);

namespace App\Modules\Admissions\Models;

use App\Modules\Identity\Models\Person;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Admission prospect or applicant: a verified person with a program
 * interest, moving toward an admission decision.
 *
 * @property string $id
 * @property string $person_id
 * @property string $program_interest
 * @property string $lifecycle_state
 */
final class Applicant extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'person_id', 'program_interest', 'lifecycle_state', 'recorded_by'];

    /** @return BelongsTo<Person, $this> */
    public function person(): BelongsTo
    {
        return $this->belongsTo(Person::class);
    }
}
