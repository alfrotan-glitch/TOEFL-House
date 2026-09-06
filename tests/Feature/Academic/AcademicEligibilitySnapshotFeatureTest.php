<?php

declare(strict_types=1);

namespace Tests\Feature\Academic;

use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Commands\MaintainClass;
use App\Modules\Academic\Commands\MaintainEnrollment;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Placement\Commands\DecidePlacement;
use App\Modules\Academic\Placement\Models\AcademicEligibilitySnapshot;
use App\Modules\Academic\Placement\Queries\AcademicEligibilitySnapshotQuery;
use App\Modules\Academic\Placement\Queries\PlacementFinanceLinkQuery;
use App\Modules\Admissions\Commands\DecideAdmission;
use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\AdmissionDecision;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Students\Models\Student;
use App\Support\Signing\AcademicEligibilitySigner;
use Carbon\CarbonImmutable;
use Illuminate\Database\QueryException;
use Tests\Concerns\BuildsPlacementCatalog;
use Tests\Concerns\DecidesAdmissions;
use Tests\TestCase;

/**
 * AC1 signed, versioned, immutable academic eligibility snapshot:
 * release produces it, verification is deterministic, immutability is
 * enforced, and Admissions/Student/Enrollment carry the authoritative
 * reference. Finance consumption is exposed read-only through the existing
 * placement finance lineage query.
 */
final class AcademicEligibilitySnapshotFeatureTest extends TestCase
{
    use BuildsPlacementCatalog;
    use DecidesAdmissions;

    public function test_release_produces_signed_versioned_immutable_eligibility_snapshot(): void
    {
        $this->setUpPlacementCatalog();
        $person = $this->personWithAuthority('elig-snapshot-person', []);
        $profile = $this->completeReleasedPlacement($person->id, 'elig1');

        $snapshot = app(AcademicEligibilitySnapshotQuery::class)->for($profile);
        $this->assertNotNull($snapshot);
        $this->assertTrue($snapshot['verification']['valid']);
        $this->assertSame('academic-context-snapshot-v1', $snapshot['snapshot']['snapshot_schema_version']);
        $this->assertSame(1, (int) $snapshot['snapshot']['version_no']);
        $this->assertSame('hmac-sha256', $snapshot['snapshot']['signature_algorithm']);
        $this->assertSame(64, strlen((string) $snapshot['snapshot']['signature']));
        $this->assertSame($profile->id, (string) $snapshot['snapshot']['placement_profile_id']);
        $this->assertSame($profile->person_id, (string) $snapshot['snapshot']['person_id']);
        $this->assertSame($profile->released_by, (string) $snapshot['snapshot']['signed_by']);
        $this->assertSame($profile->overall_cefr_ref, $snapshot['payload']['placement']['overall_cefr_ref']);
        $this->assertNotEmpty($snapshot['payload']['recommendation']['rationale']);
        $this->assertNotEmpty($snapshot['payload']['evidence']['section_results']);
        $this->assertDatabaseHas('placement_profiles', [
            'id' => $profile->id,
            'academic_eligibility_snapshot_id' => $snapshot['snapshot']['id'],
        ]);
        $this->assertDatabaseHas('audit_events', [
            'operation' => 'placement.eligibility.snapshot',
            'target_type' => 'academic_eligibility_snapshot',
            'target_id' => $snapshot['snapshot']['id'],
        ]);

        $financeLineage = app(PlacementFinanceLinkQuery::class)->for($profile);
        $this->assertNotNull($financeLineage['eligibility_snapshot']);
        $this->assertSame($snapshot['snapshot']['id'], $financeLineage['eligibility_snapshot']['snapshot']['id']);
        $this->assertTrue($financeLineage['eligibility_snapshot']['verification']['valid']);

        $snapshotRow = AcademicEligibilitySnapshot::query()->findOrFail($snapshot['snapshot']['id']);
        $this->expectException(QueryException::class);
        $snapshotRow->forceFill(['version_no' => 99])->save();
    }

