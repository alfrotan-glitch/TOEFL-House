<?php

declare(strict_types=1);

namespace Tests\Unit\Architecture;

use PHPUnit\Framework\TestCase;

/**
 * Static contract checks for the Students/Admissions React migration.
 * These checks intentionally inspect source only; they do not boot Laravel,
 * connect to PostgreSQL, or build the frontend.
 */
final class StudentReactConvergenceTest extends TestCase
{
    public function test_student_web_gets_mount_the_shared_react_shell(): void
    {
        $routes = $this->source('routes/web.php');
        $workspace = $this->source('resources/views/workspace.blade.php');
        $frontend = $this->source('resources/js/app.tsx');

        self::assertStringContainsString("Route::view('/', 'workspace', ['view' => 'students', 'students_view' => 'directory'])", $routes);
        self::assertStringContainsString("Route::view('applicants', 'workspace', ['view' => 'students', 'students_view' => 'applicants'])", $routes);
        self::assertStringContainsString("Route::get('{studentId}', fn (string \$studentId) => view('workspace'", $routes);
        self::assertStringNotContainsString("Route::get('{studentId}', [StudentsController::class, 'show'])", $routes);
        self::assertStringContainsString("data-students-view=\"{{ \$students_view ?? 'directory' }}\"", $workspace);
        self::assertStringContainsString("view === 'students' ? <StudentsApp />", $frontend);
        self::assertStringContainsString('function StudentDetail(', $frontend);
    }

    public function test_students_api_exposes_canonical_lifecycle_operations(): void
    {
        $routes = $this->source('routes/api.php');
        $controller = $this->source('app/Http/Controllers/Api/StudentsApiController.php');
        $query = $this->source('app/Modules/Students/Queries/StudentLifecycleQuery.php');
        $reopen = $this->source('app/Modules/Admissions/Commands/ReopenApplicant.php');

        foreach ([
            "Route::get('/', [StudentsApiController::class, 'index'])",
            "Route::get('/{studentId}', [StudentsApiController::class, 'show'])",
            "Route::post('/applicants/{applicantId}/reopen', [StudentsApiController::class, 'reopenApplicant'])",
            "Route::post('/applicants/{applicantId}/initiate', [StudentsApiController::class, 'initiate'])",
            "Route::post('/decisions/{decisionId}/review', [StudentsApiController::class, 'review'])",
            "Route::post('/decisions/{decisionId}/approve', [StudentsApiController::class, 'approve'])",
            "Route::post('/applicants/{applicantId}/enroll', [StudentsApiController::class, 'enroll'])",
            "Route::post('/{studentId}/status/{action}', [StudentsApiController::class, 'status'])",
            "Route::post('/{studentId}/transfer', [StudentsApiController::class, 'transfer'])",
            "Route::post('/{studentId}/hold', [StudentsApiController::class, 'hold'])",
            "Route::post('/{studentId}/guardians', [StudentsApiController::class, 'guardian'])",
            "Route::post('/guardians/{relationshipId}/{action}', [StudentsApiController::class, 'guardianVerification'])",
            "Route::post('/{studentId}/communication-preference', [StudentsApiController::class, 'communicationPreference'])",
        ] as $route) {
            self::assertStringContainsString($route, $routes);
        }

        foreach (['StudentLifecycleQuery', 'MaintainGuardianRelationship', 'GuardianPermissionRegistry', 'evidence_ref', 'ReopenApplicant', 'rejection_decision_id', 'durable final rejection', 'available_status_transitions', 'guardian_relationships', 'branch_provenance', 'capabilities', 'branch_catalog', 'guardian_permission_options', 'includeFinance', 'financeObligationBranches', 'scopeFinanceRows', "orderByDesc('seq')", 'document_versions as dv', 'effective_from', 'admission'] as $contract) {
            self::assertStringContainsString($contract, $controller.$query.$reopen);
        }
    }

    public function test_student_database_boundary_carries_admission_and_lifecycle_invariants(): void
    {
        $migration = $this->source('database/migrations/2026_09_06_000158_harden_student_admissions_authority.php');
        $guardianEvidence = $this->source('database/migrations/2026_09_06_000159_harden_guardian_verification_evidence.php');
        $staging = $this->source('database/migrations/2026_08_26_000111_stage_admission_decisions.php');

        foreach (['applicants_one_open_per_person', 'students_one_per_admission_decision', 'applicants_anchor_guard', 'applicants_reapplication_guard', 'students_admission_authority_guard', 'students_require_initial_active_status', 'student_status_current_day_guard', 'student_status_transition_guard', 'student_transfer_current_day_guard', 'guardian_verification_evidence_guard'] as $contract) {
            self::assertStringContainsString($contract, $migration.$guardianEvidence);
        }
        self::assertStringContainsString('admission_decisions_finalize_applicant', $staging);
        self::assertStringContainsString('AFTER UPDATE OF lifecycle_state', $staging);
    }

    public function test_student_report_records_the_migration_and_runtime_boundary(): void
    {
        $report = $this->source('docs/architecture/review/2026-09-05-fourth-architecture-convergence.md');

        self::assertStringContainsString('### 5.13 Students, admissions, and lifecycle detail', $report);
        self::assertStringContainsString('React dispatches `StudentsApp`', $report);
        self::assertStringContainsString('runtime behavior remains unverified', $report);
        self::assertStringContainsString('Finance obligations/payments only when the actor has both concrete Finance capabilities', $report);
    }

    private function source(string $relativePath): string
    {
        $path = dirname(__DIR__, 3).DIRECTORY_SEPARATOR.$relativePath;
        $source = file_get_contents($path);

        self::assertIsString($source, $relativePath.' must be readable');

        return $source;
    }
}
