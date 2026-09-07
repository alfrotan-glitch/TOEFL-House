<?php

declare(strict_types=1);

namespace Tests\Feature\Placement;

use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Models\Program;
use App\Modules\Academic\Placement\Commands\DecidePlacement;
use App\Modules\Academic\Placement\Commands\ManagePlacementProfile;
use App\Modules\Academic\Placement\Models\PlacementProfile;
use App\Modules\Academic\Placement\Queries\PlacementAttemptableVersionQuery;
use App\Modules\Admissions\Commands\DecideAdmission;
use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\AdmissionDecision;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Students\Models\Student;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsPlacementCatalog;
use Tests\TestCase;

/**
 * PostgreSQL boundary attacks for the Placement -> Admissions -> Student
 * evidence chain. These writes deliberately bypass command authorization and
 * audit code: the schema, not a cooperative caller, must preserve immutable
 * consumed evidence and a release must be atomic with its signed snapshot.
 */
final class PlacementEvidenceAuthorityDirectSqlTest extends TestCase
{
    use BuildsPlacementCatalog;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpPlacementCatalog();
    }

    public function test_direct_sql_cannot_reintroduce_a_legacy_question_media_pointer(): void
    {
        $questionId = array_key_first($this->questions);
        if (! is_string($questionId) || $questionId === '') {
            $this->fail('the standard placement catalog must provide a question for the raw SQL media attack');
        }

        $this->assertSqlRejected(
            fn (): int => DB::table('placement_questions')->where('id', $questionId)->update([
                'media_ref' => 'unverified://legacy-placement-media',
                'updated_at' => now(),
            ]),
            'cannot use legacy media_ref',
        );
        $this->assertNull(DB::table('placement_questions')->where('id', $questionId)->value('media_ref'));
    }

    public function test_direct_sql_cannot_start_a_program_conflicted_attempt(): void
    {
        $academic = $this->academicOfficer('plc-sql-program-academic');
        $program = app(MaintainAcademicStructure::class)->defineProgram($academic, 'Conflicting Placement Program', 'plc-sql-program');
        $otherVersion = app(MaintainAcademicStructure::class)->publishVersion(
            $academic,
            Program::query()->findOrFail($program['program_id']),
            'conflicting target',
            'plc-sql-program-version',
        );
        $person = $this->personWithAuthority('plc-sql-program-person', []);
        $profile = PlacementProfile::query()->findOrFail(app(ManagePlacementProfile::class)->openProfile(
            $this->placementOfficer('plc-sql-program-open'),
            $person->id,
            $otherVersion['version_id'],
            'plc-sql-program-open',
            null,
            $this->placementBranchId,
        )['profile_id']);

        $this->assertCount(0, app(PlacementAttemptableVersionQuery::class)->for($profile));

        // The command rejects the conflict before raw persistence. The
        // database repeats the same rule for callers that bypass the command.
        try {
            app(ManagePlacementProfile::class)->startAttempt(
                $this->placementOfficer('plc-sql-program-command'),
                $profile,
                $this->testVersionId,
                'digital',
                'plc-sql-program-command',
            );
            $this->fail('a test explicitly targeted to another program must not start');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('placement.profile_test_program_mismatch', $rejection->errorCode());
        }

        // The published test is explicitly targeted to the fixture's primary
        // program. Raw DML cannot attach it to a profile explicitly targeted
        // to another program and then derive a recommendation in the wrong
        // academic definition.
        $this->assertSqlRejected(
            fn (): bool => DB::table('placement_attempts')->insert([
                'id' => RandomIdentifier::new(),
                'profile_id' => $profile->id,
                'test_version_id' => $this->testVersionId,
                'delivery_mode' => 'digital',
                'attempt_no' => 1,
                'status' => 'in_progress',
                'lineage_version' => 'placement-evidence-v2',
                'started_at' => now(),
                'tamper_flagged' => false,
                'originating_branch_id' => $this->placementBranchId,
                'current_home_branch_id' => $this->placementBranchId,
                'correlation_id' => RandomIdentifier::new(),
                'created_at' => now(),
                'updated_at' => now(),
            ]),
            'explicit target program must agree',
        );
        $this->assertSame(0, DB::table('placement_attempts')->where('profile_id', $profile->id)->count());
    }

    public function test_direct_sql_cannot_commit_a_released_v2_profile_without_its_snapshot(): void
    {
        $person = $this->personWithAuthority('plc-sql-release-person', []);
        $approved = $this->completeApprovedPlacement($person->id, 'plc-sql-release');
        $releaser = $this->placementReleaser('plc-sql-release-actor');

        // The lifecycle transition itself is valid. It must nevertheless be
        // rolled back at commit because there is no exact signed snapshot.
        $this->assertSqlRejected(
            fn (): mixed => DB::transaction(function () use ($approved, $releaser): int {
                return DB::table('placement_profiles')
                    ->where('id', $approved->id)
                    ->update([
                        'lifecycle_state' => PlacementProfile::STATE_RELEASED,
                        'released_by' => $releaser->actorId,
                        'updated_at' => now(),
                    ]);
            }),
            'requires an exact signed v2 eligibility snapshot before commit',
        );
        $this->assertSame(PlacementProfile::STATE_APPROVED, (string) PlacementProfile::query()->findOrFail($approved->id)->lifecycle_state);

        // The authoritative command uses the intentional single transaction:
        // release -> materialize exact snapshot -> profile link. Its commit is
        // accepted by the same deferred database invariant.
        app(DecidePlacement::class)->release($releaser, $approved, 'plc-sql-release-command');
        $released = PlacementProfile::query()->findOrFail($approved->id);
        $this->assertSame(PlacementProfile::STATE_RELEASED, (string) $released->lifecycle_state);
        $this->assertNotNull($released->academic_eligibility_snapshot_id);
        $this->assertNotNull($released->released_at, 'release reporting must read an immutable event clock, never updated_at');
        $this->assertSame('database_transition', (string) $released->release_time_basis);
        $this->assertSame(PlacementProfile::DECISION_FACT_VERSION, (string) $released->decision_fact_version);
        $releasedAt = (string) $released->released_at;

        // The immutable recommendation is not merely protected while the
        // profile remains in one lifecycle state. A raw caller previously
        // could rewrite it while taking the otherwise legal release ->
        // superseded transition.
        $this->assertSqlRejected(
            fn (): int => DB::table('placement_profiles')->where('id', $released->id)->update([
                'lifecycle_state' => PlacementProfile::STATE_SUPERSEDED,
                'overall_cefr_ref' => 'C2',
                'updated_at' => now(),
            ]),
            'placement recommendation facts may be projected only once',
        );
        $this->assertSqlRejected(
            fn (): int => DB::table('placement_profiles')->where('id', $released->id)->update([
                'lifecycle_state' => PlacementProfile::STATE_SUPERSEDED,
                'released_by' => (string) $released->approved_by,
                'updated_at' => now(),
            ]),
            'placement releaser provenance may be assigned only once',
        );
        $this->assertSame(PlacementProfile::STATE_RELEASED, (string) PlacementProfile::query()->findOrFail($released->id)->lifecycle_state);

        $this->assertSqlRejected(
            fn (): int => DB::table('placement_profiles')->where('id', $released->id)->update([
                'released_at' => '2000-01-01 00:00:00',
                'release_time_basis' => 'database_transition',
                'updated_at' => now(),
            ]),
            'placement release time is immutable historical evidence',
        );
        $this->assertSqlRejected(
            fn (): int => DB::table('placement_profiles')->where('id', $released->id)->update([
                'created_at' => '2000-01-01 00:00:00',
                'updated_at' => now(),
            ]),
            'placement profile creation time is immutable reporting evidence',
        );
        app(DecidePlacement::class)->supersede($releaser, $released, 'plc-sql-release-supersede');
        $this->assertDatabaseHas('placement_profiles', [
            'id' => $released->id,
            'lifecycle_state' => PlacementProfile::STATE_SUPERSEDED,
            'released_at' => $releasedAt,
            'release_time_basis' => 'database_transition',
        ]);
    }

    public function test_direct_sql_cannot_rebind_an_applicant_or_student_to_a_later_retake(): void
    {
        $person = $this->personWithAuthority('plc-sql-link-person', []);
        $entryProfile = $this->completeReleasedPlacement($person->id, 'plc-sql-entry');
        [$applicant, $student] = $this->admittedStudent($person->id, $entryProfile, 'plc-sql-entry');

        // A valid later Placement release is deliberately a different fact.
        // It is not the evidence consumed by this admission/student record.
        app(DecidePlacement::class)->supersede(
            $this->placementReleaser('plc-sql-retake-supersede'),
            $entryProfile,
            'plc-sql-retake-supersede',
        );
        $retake = $this->completeReleasedPlacement($person->id, 'plc-sql-retake');

        $this->assertSqlRejected(
            fn (): int => DB::table('applicants')->where('id', $applicant->id)->update([
                'placement_profile_id' => $retake->id,
                'academic_eligibility_snapshot_id' => $retake->academic_eligibility_snapshot_id,
                'updated_at' => now(),
            ]),
            'applicant placement evidence is immutable',
        );
        $this->assertSqlRejected(
            fn (): int => DB::table('students')->where('id', $student->id)->update([
                'placement_profile_id' => $retake->id,
                'academic_eligibility_snapshot_id' => $retake->academic_eligibility_snapshot_id,
                'updated_at' => now(),
            ]),
            'Student placement evidence is immutable',
        );

        $this->assertDatabaseHas('applicants', [
            'id' => $applicant->id,
            'placement_profile_id' => $entryProfile->id,
            'academic_eligibility_snapshot_id' => $entryProfile->academic_eligibility_snapshot_id,
        ]);
        $this->assertDatabaseHas('students', [
            'id' => $student->id,
            'placement_profile_id' => $entryProfile->id,
            'academic_eligibility_snapshot_id' => $entryProfile->academic_eligibility_snapshot_id,
        ]);
    }

    /** @return array{0: Applicant, 1: Student} */
    private function admittedStudent(string $personId, PlacementProfile $profile, string $key): array
    {
        $registered = app(RegisterApplicant::class)->register(
            $this->admissionsClerk($key.'-clerk'),
            $personId,
            'IELTS Preparation',
            $key.'-register',
            $profile->id,
            $this->placementBranchId,
        );
        /** @var Applicant $applicant */
        $applicant = Applicant::query()->findOrFail($registered['applicant_id']);
        $initiated = app(DecideAdmission::class)->initiate(
            $this->admissionsClerk($key.'-initiate'),
            $applicant,
            true,
            'placement evidence is verified',
            'placement/'.$profile->id,
            $key.'-initiate',
        );
        /** @var AdmissionDecision $decision */
        $decision = AdmissionDecision::query()->findOrFail($initiated['decision_id']);
        app(DecideAdmission::class)->review($this->admissionsReviewer($key.'-review'), $decision, $key.'-review');
        app(DecideAdmission::class)->approve($this->admissionsApprover($key.'-approve'), $decision, $key.'-approve');
        $converted = app(EnrollAdmittedApplicant::class)->convert(
            $this->admissionsApprover($key.'-convert'),
            $applicant,
            $key.'-convert',
        );

        return [Applicant::query()->findOrFail($applicant->id), Student::query()->findOrFail($converted['student_id'])];
    }

    private function assertSqlRejected(callable $write, string $expectedMessage): void
    {
        try {
            DB::transaction(static fn (): mixed => $write());
            $this->fail('the direct SQL evidence rewrite unexpectedly succeeded');
        } catch (QueryException $exception) {
            $this->assertStringContainsString($expectedMessage, $exception->getMessage());
        }
    }
}
