<?php

declare(strict_types=1);

namespace Tests\Feature\Academic;

use App\Modules\Academic\Commands\DecideGraduation;
use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Commands\MaintainClass;
use App\Modules\Academic\Commands\MaintainEnrollment;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\Certificate;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\GraduationDecision;
use App\Modules\Academic\Models\Program;
use App\Modules\Audit\Models\AuditEvent as AuditEventModel;
use App\Modules\Documents\Commands\DefineDocumentClassification;
use App\Modules\Documents\Commands\TransitionDocument;
use App\Modules\Documents\Models\Document;
use App\Modules\Finance\Commands\PostObligation;
use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Identity\Models\UserAccount;
use App\Modules\Students\Commands\TransitionStudentStatus;
use App\Modules\Students\Models\Student;
use App\Modules\Students\Queries\StudentRecordQuery;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsStudents;
use Tests\TestCase;

/**
 * AC6 graduation integrity: eligible approval requires closed seats,
 * issuance re-checks at the point of no return, every certificate becomes a
 * governed document with read-only Finance clearance visibility, and alumni
 * status is reachable only through the governed chain.
 */
final class GraduationIntegrityFeatureTest extends TestCase
{
    use BuildsStudents;

    private string $programVersionId;

    private string $periodId;

    private string $classId;

