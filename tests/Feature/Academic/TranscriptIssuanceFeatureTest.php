<?php

declare(strict_types=1);

namespace Tests\Feature\Academic;

use App\Modules\Academic\Commands\DecideGraduation;
use App\Modules\Academic\Commands\DecideProgression;
use App\Modules\Academic\Commands\IssueTranscript;
use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Commands\MaintainClass;
use App\Modules\Academic\Commands\MaintainEnrollment;
use App\Modules\Academic\Commands\ManageAssessmentResult;
use App\Modules\Academic\Commands\RecordAttendance;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\AssessmentAttempt;
use App\Modules\Academic\Models\AssessmentResult;
use App\Modules\Academic\Models\AttendanceFact;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\ClassSession;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\GraduationDecision;
use App\Modules\Academic\Models\Program;
use App\Modules\Academic\Models\ProgramVersion;
use App\Modules\Academic\Models\ProgramVersionLevel;
use App\Modules\Academic\Models\ProgressionDecision;
use App\Modules\Academic\Models\ResultCorrection;
use App\Modules\Academic\Models\Transcript;
use App\Modules\Academic\Queries\TranscriptQuery;
use App\Modules\Admissions\Commands\DecideAdmission;
use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\AdmissionDecision;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Audit\Models\AuditEvent as AuditEventModel;
use App\Modules\Documents\Commands\DefineDocumentClassification;
use App\Modules\Documents\Models\Document;
use App\Modules\Identity\Models\UserAccount;
use App\Modules\Students\Models\Student;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Database\Eloquent\ModelNotFoundException;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsPlacementCatalog;
use Tests\TestCase;

/**
 * AC7 official transcript issuance: the record composes from immutable
 * Academic facts, superseded results and corrections stay out, the issued
 * payload is frozen and hashed, every issuance is a governed document, and
 * the console can issue and print it.
 */
final class TranscriptIssuanceFeatureTest extends TestCase
{
    use BuildsPlacementCatalog;

    private string $programVersionId;

    private string $periodId;

    private string $levelA1Id;

    private string $levelA2Id;

    private string $classId;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpPlacementCatalog();

        $programId = (string) Program::query()->where('name', 'IELTS Preparation')->value('id');
        $this->programVersionId = (string) ProgramVersion::query()->where('program_id', $programId)->value('id');
        $this->levelA1Id = (string) ProgramVersionLevel::query()->where('program_version_id', $this->programVersionId)->where('level_key', 'A1')->value('id');
        $this->levelA2Id = (string) ProgramVersionLevel::query()->where('program_version_id', $this->programVersionId)->where('level_key', 'A2')->value('id');

        $officer = $this->academicOfficer('trx-officer');
        $this->periodId = (string) app(MaintainAcademicStructure::class)->definePeriod($officer, 'Transcript Term', new CarbonImmutable('2026-09-01'), new CarbonImmutable('2026-12-31'), 'trx-period')['period_id'];
        app(MaintainAcademicStructure::class)->transitionPeriod($officer, AcademicPeriod::query()->findOrFail($this->periodId), 'published', 'trx-period-pub');

