<?php

use App\Http\Controllers\Api\AcademicApiController;
use App\Http\Controllers\Api\CrmApiController;
use App\Http\Controllers\Api\FinanceApiController;
use App\Http\Controllers\Api\IdentityApiController;
use App\Http\Controllers\Api\NotificationApiController;
use App\Http\Controllers\Api\PayrollApiController;
use App\Http\Controllers\Api\PlacementApiController;
use App\Http\Controllers\Api\StudentsApiController;
use App\Http\Controllers\Api\TeacherApiController;
use App\Http\Controllers\Api\SearchApiController;
use App\Http\Controllers\Api\WorkManagementApiController;
use App\Http\Controllers\Api\WorkspaceApiController;
use App\Support\Authorization\Actor;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| Employee API (The TOEFL House)
|--------------------------------------------------------------------------
|
| JSON interface for programmatic/SPA consumption of the same authoritative
| command surface the web console uses. Session-authenticated (same-origin),
| server-authorized per operation, idempotent via the Idempotency-Key header,
| and mapped from the stable domain error taxonomy. No business logic lives
| here — each endpoint delegates to a module command or query.
|
*/

// v1 is the only interactive application API. Legacy unversioned transport
// is intentionally not maintained as a second contract.
Route::prefix('v1')->middleware('employee')->group(function (): void {
    Route::get('/me', function (Request $request) {
        /** @var Actor $actor */
        $actor = $request->attributes->get('actor');
        $user = $request->user();
        if ($user === null) {
            abort(401, 'authentication_required');
        }

        return response()->json([
            'data' => [
                'username' => $user->username,
                'person_id' => $actor->actorId,
                'display_name' => $actor->displayName,
            ],
        ]);
    })->name('api.me');

    Route::prefix('students')->name('api.students.')->group(function (): void {
        Route::get('/', [StudentsApiController::class, 'index'])->name('index');
        Route::get('/{studentId}', [StudentsApiController::class, 'show'])->name('show');
        Route::post('/applicants', [StudentsApiController::class, 'registerApplicant'])->name('register');
        Route::post('/applicants/{applicantId}/reopen', [StudentsApiController::class, 'reopenApplicant'])->name('reopen');
        Route::post('/applicants/{applicantId}/initiate', [StudentsApiController::class, 'initiate'])->name('initiate');
        Route::post('/decisions/{decisionId}/review', [StudentsApiController::class, 'review'])->name('decision.review');
        Route::post('/decisions/{decisionId}/approve', [StudentsApiController::class, 'approve'])->name('decision.approve');
        Route::post('/applicants/{applicantId}/enroll', [StudentsApiController::class, 'enroll'])->name('enroll');
        Route::post('/{studentId}/status/{action}', [StudentsApiController::class, 'status'])->where('action', 'suspend|withdraw|reactivate|complete|graduate')->name('status');
        Route::post('/{studentId}/transfer', [StudentsApiController::class, 'transfer'])->name('transfer');
        Route::post('/{studentId}/hold', [StudentsApiController::class, 'hold'])->name('hold');
        Route::post('/{studentId}/guardians', [StudentsApiController::class, 'guardian'])->name('guardian');
        Route::post('/guardians/{relationshipId}/{action}', [StudentsApiController::class, 'guardianVerification'])->where('action', 'verify|revoke')->name('guardian.action');
        Route::post('/{studentId}/communication-preference', [StudentsApiController::class, 'communicationPreference'])->name('communication');
    });

    Route::prefix('teachers')->name('api.teachers.')->group(function (): void {
        Route::get('/workspace', [TeacherApiController::class, 'workspace'])->name('workspace');
        Route::post('/profiles', [TeacherApiController::class, 'register'])->name('profile.register');
        Route::post('/profiles/{profileId}/qualifications', [TeacherApiController::class, 'qualification'])->name('qualification.add');
        Route::post('/qualifications/{qualificationId}/verify', [TeacherApiController::class, 'verifyQualification'])->name('qualification.verify');
        Route::post('/profiles/{profileId}/transition', [TeacherApiController::class, 'transition'])->name('profile.transition');
        Route::post('/profiles/{profileId}/transfer', [TeacherApiController::class, 'transfer'])->name('branch.transfer');
        Route::post('/profiles/{profileId}/branches', [TeacherApiController::class, 'branch'])->name('branch.authorize');
        Route::post('/profiles/{profileId}/skills', [TeacherApiController::class, 'skill'])->name('skill.authorize');
        Route::post('/profiles/{profileId}/availability', [TeacherApiController::class, 'availability'])->name('availability.declare');
        Route::post('/profiles/{profileId}/workload', [TeacherApiController::class, 'workload'])->name('workload.set');
        Route::post('/assignments', [TeacherApiController::class, 'assign'])->name('assignment.assign');
        Route::post('/assignments/{assignmentId}/end', [TeacherApiController::class, 'endAssignment'])->name('assignment.end');
        Route::post('/assignments/{assignmentId}/extend', [TeacherApiController::class, 'extendAssignment'])->name('assignment.extend');
        Route::post('/assignments/{assignmentId}/handover', [TeacherApiController::class, 'handover'])->name('assignment.handover');
        Route::post('/assignments/{assignmentId}/skills', [TeacherApiController::class, 'assignSkill'])->name('assignment.skill');
    });

    Route::prefix('academic')->name('api.academic.')->group(function (): void {
        Route::get('/workspace', [AcademicApiController::class, 'workspace'])->name('workspace');
        Route::post('/programs', [AcademicApiController::class, 'defineProgram'])->name('program.define');
        Route::post('/programs/{programId}/versions', [AcademicApiController::class, 'publishProgramVersion'])->name('version.publish');
        Route::post('/levels', [AcademicApiController::class, 'defineLevel'])->name('level.define');
        Route::post('/periods', [AcademicApiController::class, 'definePeriod'])->name('period.define');
        Route::post('/periods/{periodId}/transition', [AcademicApiController::class, 'transitionPeriod'])->name('period.transition');
        Route::post('/levels/prerequisites', [AcademicApiController::class, 'definePrerequisite'])->name('level.prerequisite.define');
        Route::post('/levels/prerequisites/{prerequisiteId}/retire', [AcademicApiController::class, 'retirePrerequisite'])->name('level.prerequisite.retire');
        Route::post('/levels/rules', [AcademicApiController::class, 'defineProgressionRule'])->name('level.rule.define');
        Route::post('/levels/rules/{ruleId}/retire', [AcademicApiController::class, 'retireProgressionRule'])->name('level.rule.retire');
        Route::post('/skills', [AcademicApiController::class, 'registerSkill'])->name('skill.register');
        Route::post('/skills/{skillId}/retire', [AcademicApiController::class, 'retireSkill'])->name('skill.retire');
        Route::post('/availabilities', [AcademicApiController::class, 'declareAvailability'])->name('availability.declare');
        Route::post('/availabilities/{availabilityId}/{action}', [AcademicApiController::class, 'transitionAvailability'])
            ->where('action', 'close|reopen')->name('availability.transition');
        Route::post('/offerings', [AcademicApiController::class, 'openOffering'])->name('offering.open');
        Route::post('/offerings/{offeringId}/resize', [AcademicApiController::class, 'resizeOffering'])->name('offering.resize');
        Route::post('/rooms', [AcademicApiController::class, 'defineRoom'])->name('room.define');
        Route::post('/rooms/{roomId}/transition', [AcademicApiController::class, 'transitionRoom'])->name('room.transition');
        Route::post('/rooms/{roomId}/resize', [AcademicApiController::class, 'resizeRoom'])->name('room.resize');
        Route::get('/sessions', [AcademicApiController::class, 'sessions'])->name('sessions');
        Route::post('/sessions', [AcademicApiController::class, 'schedule'])->name('schedule');
        Route::post('/sessions/{sessionId}/attendance', [AcademicApiController::class, 'attendance'])->name('attendance');
        Route::post('/attendance/{factId}/correct', [AcademicApiController::class, 'correctAttendance'])->name('attendance.correct');
        Route::post('/attempts', [AcademicApiController::class, 'submitAttempt'])->name('attempt.submit');
        Route::post('/attempts/{attemptId}/score', [AcademicApiController::class, 'scoreAttempt'])->name('attempt.score');
        Route::post('/results/{resultId}/{action}', [AcademicApiController::class, 'transitionAssessment'])
            ->where('action', 'moderate|approve|release|mark-appealed')->name('result.transition');
        Route::post('/results/{resultId}/correction', [AcademicApiController::class, 'proposeAssessmentCorrection'])->name('result.correction.propose');
        Route::post('/corrections/{correctionId}/approve', [AcademicApiController::class, 'approveAssessmentCorrection'])->name('result.correction.approve');
        Route::post('/progressions', [AcademicApiController::class, 'proposeProgression'])->name('progression.propose');
        Route::post('/progressions/{decisionId}/{action}', [AcademicApiController::class, 'transitionProgression'])
            ->where('action', 'review|approve|reject|mark-appealed|supersede')->name('progression.transition');
        Route::post('/classes', [AcademicApiController::class, 'defineClass'])->name('class.define');
        Route::post('/classes/{classId}/transition', [AcademicApiController::class, 'transitionClass'])->name('class.transition');
        Route::post('/sections', [AcademicApiController::class, 'defineSection'])->name('section.define');
        Route::post('/sections/{sectionId}/transition', [AcademicApiController::class, 'transitionSection'])->name('section.transition');
        Route::post('/teacher-assignments', [AcademicApiController::class, 'assignTeacher'])->name('teacher.assign');
        Route::post('/teacher-assignments/{assignmentId}/end', [AcademicApiController::class, 'endAssignment'])->name('teacher.end');
        Route::post('/teacher-assignments/{assignmentId}/extend', [AcademicApiController::class, 'extendAssignment'])->name('teacher.extend');
        Route::post('/teacher-assignments/{assignmentId}/handover', [AcademicApiController::class, 'handoverAssignment'])->name('teacher.handover');
        Route::post('/teacher-assignments/{assignmentId}/skills', [AcademicApiController::class, 'assignTeacherSkill'])->name('teacher.skill.assign');
        Route::post('/enrollments', [AcademicApiController::class, 'requestEnrollment'])->name('enrollment.request');
        Route::post('/enrollments/{enrollmentId}/activate', [AcademicApiController::class, 'activateEnrollment'])->name('enrollment.activate');
        Route::post('/enrollments/{enrollmentId}/{action}', [AcademicApiController::class, 'transitionEnrollment'])
            ->where('action', 'freeze|unfreeze|withdraw|complete|transfer')->name('enrollment.transition');
        Route::post('/waitlist', [AcademicApiController::class, 'waitlist'])->name('waitlist.join');
        Route::post('/waitlist/{entryId}/offer', [AcademicApiController::class, 'offerWaitlist'])->name('waitlist.offer');
        Route::post('/waitlist/{entryId}/promote', [AcademicApiController::class, 'promoteWaitlist'])->name('waitlist.promote');
        Route::post('/waitlist/{entryId}/withdraw', [AcademicApiController::class, 'withdrawWaitlist'])->name('waitlist.withdraw');
        Route::post('/waitlist/{entryId}/expire', [AcademicApiController::class, 'expireWaitlist'])->name('waitlist.expire');
        Route::post('/graduations', [AcademicApiController::class, 'proposeGraduation'])->name('graduation.propose');
        Route::post('/graduations/{decisionId}/{action}', [AcademicApiController::class, 'transitionGraduation'])
            ->where('action', 'review|approve|reject')->name('graduation.transition');
        Route::post('/graduations/{decisionId}/certificate', [AcademicApiController::class, 'issueCertificate'])->name('graduation.certificate');
        Route::post('/transcripts', [AcademicApiController::class, 'issueTranscript'])->name('transcript.issue');
        Route::post('/appeals', [AcademicApiController::class, 'fileAppeal'])->name('appeal.file');
        Route::post('/appeals/{appealId}/assign', [AcademicApiController::class, 'assignAppeal'])->name('appeal.assign');
        Route::post('/appeals/{appealId}/{action}', [AcademicApiController::class, 'transitionAppeal'])
            ->where('action', 'investigate|resolve|reject|escalate|close')->name('appeal.transition');
        Route::post('/offerings/{offeringId}/{action}', [AcademicApiController::class, 'transitionOffering'])
            ->where('action', 'close|reopen|cancel|complete')->name('offering.transition');
    });

    Route::prefix('identity')->name('api.identity.')->group(function (): void {
        Route::get('/people', [IdentityApiController::class, 'people'])->name('people');
        Route::post('/people', [IdentityApiController::class, 'register'])->name('person.register');
        Route::post('/people/{personId}/verify', [IdentityApiController::class, 'verify'])->name('verify');
        Route::post('/accounts', [IdentityApiController::class, 'link'])->name('link');
        Route::post('/accounts/{accountId}/password', [IdentityApiController::class, 'password'])->name('password');
    });

    Route::prefix('finance')->name('api.finance.')->group(function (): void {
        Route::get('/obligations', [FinanceApiController::class, 'obligations'])->name('obligations');
        Route::get('/payments', [FinanceApiController::class, 'payments'])->name('payments');
        Route::post('/periods', [FinanceApiController::class, 'openPeriod'])->name('period.open');
        Route::post('/periods/{periodId}/close', [FinanceApiController::class, 'closePeriod'])->name('period.close');
        Route::post('/accounts', [FinanceApiController::class, 'defineAccount'])->name('account.define');
        Route::post('/obligations', [FinanceApiController::class, 'postObligation'])->name('obligation.post');
        Route::post('/obligations/{obligationId}/allocate', [FinanceApiController::class, 'allocatePayment'])->name('allocate');
        Route::post('/journals', [FinanceApiController::class, 'postJournal'])->name('journal.post');
        Route::post('/journals/{journalId}/reverse', [FinanceApiController::class, 'reverseJournal'])->name('journal.reverse');
        Route::post('/discounts', [FinanceApiController::class, 'proposeDiscount'])->name('discount.propose');
        Route::post('/discounts/{discountId}/approve', [FinanceApiController::class, 'approveDiscount'])->name('discount.approve');
        Route::post('/reconciliations', [FinanceApiController::class, 'observeReconciliation'])->name('reconciliation.observe');
        Route::post('/reconciliations/{reconciliationId}/approve', [FinanceApiController::class, 'approveReconciliation'])->name('reconciliation.approve');
        Route::post('/funds', [FinanceApiController::class, 'establishFund'])->name('fund.establish');
        Route::post('/funds/{fundId}/allocations', [FinanceApiController::class, 'allocateFund'])->name('fund.allocate');
        Route::post('/credits', [FinanceApiController::class, 'proposeCredit'])->name('credit.propose');
        Route::post('/credits/{creditId}/approve', [FinanceApiController::class, 'approveCredit'])->name('credit.approve');
        Route::post('/installment-plans', [FinanceApiController::class, 'proposeInstallment'])->name('installment.propose');
        Route::post('/installment-plans/{planId}/approve', [FinanceApiController::class, 'approveInstallment'])->name('installment.approve');
        Route::post('/gate-exceptions', [FinanceApiController::class, 'proposeGateException'])->name('gate-exception.propose');
        Route::post('/gate-exceptions/{exceptionId}/approve', [FinanceApiController::class, 'approveGateException'])->name('gate-exception.approve');
        Route::post('/coverage-revocations', [FinanceApiController::class, 'proposeCoverageRevocation'])->name('coverage-revocation.propose');
        Route::post('/coverage-revocations/{revocationId}/approve', [FinanceApiController::class, 'approveCoverageRevocation'])->name('coverage-revocation.approve');
        Route::post('/payments', [FinanceApiController::class, 'record'])->name('record');
        Route::post('/payroll-liabilities', [FinanceApiController::class, 'recognizePayrollLiability'])->name('payroll-liability.recognize');
        Route::post('/payments/{paymentId}/refund', [FinanceApiController::class, 'proposeRefund'])->name('refund.propose');
        Route::post('/refunds/{refundId}/approve', [FinanceApiController::class, 'approveRefund'])->name('refund.approve');
        Route::post('/obligations/{obligationId}/correction', [FinanceApiController::class, 'proposeObligationCorrection'])->name('correction.obligation.propose');
        Route::post('/allocations/{allocationId}/reversal', [FinanceApiController::class, 'proposeAllocationReversal'])->name('correction.allocation.propose');
        Route::post('/fund-allocations/{allocationId}/reversal', [FinanceApiController::class, 'proposeFundAllocationReversal'])->name('correction.fund-allocation.propose');
        Route::post('/corrections/{correctionId}/approve', [FinanceApiController::class, 'approveFinancialCorrection'])->name('correction.approve');
        Route::post('/employment-settlements/{proposalId}/approve', [FinanceApiController::class, 'approveEmploymentSettlement'])->name('employment-settlement.approve');
    });

    Route::prefix('payroll')->name('api.payroll.')->group(function (): void {
        Route::get('/periods', [PayrollApiController::class, 'periods'])->name('periods');
        Route::get('/calculations', [PayrollApiController::class, 'calculations'])->name('calculations');
        Route::post('/calculations', [PayrollApiController::class, 'calculate'])->name('calculate');
        Route::post('/calculations/{calculationId}/approve', [PayrollApiController::class, 'approve'])->name('approve');
        Route::post('/calculations/{calculationId}/resolve-held', [PayrollApiController::class, 'resolveHeld'])->name('resolve-held');
        Route::post('/employments/{employmentId}/clearance', [PayrollApiController::class, 'clear'])->name('clearance');
        Route::post('/employments/{employmentId}/settlements', [PayrollApiController::class, 'proposeSettlement'])->name('settlement.propose');
    });

    Route::prefix('placement')->name('api.placement.')->group(function (): void {
        Route::get('/tests', [PlacementApiController::class, 'tests'])->name('tests');
        Route::get('/versions', [PlacementApiController::class, 'versions'])->name('versions');
        Route::get('/profiles', [PlacementApiController::class, 'profiles'])->name('profiles');
        Route::get('/profiles/{profileId}', [PlacementApiController::class, 'show'])->name('profiles.show');
        Route::get('/profiles/{profileId}/attemptable-versions', [PlacementApiController::class, 'attemptableVersions'])->name('profiles.attemptable-versions');
        Route::get('/profiles/{profileId}/finance-link', [PlacementApiController::class, 'financeLink'])->name('profiles.finance-link');
        Route::get('/profiles/{profileId}/eligibility-snapshot', [PlacementApiController::class, 'eligibilitySnapshot'])->name('profiles.eligibility-snapshot');
        Route::post('/profiles', [PlacementApiController::class, 'openProfile'])->name('profiles.open');
        Route::post('/attempts', [PlacementApiController::class, 'startAttempt'])->name('attempts.start');
        Route::post('/attempts/{attemptId}/submit', [PlacementApiController::class, 'submitDigital'])->name('attempts.submit');
        Route::post('/attempts/{attemptId}/submit-physical', [PlacementApiController::class, 'submitPhysical'])->name('attempts.submit-physical');
        Route::post('/attempts/{attemptId}/ingest-answers', [PlacementApiController::class, 'ingestPhysicalAnswers'])->name('attempts.ingest-answers');
        Route::post('/sections/score', [PlacementApiController::class, 'scoreSection'])->name('sections.score');
        Route::post('/section-results/{sectionResultId}/moderate', [PlacementApiController::class, 'moderateSection'])->name('section.moderate');
        Route::post('/section-results/{sectionResultId}/approve', [PlacementApiController::class, 'approveSection'])->name('section.approve');
        Route::post('/profiles/{profileId}/mark-scored', [PlacementApiController::class, 'markScored'])->name('profiles.mark-scored');
        Route::post('/profiles/{profileId}/recommend', [PlacementApiController::class, 'recommend'])->name('recommend');
        Route::post('/profiles/{profileId}/review', [PlacementApiController::class, 'review'])->name('review');
        Route::post('/profiles/{profileId}/approve', [PlacementApiController::class, 'approve'])->name('approve');
        Route::post('/profiles/{profileId}/release', [PlacementApiController::class, 'release'])->name('release');
        Route::post('/profiles/{profileId}/supersede', [PlacementApiController::class, 'supersede'])->name('supersede');
        Route::post('/profiles/{profileId}/report', [PlacementApiController::class, 'registerReport'])->name('profiles.report');
        Route::post('/profiles/{profileId}/appeal', [PlacementApiController::class, 'fileAppeal'])->name('profiles.appeal');
        Route::post('/tests', [PlacementApiController::class, 'defineTest'])->name('tests.define');
        Route::post('/tests/{testId}/transition', [PlacementApiController::class, 'transitionTest'])->name('tests.transition');
        Route::post('/versions', [PlacementApiController::class, 'createVersion'])->name('versions.create');
        Route::post('/versions/{versionId}/publish', [PlacementApiController::class, 'publishVersion'])->name('versions.publish');
        Route::post('/versions/{versionId}/transition', [PlacementApiController::class, 'transitionVersion'])->name('versions.transition');
        Route::post('/sections', [PlacementApiController::class, 'defineSection'])->name('sections.define');
        Route::post('/sections/{sectionId}/transition', [PlacementApiController::class, 'transitionSection'])->name('sections.transition');
        Route::post('/questions', [PlacementApiController::class, 'defineQuestion'])->name('questions.define');
        Route::post('/questions/{questionId}/media', [PlacementApiController::class, 'attachMedia'])->name('questions.media.attach');
        Route::post('/questions/{questionId}/transition', [PlacementApiController::class, 'transitionQuestion'])->name('questions.transition');
        Route::post('/rubrics', [PlacementApiController::class, 'defineRubric'])->name('rubrics.define');
        Route::post('/rubrics/{rubricId}/transition', [PlacementApiController::class, 'transitionRubric'])->name('rubrics.transition');
        Route::post('/attempts/{attemptId}/cancel', [PlacementApiController::class, 'cancelAttempt'])->name('attempts.cancel');
    });

    Route::prefix('crm')->name('api.crm.')->group(function (): void {
        Route::get('/sources', [CrmApiController::class, 'sources'])->name('sources');
        Route::post('/sources', [CrmApiController::class, 'defineSource'])->name('source.define');
        Route::post('/sources/{sourceId}/retire', [CrmApiController::class, 'retireSource'])->name('source.retire');
        Route::get('/campaigns', [CrmApiController::class, 'campaigns'])->name('campaigns');
        Route::post('/campaigns', [CrmApiController::class, 'defineCampaign'])->name('campaign.define');
        Route::post('/campaigns/{campaignId}/retire', [CrmApiController::class, 'retireCampaign'])->name('campaign.retire');
        Route::get('/branches', [CrmApiController::class, 'branches'])->name('branches');
        Route::get('/visitors', [CrmApiController::class, 'index'])->name('visitors.index');
        Route::post('/visitors', [CrmApiController::class, 'captures'])->name('visitors.capture');
        Route::get('/visitors/{visitorId}', [CrmApiController::class, 'show'])->name('visitors.show');
        Route::get('/visitors/{visitorId}/timeline', [CrmApiController::class, 'timeline'])->name('visitors.timeline');
        Route::post('/visitors/{visitorId}/link-person', [CrmApiController::class, 'linkPerson'])->name('visitors.link-person');
        Route::patch('/visitors/{visitorId}', [CrmApiController::class, 'update'])->name('visitors.update');
        Route::post('/visitors/{visitorId}/transition', [CrmApiController::class, 'transition'])->name('visitors.transition');
        Route::post('/visitors/{visitorId}/interactions', [CrmApiController::class, 'interactions'])->name('visitors.interactions');
        Route::post('/visitors/{visitorId}/followups', [CrmApiController::class, 'followups'])->name('visitors.followups');
        Route::post('/followups/{followupId}/complete', [CrmApiController::class, 'completeFollowup'])->name('followups.complete');
        Route::post('/followups/{followupId}/cancel', [CrmApiController::class, 'cancelFollowup'])->name('followups.cancel');
        Route::get('/automation-rules', [CrmApiController::class, 'automationRules'])->name('automation.rules');
        Route::post('/automation-rules', [CrmApiController::class, 'defineAutomationRule'])->name('automation.define');
        Route::post('/automation-rules/{ruleId}/retire', [CrmApiController::class, 'retireAutomationRule'])->name('automation.retire');
    });

    // Workspace/search are projections over canonical module data. Work item
    // transitions coordinate only; source commands remain owning authorities.
    Route::get('/workspace', [WorkspaceApiController::class, 'employee'])->name('api.workspace.employee');
    Route::get('/management', [WorkspaceApiController::class, 'management'])->name('api.workspace.management');
    Route::get('/search', [SearchApiController::class, 'search'])->name('api.search');
    Route::get('/work-items', [WorkManagementApiController::class, 'index'])->name('api.work-items.index');
    Route::post('/work-items/{workItemId}/transition', [WorkManagementApiController::class, 'transition'])->name('api.work-items.transition');
    Route::post('/work-queues/memberships', [WorkManagementApiController::class, 'grantQueueMembership'])->name('api.work-queues.memberships.grant');
    Route::post('/work-queues/memberships/{membershipId}/revoke', [WorkManagementApiController::class, 'revokeQueueMembership'])->name('api.work-queues.memberships.revoke');
    Route::get('/notifications', [NotificationApiController::class, 'index'])->name('api.notifications.index');
    Route::post('/notifications/{notificationId}/read', [NotificationApiController::class, 'read'])->name('api.notifications.read');
    Route::post('/notifications/{notificationId}/dismiss', [NotificationApiController::class, 'dismiss'])->name('api.notifications.dismiss');
});
