<?php

declare(strict_types=1);

namespace App\Modules\Students\Models;

use App\Modules\Academic\Placement\Models\PlacementProfile;
use App\Modules\Identity\Models\Person;
use App\Modules\Organization\Models\Branch;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * Student identity: exactly one per person, created only from an approved
 * admission decision inside the conversion transaction. Status lives in
 * append-only history rows.
 *
 * @property string $id
 * @property string $person_id
 * @property string $admission_decision_id
 * @property string $student_code
 * @property string|null $originating_branch_id
 * @property string|null $current_home_branch_id
 * @property string|null $placement_profile_id
 */
final class Student extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'person_id', 'admission_decision_id', 'student_code', 'originating_branch_id', 'current_home_branch_id', 'placement_profile_id'];

    /** @return HasMany<StudentStatus, $this> */
    public function statuses(): HasMany
    {
        return $this->hasMany(StudentStatus::class);
    }

    /** @return BelongsTo<Person, $this> */
    public function person(): BelongsTo
    {
        return $this->belongsTo(Person::class);
    }

    /** @return BelongsTo<Branch, $this> */
    public function originatingBranch(): BelongsTo
    {
        return $this->belongsTo(Branch::class, 'originating_branch_id');
    }

    /** @return BelongsTo<Branch, $this> */
    public function currentHomeBranch(): BelongsTo
    {
        return $this->belongsTo(Branch::class, 'current_home_branch_id');
    }

    /** @return BelongsTo<PlacementProfile, $this> */
    public function placementProfile(): BelongsTo
    {
        return $this->belongsTo(PlacementProfile::class);
    }
}
