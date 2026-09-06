<?php

declare(strict_types=1);

namespace Tests\Unit\Architecture;

use PHPUnit\Framework\TestCase;

/**
 * Static source contracts for the Classes/Academic Classes convergence.
 * These checks inspect source only; they intentionally do not boot Laravel,
 * connect to PostgreSQL, migrate, or build the React bundle.
 */
final class AcademicClassConvergenceTest extends TestCase
{
    public function test_academic_route_mounts_the_react_classes_workspace(): void
    {
        $routes = $this->source('routes/web.php');
        $api = $this->source('routes/api.php');
        $frontend = $this->source('resources/js/app.tsx').$this->source('resources/js/academic.tsx');

        self::assertStringContainsString("Route::view('/academic', 'workspace', ['view' => 'academic'])", $routes);
        self::assertStringContainsString("Route::get('/workspace', [AcademicApiController::class, 'workspace'])", $api);
        self::assertStringContainsString("view === 'academic' ? <AcademicApp", $frontend);
        self::assertStringContainsString('server-derived lifecycle', $frontend);
        self::assertStringContainsString('Finance owns money', $frontend);
    }

    public function test_api_and_commands_share_the_canonical_class_surface(): void
    {
        $controller = $this->source('app/Http/Controllers/Api/AcademicApiController.php');
        $maintainClass = $this->source('app/Modules/Academic/Commands/MaintainClass.php');
        $enrollment = $this->source('app/Modules/Academic/Commands/MaintainEnrollment.php');
        $waitlist = $this->source('app/Modules/Academic/Commands/ManageClassWaitlist.php');
        $progression = $this->source('app/Modules/Academic/Commands/DecideProgression.php');

        foreach ([
            'workspace', 'allowed_transitions', 'claimed_seats', 'remaining_seats', 'branch_ids', 'classReadBranches', 'enrollmentClassIds',
            'MaintainClass', 'MaintainEnrollment', 'ManageClassWaitlist', 'RecordAttendance',
            'ManageAssessmentResult', 'DecideProgression', 'AssessmentResult', 'ProgressionDecision', 'lockForUpdate', 'offering_id',
            'submitAttempt', 'correctAttendance', 'transitionAssessment', 'proposeProgression', 'supersede_progression',
            'defineProgram', 'defineLevel', 'definePeriod', 'declareAvailability', 'openOffering',
            'defineRoom', 'endAssignment', 'transitionEnrollment', 'proposeGraduation',
            'issueTranscript', 'fileAppeal', 'transitionAppeal', 'supersedeByApprover', 'graduations', 'transcripts', 'appeals', 'appeal_reviewed_by',
        ] as $contract) {
            self::assertStringContainsString($contract, $controller.$maintainClass.$enrollment.$waitlist.$progression);
        }
        self::assertStringContainsString('assertSessionCanBeScheduled($lockedClass', $maintainClass);
        self::assertStringContainsString('assertCapacity($classId)', $enrollment);
        self::assertStringContainsString("whereIn('lifecycle_state', ['requested', 'active', 'frozen'])", $enrollment.$waitlist);
        self::assertStringContainsString('distinct actors', $this->source('app/Modules/Academic/Commands/DecideProgression.php'));
        self::assertStringContainsString('classBranch', $this->source('app/Modules/Academic/Domain/RecordBranch.php'));
        self::assertStringContainsString('permitted actions are capability-gated', $this->source('resources/js/academic.tsx'));
    }

    public function test_placement_json_surface_preserves_placement_and_documents_authority(): void
    {
        $routes = $this->source('routes/api.php');
        $controller = $this->source('app/Http/Controllers/Api/PlacementApiController.php');

        foreach (['MaintainPlacementCatalog', 'RegisterDocument', 'defineTest', 'publishVersion', 'attachMedia', 'cancelAttempt', 'registerReport', 'fileAppeal'] as $contract) {
            self::assertStringContainsString($contract, $routes.$controller);
        }
        self::assertStringContainsString('placement_profile', $controller);
        self::assertStringContainsString('placementProfileBranch', $this->source('app/Modules/Academic/Domain/RecordBranch.php'));
    }

    public function test_database_boundary_matches_the_live_seat_and_lifecycle_policy(): void
    {
        $migration = $this->source('database/migrations/2026_09_06_000160_converge_academic_class_authority.php');
        $period = $this->source('app/Modules/Academic/Domain/AcademicPeriodLifecycle.php');
        $class = $this->source('app/Modules/Academic/Domain/ClassLifecycle.php');

        foreach ([
            'academic_scope_branch_guard', 'academic_offering_reference_guard', 'academic_class_authority_guard',
            'academic_class_lifecycle_guard', 'academic_enrollment_capacity_guard',
            'academic_session_scope_guard', 'academic_session_identity_guard', 'academic_attendance_reference_guard', 'academic_assessment_attempt_guard',
            'academic_assessment_result_guard', 'academic_progression_decision_guard',
            'academic_offering_capacity_guard', 'academic_waitlist_reference_guard', 'academic_teacher_assignment_temporal_guard',
            'academic_graduation_decision_guard', 'academic_appeal_authority_guard', 'academic_appeals_one_open_subject', 'DROP NOT NULL', 'placement_profile',
            'new delivery classes require offering provenance', 'live seat claims',
            "'requested', 'active', 'frozen'", 'campus and organization topology', 'campus_id',
        ] as $contract) {
            self::assertStringContainsString($contract, $migration);
        }
        self::assertStringContainsString('AcademicPeriodLifecycle::requireTransition', $this->source('app/Modules/Academic/Commands/MaintainAcademicStructure.php'));
        self::assertStringContainsString('STATE_ARCHIVED', $class);
        self::assertStringContainsString('STATE_CLOSED', $period);
    }

    public function test_architecture_report_records_one_authority_and_deferred_runtime(): void
    {
        $report = $this->source('docs/architecture/review/2026-09-05-fourth-architecture-convergence.md');

        foreach ([
            'every newly-created delivery class is anchored to one open offering',
            'Requested, active and frozen are live seat claims',
            'React `AcademicApp` is the sole `/academic` interactive workspace',
            'Runtime migration/query/concurrency/browser/build verification remains unexecuted',
        ] as $contract) {
            self::assertStringContainsString($contract, $report);
        }
    }

    private function source(string $relativePath): string
    {
        $path = dirname(__DIR__, 3).DIRECTORY_SEPARATOR.$relativePath;
        $source = file_get_contents($path);

        self::assertIsString($source, $relativePath.' must be readable');

        return $source;
    }
}