        $this->personWithAuthority('trx-teacher-1', []);
        $this->classId = (string) app(MaintainClass::class)->defineClass($officer, $this->programVersionId, $this->periodId, 10, 'trx-class', $this->levelA1Id)['class_id'];
        app(MaintainClass::class)->assignTeacher($officer, ClassModel::query()->findOrFail($this->classId), 'trx-teacher-1', new CarbonImmutable('2026-09-01'), null, 'trx-class-teacher');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($this->classId), 'published', 'trx-class-pub');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($this->classId), 'active', 'trx-class-active');
    }

    public function test_transcript_assembles_the_full_certified_record(): void
    {
        $studentId = $this->studentWithEntry('full');
        $seatId = $this->activeSeat('full', $studentId);
        $sessionId = $this->scheduledSession('full');
        $recorder = $this->grantedActor('trx-recorder-full', ['academic.attendance']);
        app(RecordAttendance::class)->record($recorder, ClassSession::query()->findOrFail($sessionId), Enrollment::query()->findOrFail($seatId), 'present', 'trx-att-full');

        $resultId = $this->releasedResult($seatId, 'full', '82.00')['result_id'];
        $this->approvedAdvance('full', $studentId, $resultId);
        app(MaintainEnrollment::class)->complete(
            $this->academicOfficer('trx-officer-full'),
            Enrollment::query()->findOrFail($seatId),
            'completed all A1 requirements',
            'assessment_result',
            $resultId,
            'trx-complete-full',
        );
        $serial = $this->graduatedWithCertificate('full', $studentId);
        $this->defineClassification('full');

        $issued = app(IssueTranscript::class)->issue($this->issuer('full'), $studentId, $this->programVersionId, 'trx-issue-full');

        /** @var Transcript $transcript */
        $transcript = Transcript::query()->findOrFail($issued['transcript_id']);
        /** @var array<string, mixed> $payload */
        $payload = $transcript->payload;

        $this->assertSame($studentId, $payload['student']['student_id']);
        $this->assertNotSame('', (string) $payload['student']['legal_name']);
        $this->assertSame('IELTS Preparation', $payload['program']['program_name']);
        $this->assertNotNull($payload['entry']);
        $this->assertNotSame('', (string) $payload['entry']['recommended_level']['title']);
        $this->assertNotSame('', (string) $payload['entry']['payload_digest']);

        $this->assertCount(1, $payload['levels']);
        $this->assertSame('advance', $payload['levels'][0]['outcome']);
        $this->assertSame('A2', $payload['levels'][0]['to_level']['level_key']);
        $this->assertSame('82.00', $payload['levels'][0]['result_score']);

        $this->assertCount(1, $payload['results']);
        $this->assertSame('82.00', $payload['results'][0]['score']);

        $this->assertCount(1, $payload['seats']['completed']);
        $this->assertSame('completed', $payload['seats']['completed'][0]['state']);
        $this->assertSame('completed all A1 requirements', $payload['seats']['completed'][0]['completion_basis']);
        $this->assertSame([], $payload['seats']['in_progress']);

        $this->assertCount(1, $payload['attendance']);
        $this->assertSame(1, $payload['attendance'][0]['present']);
        $this->assertSame(0, $payload['attendance'][0]['absent']);

        $this->assertSame($serial, $payload['graduation']['certificate_serial']);

        $this->assertTrue(app(TranscriptQuery::class)->verify($transcript));
        $this->assertSame('submitted', (string) Document::query()->findOrFail($issued['document_id'])->lifecycle_state);

        /** @var AuditEventModel $event */
        $event = AuditEventModel::query()
            ->where('operation', 'academic.transcript.issue')
            ->where('target_id', $issued['transcript_id'])
            ->firstOrFail();
        $this->assertSame($issued['content_hash'], $event->after_state['content_hash']);
    }

    public function test_corrected_result_supersedes_the_original_score(): void
    {
        $studentId = $this->studentWithEntry('correction');
        $seatId = $this->activeSeat('correction', $studentId);
        $released = $this->releasedResult($seatId, 'correction', '82.00');
        $this->defineClassification('correction');

        $moderator = $this->grantedActor('trx-moderator-correction', ['academic.moderate']);
        $proposal = app(ManageAssessmentResult::class)->proposeCorrection($moderator, AssessmentResult::query()->findOrFail($released['result_id']), '91.00', 'recount verified against source responses', 'trx-cor-correction');
        app(ManageAssessmentResult::class)->approveCorrection(
            $this->grantedActor('trx-approver-correction', ['academic.approve_result']),
            ResultCorrection::query()->findOrFail($proposal['correction_id']),
            'trx-cor-approve-correction',
        );

        $issued = app(IssueTranscript::class)->issue($this->issuer('correction'), $studentId, $this->programVersionId, 'trx-issue-correction');

        /** @var array<string, mixed> $payload */
        $payload = Transcript::query()->findOrFail($issued['transcript_id'])->payload;
        $this->assertCount(1, $payload['results']);
        $this->assertSame('91.00', $payload['results'][0]['score']);
    }

    public function test_attendance_counts_only_the_latest_fact_per_session(): void
    {
        $studentId = $this->studentWithEntry('attendance');
        $seatId = $this->activeSeat('attendance', $studentId);
        $sessionId = $this->scheduledSession('attendance');
        $recorder = $this->grantedActor('trx-recorder-attendance', ['academic.attendance']);
        $fact = app(RecordAttendance::class)->record($recorder, ClassSession::query()->findOrFail($sessionId), Enrollment::query()->findOrFail($seatId), 'present', 'trx-att-attendance');
        app(RecordAttendance::class)->correct($recorder, AttendanceFact::query()->findOrFail($fact['fact_id']), 'absent', 'register check against gate log', 'trx-att-correct-attendance');
        $this->defineClassification('attendance');

        $issued = app(IssueTranscript::class)->issue($this->issuer('attendance'), $studentId, $this->programVersionId, 'trx-issue-attendance');

        /** @var array<string, mixed> $payload */
        $payload = Transcript::query()->findOrFail($issued['transcript_id'])->payload;
        $this->assertCount(1, $payload['attendance']);
        $this->assertSame(0, $payload['attendance'][0]['present']);
        $this->assertSame(1, $payload['attendance'][0]['absent']);
    }

    public function test_issued_payload_is_frozen_and_reissue_captures_new_facts(): void
    {
        $studentId = $this->studentWithEntry('frozen');
        $seatId = $this->activeSeat('frozen', $studentId);
        $this->defineClassification('frozen');

        $first = app(IssueTranscript::class)->issue($this->issuer('frozen'), $studentId, $this->programVersionId, 'trx-issue-frozen-1');
        /** @var array<string, mixed> $firstPayload */
        $firstPayload = Transcript::query()->findOrFail($first['transcript_id'])->payload;
        $this->assertSame([], $firstPayload['levels']);
        $this->assertCount(1, $firstPayload['seats']['in_progress']);

        $resultId = $this->releasedResult($seatId, 'frozen', '75.00')['result_id'];
        $this->approvedAdvance('frozen', $studentId, $resultId);

        /** @var array<string, mixed> $storedFirst */
        $storedFirst = Transcript::query()->findOrFail($first['transcript_id'])->payload;
        $this->assertSame([], $storedFirst['levels'], 'the issued record never changes after new achievements');

        $second = app(IssueTranscript::class)->issue($this->issuer('frozen'), $studentId, $this->programVersionId, 'trx-issue-frozen-2');
        $this->assertNotSame($first['transcript_id'], $second['transcript_id']);
        /** @var array<string, mixed> $secondPayload */
        $secondPayload = Transcript::query()->findOrFail($second['transcript_id'])->payload;
        $this->assertCount(1, $secondPayload['levels']);
        $this->assertNotSame($first['content_hash'], $second['content_hash']);
    }

    public function test_issuance_guards_fail_closed(): void
    {
        $studentId = $this->studentWithEntry('guards');

        try {
            app(IssueTranscript::class)->issue($this->issuer('guards'), $studentId, $this->programVersionId, 'trx-issue-guards');
            $this->fail('issuance without the transcript classification must fail closed');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.transcript_classification_missing', $rejection->errorCode());
        }
        $this->defineClassification('guards');

        try {
            app(IssueTranscript::class)->issue($this->grantedActor('trx-nobody-guards', []), $studentId, $this->programVersionId, 'trx-issue-guards-denied');
            $this->fail('issuance without the capability must be denied');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('academic.transcript_denied', $denial->errorCode());
        }

        try {
            app(IssueTranscript::class)->issue($this->grantedActor('trx-cert-only-guards', ['academic.transcript_issue']), $studentId, $this->programVersionId, 'trx-issue-guards-sod');
            $this->fail('issuance without the documents capability must be denied');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('documents.register_denied', $denial->errorCode());
        }
        $this->assertSame(0, Transcript::query()->where('student_id', $studentId)->count());

        $this->expectException(ModelNotFoundException::class);
        app(IssueTranscript::class)->issue($this->issuer('guards'), $studentId, RandomIdentifier::new(), 'trx-issue-guards-version');
    }

    public function test_idempotent_replay_returns_the_same_issuance(): void
    {
        $studentId = $this->studentWithEntry('replay');
        $this->defineClassification('replay');

        $first = app(IssueTranscript::class)->issue($this->issuer('replay'), $studentId, $this->programVersionId, 'trx-issue-replay');
        $second = app(IssueTranscript::class)->issue($this->issuer('replay'), $studentId, $this->programVersionId, 'trx-issue-replay');
        $this->assertSame($first, $second);
        $this->assertSame(1, Transcript::query()->where('student_id', $studentId)->count());
        $this->assertSame(1, Document::query()->where('id', $first['document_id'])->count());
    }

    public function test_transcript_issue_and_print_over_http(): void
    {
        $studentId = $this->studentWithEntry('web');
        $this->defineClassification('web');

        $issuer = $this->personWithAuthority('trx.web.issuer', ['academic.transcript_issue', 'documents.register']);
        $this->signInAs($issuer->id, 'trx.web.issuer');
        $this->post('/academic/transcripts', [
            'student_id' => $studentId,
            'program_version_id' => $this->programVersionId,
        ])->assertRedirect();
        $transcriptId = (string) Transcript::query()->where('student_id', $studentId)->value('id');
        $this->assertNotSame('', $transcriptId);

        $studentCode = (string) Student::query()->findOrFail($studentId)->student_code;
        $this->get("/print/transcript/{$transcriptId}")
            ->assertOk()
            ->assertSee('Official Transcript', false)
            ->assertSee($studentCode, false);
    }

    private function signInAs(string $personId, string $username): void
    {
        UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $personId,
            'username' => $username,
            'password_hash' => Hash::make('transcript-pw-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);
        $this->post('/login', ['username' => $username, 'password' => 'transcript-pw-1'])->assertRedirect('/');
    }

    private function studentWithEntry(string $seed): string
    {
        $personId = 'trx-person-'.$seed;
        $this->personWithAuthority($personId, []);
        // Short placement prefix: the catalog trait appends its own actor
        // sequence and timestamp fragments to every derived id (char(36)).
        $profile = $this->completeReleasedPlacement($personId, 'tp-'.substr(md5($seed), 0, 6));

        $registered = app(RegisterApplicant::class)->register(
            $this->admissionsClerk('trx-clerk-'.$seed), $personId, 'IELTS Preparation', 'trx-reg-'.$seed, $profile->id,
        );
        /** @var Applicant $applicant */
        $applicant = Applicant::query()->findOrFail($registered['applicant_id']);
        $initiated = app(DecideAdmission::class)->initiate(
            $this->admissionsClerk('trx-clerk2-'.$seed), $applicant, true, 'meets entry policy', 'interview-notes/trx-'.$seed, 'trx-deci-'.$seed,
        );
        $decision = AdmissionDecision::query()->findOrFail($initiated['decision_id']);
        app(DecideAdmission::class)->review($this->admissionsReviewer('trx-rev-'.$seed), $decision, 'trx-decr-'.$seed);
        app(DecideAdmission::class)->approve($this->admissionsApprover('trx-adv-'.$seed), $decision, 'trx-deca-'.$seed);

        return app(EnrollAdmittedApplicant::class)->convert($this->admissionsApprover('trx-adv2-'.$seed), $applicant, 'trx-conv-'.$seed)['student_id'];
    }

    private function activeSeat(string $seed, string $studentId): string
    {
        $requested = app(MaintainEnrollment::class)->request($this->enrollmentClerk('trx-enroll-'.$seed), $studentId, $this->classId, 'trx-enroll-'.$seed);
        app(MaintainEnrollment::class)->activate($this->academicOfficer('trx-activate-'.$seed), Enrollment::query()->findOrFail($requested['enrollment_id']), 'trx-activate-'.$seed);

        return $requested['enrollment_id'];
    }

    private function scheduledSession(string $seed): string
    {
        return (string) app(MaintainClass::class)->scheduleSession(
            $this->academicOfficer('trx-schedule-'.$seed),
            ClassModel::query()->findOrFail($this->classId),
            new CarbonImmutable('2026-09-10'),
            '09:00',
            '10:30',
            'trx-session-'.$seed,
        )['session_id'];
    }

    /** @return array{attempt_id: string, result_id: string} */
    private function releasedResult(string $enrollmentId, string $seed, string $score): array
    {
        $scorer = $this->grantedActor('trx-scorer-'.$seed, ['academic.assess']);
        $moderator = $this->grantedActor('trx-moderator-'.$seed, ['academic.moderate']);
        $approver = $this->grantedActor('trx-approver-'.$seed, ['academic.approve_result']);
        $releaser = $this->grantedActor('trx-releaser-'.$seed, ['academic.release']);

        $attempt = app(ManageAssessmentResult::class)->submitAttempt($scorer, Enrollment::query()->findOrFail($enrollmentId), 'assessment', 'scan/'.$seed, 'trx-attempt-'.$seed);
        $result = app(ManageAssessmentResult::class)->score($scorer, AssessmentAttempt::query()->findOrFail($attempt['attempt_id']), $score, 'trx-score-'.$seed);
        /** @var AssessmentResult $row */
        $row = AssessmentResult::query()->findOrFail($result['result_id']);
        app(ManageAssessmentResult::class)->moderate($moderator, $row, 'trx-moderate-'.$seed);
        app(ManageAssessmentResult::class)->approve($approver, $row, 'trx-approve-result-'.$seed);
        app(ManageAssessmentResult::class)->release($releaser, $row, 'trx-release-'.$seed);

        return ['attempt_id' => $attempt['attempt_id'], 'result_id' => $result['result_id']];
    }

    private function approvedAdvance(string $seed, string $studentId, string $resultId): void
    {
        $proposed = app(DecideProgression::class)->propose(
            $this->grantedActor('trx-prop-'.$seed, ['academic.progression_propose']),
            $studentId,
            $this->classId,
            'advance',
            'ready for the next level',
            'trx-propose-'.$seed,
            $resultId,
            'assessed delivery behind the advance',
        );
        $decisionId = $proposed['decision_id'];
        app(DecideProgression::class)->review($this->grantedActor('trx-revprog-'.$seed, ['academic.progression_review']), ProgressionDecision::query()->findOrFail($decisionId), 'trx-reviewprog-'.$seed);
        app(DecideProgression::class)->approve($this->grantedActor('trx-appprog-'.$seed, ['academic.progression_approve']), ProgressionDecision::query()->findOrFail($decisionId), 'trx-approveprog-'.$seed);
    }

    private function graduatedWithCertificate(string $seed, string $studentId): string
    {
        $proposed = app(DecideGraduation::class)->propose(
            $this->grantedActor('trx-gprop-'.$seed, ['academic.completion']),
            $studentId,
            $this->programVersionId,
            'eligible',
            'all requirements met',
            'trx-gpropose-'.$seed,
        );
        $decisionId = $proposed['decision_id'];
        app(DecideGraduation::class)->review($this->grantedActor('trx-grev-'.$seed, ['academic.completion']), GraduationDecision::query()->findOrFail($decisionId), 'trx-greview-'.$seed);
        app(DecideGraduation::class)->approve($this->grantedActor('trx-gapp-'.$seed, ['academic.completion_approve']), GraduationDecision::query()->findOrFail($decisionId), 'trx-gapprove-'.$seed);
        app(DefineDocumentClassification::class)->defineClassification(
            $this->grantedActor('trx-gclass-'.$seed, ['documents.classify']),
            'academic.certificate',
            'academic',
            'restricted',
            'trx-gclassification-'.$seed,
        );
        $issued = app(DecideGraduation::class)->issueCertificate(
            $this->grantedActor('trx-gcert-'.$seed, ['academic.certify', 'documents.register']),
            GraduationDecision::query()->findOrFail($decisionId),
            'trx-gissue-'.$seed,
        );

        return $issued['serial'];
    }

    private function defineClassification(string $seed): void
    {
        app(DefineDocumentClassification::class)->defineClassification(
            $this->grantedActor('trx-classifier-'.$seed, ['documents.classify']),
            'academic.transcript',
            'academic',
            'restricted',
            'trx-classification-'.$seed,
        );
    }

    private function issuer(string $seed): Actor
    {
        return $this->grantedActor('trx-issuer-'.$seed, ['academic.transcript_issue', 'documents.register']);
    }
}