    public function test_snapshot_propagates_to_applicant_student_and_enrollment(): void
    {
        $this->setUpPlacementCatalog();
        $person = $this->personWithAuthority('elig-propagation-person', []);
        $profile = $this->completeReleasedPlacement($person->id, 'elig2');

        $registered = app(RegisterApplicant::class)->register(
            $this->admissionsClerk('elig2-clerk'),
            $person->id,
            'IELTS Preparation',
            'elig2-reg',
            $profile->id,
        );
        $applicant = Applicant::query()->findOrFail($registered['applicant_id']);
        $this->assertSame($profile->academic_eligibility_snapshot_id, (string) $applicant->academic_eligibility_snapshot_id);

        $initiated = app(DecideAdmission::class)->initiate(
            $this->admissionsClerk('elig2-initiate'),
            $applicant,
            true,
            'released placement evidence',
            'placement/'.$profile->id,
            'elig2-initiate',
        );
        $decision = AdmissionDecision::query()->findOrFail($initiated['decision_id']);
        app(DecideAdmission::class)->review($this->admissionsReviewer('elig2-review'), $decision, 'elig2-review');
        app(DecideAdmission::class)->approve($this->admissionsApprover('elig2-approve'), $decision, 'elig2-approve');
        $converted = app(EnrollAdmittedApplicant::class)->convert(
            $this->admissionsApprover('elig2-convert'),
            $applicant,
            'elig2-convert',
        );
        $student = Student::query()->findOrFail($converted['student_id']);
        $this->assertSame($profile->id, (string) $student->placement_profile_id);
        $this->assertSame($profile->academic_eligibility_snapshot_id, (string) $student->academic_eligibility_snapshot_id);

        // Active class for the enrollment consumption path.
        $officer = $this->academicOfficer('elig2-officer');
        $period = app(MaintainAcademicStructure::class)->definePeriod($officer, 'Eligibility Term', new CarbonImmutable('2026-09-01'), new CarbonImmutable('2026-12-31'), 'elig2-period');
        app(MaintainAcademicStructure::class)->transitionPeriod($officer, AcademicPeriod::query()->findOrFail($period['period_id']), 'published', 'elig2-period-pub');
        $this->personWithAuthority('elig2-teacher-1', []);
        $class = app(MaintainClass::class)->defineClass($officer, $profile->program_version_id, $period['period_id'], 10, 'elig2-class');
        app(MaintainClass::class)->assignTeacher($officer, ClassModel::query()->findOrFail($class['class_id']), 'elig2-teacher-1', new CarbonImmutable('2026-09-01'), null, 'elig2-class-teacher');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($class['class_id']), 'published', 'elig2-class-pub');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($class['class_id']), 'active', 'elig2-class-active');

        $seat = app(MaintainEnrollment::class)->request(
            $this->enrollmentClerk('elig2-enroll-clerk'),
            $student->id,
            $class['class_id'],
            'elig2-enroll',
        );
        $this->assertDatabaseHas('enrollments', [
            'id' => $seat['enrollment_id'],
            'student_id' => $student->id,
            'academic_eligibility_snapshot_id' => $profile->academic_eligibility_snapshot_id,
        ]);
    }

    public function test_retake_release_chains_a_new_snapshot(): void
    {
        $this->setUpPlacementCatalog();
        $person = $this->personWithAuthority('elig-retake-person', []);
        $first = $this->completeReleasedPlacement($person->id, 'elig3a');
        $firstSnapshot = app(AcademicEligibilitySnapshotQuery::class)->for($first);

        app(DecidePlacement::class)->supersede(
            $this->placementReleaser('elig3-supersede'),
            $first,
            'elig3-supersede',
        );

        $second = $this->completeReleasedPlacement($person->id, 'elig3b');
        $history = app(AcademicEligibilitySnapshotQuery::class)->historyForPerson($person->id);
        $this->assertCount(2, $history);

        $firstRow = AcademicEligibilitySnapshot::query()->findOrFail($firstSnapshot['snapshot']['id']);
        $secondRow = AcademicEligibilitySnapshot::query()
            ->where('placement_profile_id', $second->id)
            ->firstOrFail();
        $this->assertSame($firstRow->id, (string) $secondRow->supersedes_snapshot_id);
        $this->assertSame(1, (int) $secondRow->version_no);
        $this->assertTrue(app(AcademicEligibilitySnapshotQuery::class)->verify($secondRow)['valid']);
    }

    public function test_signature_verifier_rejects_altered_canonical_payload(): void
    {
        $this->setUpPlacementCatalog();
        $person = $this->personWithAuthority('elig-tamper-person', []);
        $profile = $this->completeReleasedPlacement($person->id, 'elig4');
        $snapshot = app(AcademicEligibilitySnapshotQuery::class)->for($profile);

        $payload = $snapshot['payload'];
        $payload['recommendation']['rationale'] = 'tampered rationale';
        $this->assertFalse(AcademicEligibilitySigner::verifyPayload($payload, (string) $snapshot['snapshot']['signature']));
    }
}
