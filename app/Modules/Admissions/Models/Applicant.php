<?php

declare(strict_types=1);

namespace App\Modules\Admissions\Models;

use App\Modules\Academic\Placement\Models\AcademicEligibilitySnapshot;
use App\Modules\Academic\Placement\Models\PlacementProfile;
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
 * @property string|null $placement_profile_id
 * @property string|null $academic_eligibility_snapshot_id
 */
final class Applicant extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'person_id', 'program_interest', 'lifecycle_state', 'recorded_by', 'placement_profile_id', 'academic_eligibility_snapshot_id'];

    /** @return BelongsTo<Person, $this> */
    public function person(): BelongsTo
    {
        return $this->belongsTo(Person::class);
    }

    /** @return BelongsTo<PlacementProfile, $this> */
    public function placementProfile(): BelongsTo
    {
        return $this->belongsTo(PlacementProfile::class);
    }

    /** @return BelongsTo<AcademicEligibilitySnapshot, $this> */
    public function eligibilitySnapshot(): BelongsTo
    {
        return $this->belongsTo(AcademicEligibilitySnapshot::class, 'academic_eligibility_snapshot_id');
    }
}