    protected function setUp(): void
    {
        parent::setUp();
        $this->personWithAuthority('grad-teacher-1', []);
        $structure = app(MaintainAcademicStructure::class);
        $officer = $this->academicOfficer('grad-officer');

        $program = $structure->defineProgram($officer, 'Graduation Program', 'grad-prog');
        $this->programVersionId = (string) $structure->publishVersion($officer, Program::query()->findOrFail($program['program_id']), 'Graduation v1', 'grad-ver')['version_id'];
        $this->periodId = (string) $structure->definePeriod($officer, 'Graduation Term', new CarbonImmutable('2026-09-01'), new CarbonImmutable('2026-12-31'), 'grad-period')['period_id'];
        $structure->transitionPeriod($officer, AcademicPeriod::query()->findOrFail($this->periodId), 'published', 'grad-period-pub');

        $this->classId = (string) app(MaintainClass::class)->defineClass($officer, $this->programVersionId, $this->periodId, 10, 'grad-class', null)['class_id'];
        app(MaintainClass::class)->assignTeacher($officer, ClassModel::query()->findOrFail($this->classId), 'grad-teacher-1', new CarbonImmutable('2026-09-01'), null, 'grad-class-teacher');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($this->classId), 'published', 'grad-class-pub');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($this->classId), 'active', 'grad-class-active');
    }

    public function test_eligible_approval_refuses_open_seats_while_not_eligible_is_exempt(): void
    {
        [$studentId] = $this->activeSeatWithId('open');

        $eligible = $this->reviewedDecision('open', $studentId, 'eligible');
        try {
            app(DecideGraduation::class)->approve($this->gradApprover('open'), GraduationDecision::query()->findOrFail($eligible), 'grad-open-approve');
            $this->fail('an eligible approval with an open seat must be refused');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.graduation_open_seats', $rejection->errorCode());
        }

        [$otherStudentId] = $this->activeSeatWithId('exempt');
        $exempt = $this->reviewedDecision('exempt', $otherStudentId, 'not_eligible');
        $approved = app(DecideGraduation::class)->approve($this->gradApprover('exempt'), GraduationDecision::query()->findOrFail($exempt), 'grad-exempt-approve');
        $this->assertSame('approved', $approved['lifecycle_state']);
    }

    public function test_eligible_approval_succeeds_once_seats_are_terminal(): void
    {
        [$studentId, $seatId] = $this->activeSeatWithId('terminal', $this->classId, 'grad-terminal');
        app(MaintainEnrollment::class)->withdraw($this->enrollmentClerk('grad-clerk-terminal'), Enrollment::query()->findOrFail($seatId), 'family relocation verified', 'grad-terminal-wd');

        $decisionId = $this->reviewedDecision('terminal', $studentId, 'eligible');
        $approved = app(DecideGraduation::class)->approve($this->gradApprover('terminal'), GraduationDecision::query()->findOrFail($decisionId), 'grad-terminal-approve');
        $this->assertSame('approved', $approved['lifecycle_state']);
    }

    public function test_issuance_rechecks_open_seats_at_the_point_of_no_return(): void
    {
        $studentId = $this->makeStudentId('stale');
        $decisionId = $this->approvedEligible('stale', $studentId);
        $this->defineClassification('stale');

        // A seat opened after the approval: the approval went stale.
        $this->activeSeatFor('stale-seat', $studentId, $this->classId);

        try {
            app(DecideGraduation::class)->issueCertificate($this->certifier('stale'), GraduationDecision::query()->findOrFail($decisionId), 'grad-stale-issue');
            $this->fail('issuance with a newly opened seat must be refused');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.graduation_open_seats', $rejection->errorCode());
        }
        $this->assertSame(0, Certificate::query()->where('graduation_decision_id', $decisionId)->count());
    }

    public function test_issuance_requires_the_certificate_classification(): void
    {
        $decisionId = $this->approvedEligible('noclass', $this->makeStudentId('noclass'));

        try {
            app(DecideGraduation::class)->issueCertificate($this->certifier('noclass'), GraduationDecision::query()->findOrFail($decisionId), 'grad-noclass-issue');
            $this->fail('issuance without the document classification must fail closed');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.certificate_classification_missing', $rejection->errorCode());
        }
    }

    public function test_issuance_registers_and_submits_the_certificate_document(): void
    {
        $studentId = $this->makeStudentId('doc');
        $decisionId = $this->approvedEligible('doc', $studentId);
        $this->defineClassification('doc');

        $issued = app(DecideGraduation::class)->issueCertificate($this->certifier('doc'), GraduationDecision::query()->findOrFail($decisionId), 'grad-doc-issue');
        $replay = app(DecideGraduation::class)->issueCertificate($this->certifier('doc'), GraduationDecision::query()->findOrFail($decisionId), 'grad-doc-issue');
        $this->assertSame($issued, $replay);
        $this->assertDatabaseHas('certificates', [
            'id' => $issued['certificate_id'],
            'document_id' => $issued['document_id'],
        ]);

        /** @var Document $document */
        $document = Document::query()->findOrFail($issued['document_id']);
        $this->assertSame('submitted', $document->lifecycle_state);
        $this->assertSame($issued['serial'], $document->title);
        $this->assertSame((string) Student::query()->findOrFail($studentId)->person_id, (string) $document->subject_person_id);
        $this->assertSame(1, Document::query()->where('id', $issued['document_id'])->count(), 'idempotent replay issues no second document');

        /** @var AuditEventModel $event */
        $event = AuditEventModel::query()
            ->where('operation', 'academic.certificate.issue')
            ->where('target_id', $issued['certificate_id'])
            ->firstOrFail();
        $this->assertSame($issued['document_id'], $event->after_state['document_id']);
        $this->assertTrue((bool) $event->after_state['finance_clearance']['satisfied']);
        $this->assertSame('0.00', $event->after_state['finance_clearance']['remaining']);
    }

    public function test_clearance_snapshot_reflects_debt_without_refusing_issuance(): void
    {
        $studentId = $this->makeStudentId('debt');
        $decisionId = $this->approvedEligible('debt', $studentId);
        $this->defineClassification('debt');

        $period = $this->openPeriod('debt');
        $poster = $this->grantedActor('grad-obligation-debt', ['finance.obligation']);
        app(PostObligation::class)->post($poster, $period, $studentId, 'admissions/tuition', 'Graduation tuition', [
            ['category' => 'tuition', 'amount' => '1000.00', 'source_ref' => 'grad-tuition-debt'],
        ], 'grad-obligation-debt');

        // No ratified rule refuses graduation on debt: the signed visibility
        // is recorded and issuance still succeeds.
        $issued = app(DecideGraduation::class)->issueCertificate($this->certifier('debt'), GraduationDecision::query()->findOrFail($decisionId), 'grad-debt-issue');

        /** @var AuditEventModel $event */
        $event = AuditEventModel::query()
            ->where('operation', 'academic.certificate.issue')
            ->where('target_id', $issued['certificate_id'])
            ->firstOrFail();
        $this->assertFalse((bool) $event->after_state['finance_clearance']['satisfied']);
        $this->assertSame('1000.00', $event->after_state['finance_clearance']['remaining']);
        $this->assertArrayHasKey('signature', $event->after_state['finance_clearance']);
    }

    public function test_issuer_without_documents_capability_is_denied_and_issues_nothing(): void
    {
        $decisionId = $this->approvedEligible('sod', $this->makeStudentId('sod'));
        $this->defineClassification('sod');
        $issuer = $this->grantedActor('grad-cert-sod', ['academic.certify']);

        try {
            app(DecideGraduation::class)->issueCertificate($issuer, GraduationDecision::query()->findOrFail($decisionId), 'grad-sod-issue');
            $this->fail('issuance without the documents capability must be denied');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('documents.register_denied', $denial->errorCode());
        }
        $this->assertSame(0, Certificate::query()->where('graduation_decision_id', $decisionId)->count());
    }

    public function test_issuer_cannot_self_verify_but_the_registrar_can(): void
    {
        $decisionId = $this->approvedEligible('verify', $this->makeStudentId('verify'));
        $this->defineClassification('verify');
        $issuer = $this->certifier('verify');

        $issued = app(DecideGraduation::class)->issueCertificate($issuer, GraduationDecision::query()->findOrFail($decisionId), 'grad-verify-issue');

        try {
            app(TransitionDocument::class)->verify($issuer, Document::query()->findOrFail($issued['document_id']), true, 'self approval', 'grad-verify-self');
            $this->fail('the issuer holds no verification capability');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('documents.verify_denied', $denial->errorCode());
        }

        $registrar = $this->grantedActor('grad-registrar-verify', ['documents.verify']);
        $verified = app(TransitionDocument::class)->verify($registrar, Document::query()->findOrFail($issued['document_id']), true, 'serial matches the issuance record', 'grad-verify-ok');
        $this->assertSame('verified', $verified['lifecycle_state']);
        $activated = app(TransitionDocument::class)->activate($registrar, Document::query()->findOrFail($issued['document_id']), 'grad-activate-ok');
        $this->assertSame('active', $activated['lifecycle_state']);
    }

    public function test_alumni_requires_the_decision_then_the_certificate(): void
    {
        $manager = $this->studentManager('grad-mgr-alumni');
        $studentId = $this->makeStudentId('alumni');
        app(TransitionStudentStatus::class)->complete($manager, Student::query()->findOrFail($studentId), 'program finished', 'grad-alumni-complete');

        try {
            app(TransitionStudentStatus::class)->graduate($manager, Student::query()->findOrFail($studentId), 'certified', 'grad-alumni-no-decision');
            $this->fail('alumni without a graduation decision must be refused');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('students.graduation_decision_required', $rejection->errorCode());
        }

        $decisionId = $this->approvedEligible('alumni', $studentId);
        try {
            app(TransitionStudentStatus::class)->graduate($manager, Student::query()->findOrFail($studentId), 'certified', 'grad-alumni-no-cert');
            $this->fail('alumni without the issued certificate must be refused');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('students.graduation_certificate_required', $rejection->errorCode());
        }

        $this->defineClassification('alumni');
        app(DecideGraduation::class)->issueCertificate($this->certifier('alumni'), GraduationDecision::query()->findOrFail($decisionId), 'grad-alumni-issue');
        $graduated = app(TransitionStudentStatus::class)->graduate($manager, Student::query()->findOrFail($studentId), 'certified', 'grad-alumni-ok');
        $this->assertSame('alumni', $graduated['status']);
        $this->assertSame('alumni', (new StudentRecordQuery)->studentRecord($studentId)['status']);

        try {
            app(TransitionStudentStatus::class)->reactivate($this->studentReactivator('grad-react-alumni'), Student::query()->findOrFail($studentId), 'no return from alumni', 'grad-alumni-react');
            $this->fail('alumni remains terminal');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('students.transition_forbidden', $rejection->errorCode());
        }
    }

    public function test_graduation_chain_over_http(): void
    {
        $studentId = $this->makeStudentId('web');
        $decisionId = $this->approvedEligible('web', $studentId);
        $this->defineClassification('web');

        $issuer = $this->personWithAuthority('grad.web.issuer', ['academic.certify', 'documents.register']);
        $this->signInAs($issuer->id, 'grad.web.issuer');
        $this->post("/academic/graduations/{$decisionId}/certificate")->assertRedirect();
        $certificateId = (string) Certificate::query()->where('graduation_decision_id', $decisionId)->value('id');
        $this->assertNotSame('', $certificateId);
        $this->assertSame('submitted', (string) Document::query()->where('id', Certificate::query()->findOrFail($certificateId)->document_id)->value('lifecycle_state'));

        $manager = $this->personWithAuthority('grad.web.manager', ['students.manage']);
        $this->signInAs($manager->id, 'grad.web.manager');
        $this->post("/students/students/{$studentId}/status/complete", ['reason' => 'web program finished'])->assertRedirect();
        $this->post("/students/students/{$studentId}/status/graduate", ['reason' => 'web certified'])->assertRedirect();
        $this->assertSame('alumni', (new StudentRecordQuery)->studentRecord($studentId)['status']);
    }

    private function signInAs(string $personId, string $username): void
    {
        UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $personId,
            'username' => $username,
            'password_hash' => Hash::make('graduation-pw-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);
        $this->post('/login', ['username' => $username, 'password' => 'graduation-pw-1'])->assertRedirect('/');
    }

    private function makeStudentId(string $seed): string
    {
        return (string) $this->makeStudent([
            'initiator' => 'grad-adm-init-'.$seed,
            'reviewer' => 'grad-adm-review-'.$seed,
            'approver' => 'grad-adm-approve-'.$seed,
        ])['student']->id;
    }

    private function activeSeatFor(string $seed, string $studentId, string $classId): string
    {
        $requested = app(MaintainEnrollment::class)->request($this->enrollmentClerk('grad-clerk-'.$seed), $studentId, $classId, 'grad-enroll-'.$seed);
        app(MaintainEnrollment::class)->activate($this->academicOfficer('grad-approver-seat-'.$seed), Enrollment::query()->findOrFail($requested['enrollment_id']), 'grad-activate-'.$seed);

        return $requested['enrollment_id'];
    }

    /** @return array{0: string, 1: string} */
    private function activeSeatWithId(string $seed): array
    {
        $studentId = $this->makeStudentId($seed);

        return [$studentId, $this->activeSeatFor($seed, $studentId, $this->classId)];
    }

    private function reviewedDecision(string $seed, string $studentId, string $outcome): string
    {
        $proposed = app(DecideGraduation::class)->propose(
            $this->grantedActor('grad-proposer-'.$seed, ['academic.completion']),
            $studentId,
            $this->programVersionId,
            $outcome,
            'program requirements verified',
            'grad-propose-'.$seed,
        );
        app(DecideGraduation::class)->review(
            $this->grantedActor('grad-reviewer-'.$seed, ['academic.completion']),
            GraduationDecision::query()->findOrFail($proposed['decision_id']),
            'grad-review-'.$seed,
        );

        return $proposed['decision_id'];
    }

    private function approvedEligible(string $seed, string $studentId): string
    {
        $decisionId = $this->reviewedDecision($seed, $studentId, 'eligible');
        app(DecideGraduation::class)->approve($this->gradApprover($seed), GraduationDecision::query()->findOrFail($decisionId), 'grad-approve-'.$seed);

        return $decisionId;
    }

    private function gradApprover(string $seed): Actor
    {
        return $this->grantedActor('grad-approver-'.$seed, ['academic.completion_approve']);
    }

    private function certifier(string $seed): Actor
    {
        return $this->grantedActor('grad-certifier-'.$seed, ['academic.certify', 'documents.register']);
    }

    private function defineClassification(string $seed): void
    {
        app(DefineDocumentClassification::class)->defineClassification(
            $this->grantedActor('grad-classifier-'.$seed, ['documents.classify']),
            'academic.certificate',
            'academic',
            'restricted',
            'grad-classification-'.$seed,
        );
    }

    private function openPeriod(string $seed): FinancialPeriod
    {
        return FinancialPeriod::query()->create([
            'id' => RandomIdentifier::new(),
            'period_key' => 'grad-'.$seed.'-'.substr(md5(RandomIdentifier::new()), 0, 8),
            'date_from' => '2026-09-01',
            'date_to' => '2026-12-31',
            'lifecycle_state' => 'open',
        ]);
    }
}
