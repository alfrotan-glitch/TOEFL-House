<?php

declare(strict_types=1);

namespace App\Modules\Academic\Placement\Models;

use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\Offering;
use App\Modules\Academic\Models\ProgramVersion;
use App\Modules\Academic\Models\ProgramVersionLevel;
use App\Modules\Identity\Models\Person;
use App\Modules\Organization\Models\Branch;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * Signed, versioned, immutable academic-context snapshot produced when a
 * Placement profile is released. The payload is the exact canonical JSON that
 * was signed; payload_sha256 and signature prove server-side integrity and
 * explainability to downstream consumers.
 *
 * @property string $id
 * @property string $placement_profile_id
 * @property string $placement_recommendation_id
 * @property string $person_id
 * @property string|null $visitor_id
 * @property string $snapshot_schema_version
 * @property int $version_no
 * @property string|null $program_version_id
 * @property string|null $recommended_level_id
 * @property string|null $recommended_class_id
 * @property string|null $recommended_offering_id
 * @property string|null $academic_period_id
 * @property string|null $originating_branch_id
 * @property string|null $current_home_branch_id
 * @property array<string, mixed> $payload
 * @property string $payload_canonical_json
 * @property string $payload_sha256
 * @property string $signature_algorithm
 * @property string $signature
 * @property string $signing_key_version
 * @property string $signed_by
 * @property Carbon $signed_at
 * @property string|null $supersedes_snapshot_id
 */
final class AcademicEligibilitySnapshot extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'placement_profile_id', 'placement_recommendation_id', 'person_id',
        'visitor_id', 'snapshot_schema_version', 'version_no', 'program_version_id',
        'recommended_level_id', 'recommended_class_id', 'recommended_offering_id',
        'academic_period_id', 'originating_branch_id', 'current_home_branch_id',
        'payload', 'payload_canonical_json', 'payload_sha256', 'signature_algorithm',
        'signature', 'signing_key_version', 'signed_by', 'signed_at',
        'supersedes_snapshot_id',
    ];

    protected $casts = [
        'payload' => 'array',
        'signed_at' => 'datetime',
        'version_no' => 'integer',
    ];

    /** @return BelongsTo<PlacementProfile, $this> */
    public function placementProfile(): BelongsTo
    {
        return $this->belongsTo(PlacementProfile::class, 'placement_profile_id');
    }

    /** @return BelongsTo<PlacementRecommendation, $this> */
    public function recommendation(): BelongsTo
    {
        return $this->belongsTo(PlacementRecommendation::class, 'placement_recommendation_id');
    }

    /** @return BelongsTo<Person, $this> */
    public function person(): BelongsTo
    {
        return $this->belongsTo(Person::class, 'person_id');
    }

    /** @return BelongsTo<ProgramVersion, $this> */
    public function programVersion(): BelongsTo
    {
        return $this->belongsTo(ProgramVersion::class, 'program_version_id');
    }

    /** @return BelongsTo<ProgramVersionLevel, $this> */
    public function recommendedLevel(): BelongsTo
    {
        return $this->belongsTo(ProgramVersionLevel::class, 'recommended_level_id');
    }

    /** @return BelongsTo<ClassModel, $this> */
    public function recommendedClass(): BelongsTo
    {
        return $this->belongsTo(ClassModel::class, 'recommended_class_id');
    }

    /** @return BelongsTo<Offering, $this> */
    public function recommendedOffering(): BelongsTo
    {
        return $this->belongsTo(Offering::class, 'recommended_offering_id');
    }

    /** @return BelongsTo<AcademicPeriod, $this> */
    public function academicPeriod(): BelongsTo
    {
        return $this->belongsTo(AcademicPeriod::class, 'academic_period_id');
    }

    /** @return BelongsTo<Branch, $this> */
    public function originatingBranch(): BelongsTo
    {
        return $this->belongsTo(Branch::class, 'originating_branch_id');
    }
}
