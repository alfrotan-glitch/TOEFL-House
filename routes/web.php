<?php

use App\Http\Controllers\AcademicController;
use App\Http\Controllers\AccessController;
use App\Http\Controllers\AuditController;
use App\Http\Controllers\AuthenticationController;
use App\Http\Controllers\CommunicationController;
use App\Http\Controllers\CrmController;
use App\Http\Controllers\DocumentsController;
use App\Http\Controllers\FinanceController;
use App\Http\Controllers\HealthController;
use App\Http\Controllers\HomeController;
use App\Http\Controllers\HrController;
use App\Http\Controllers\IdentityController;
use App\Http\Controllers\LibraryController;
use App\Http\Controllers\OrganizationController;
use App\Http\Controllers\PayrollController;
use App\Http\Controllers\PlacementController;
use App\Http\Controllers\PrintingController;
use App\Http\Controllers\PrivacyController;
use App\Http\Controllers\ReportingController;
use App\Http\Controllers\StudentsController;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| Employee Console (The TOEFL House)
|--------------------------------------------------------------------------
|
| Server-rendered employee interface. Routes are a thin transport boundary:
| they authenticate the employee session, then delegate to the module
| command/query surface. Business rules, authorization, idempotency, and
| audit are owned by the domain commands, never by routes or views.
|
*/

Route::get('/login', [AuthenticationController::class, 'show'])->name('login');
// Brute-force protection: small per-(IP, username) allowance (throttle:login).
Route::post('/login', [AuthenticationController::class, 'login'])->middleware('throttle:login')->name('login.submit');

// Production health/readiness probe — public, minimal, no secrets. Distinct
// from /up (framework liveness): /health also verifies the database and the
// runtime configuration, so an orchestrator can gate traffic on it.
Route::get('/health', HealthController::class)->name('health');

Route::middleware('employee')->group(function (): void {
    Route::post('/logout', [AuthenticationController::class, 'logout'])->name('logout');
    Route::get('/', [HomeController::class, 'index'])->name('home');

    // Organization & Configuration
    Route::prefix('organization')->name('organization.')->group(function (): void {
        Route::get('/', [OrganizationController::class, 'index'])->name('index');
    });

    // Identity & Access
    Route::prefix('identity')->name('identity.')->group(function (): void {
        Route::get('/', [IdentityController::class, 'index'])->name('index');
        Route::post('people', [IdentityController::class, 'registerPerson'])->name('person.register');
        Route::post('people/{personId}/verify', [IdentityController::class, 'verifyPerson'])->name('verify');
        Route::post('accounts', [IdentityController::class, 'linkAccount'])->name('link');
        Route::post('accounts/{accountId}/password', [IdentityController::class, 'setPassword'])->name('password');
        Route::post('accounts/{accountId}/deactivate', [IdentityController::class, 'deactivateAccount'])->name('deactivate');
    });

    // Students & Admissions
    Route::prefix('students')->name('students.')->group(function (): void {
        Route::get('/', [StudentsController::class, 'index'])->name('index');
        Route::get('applicants', [StudentsController::class, 'applicants'])->name('applicants');
        Route::post('applicants', [StudentsController::class, 'registerApplicant'])->name('register');
        Route::post('applicants/{applicantId}/initiate', [StudentsController::class, 'initiateAdmission'])->name('initiate');
        Route::post('decisions/{decisionId}/review', [StudentsController::class, 'reviewAdmission'])->name('decision.review');
        Route::post('decisions/{decisionId}/approve', [StudentsController::class, 'approveAdmission'])->name('decision.approve');
        Route::post('applicants/{applicantId}/enroll', [StudentsController::class, 'enroll'])->name('enroll');
        Route::get('students/{studentId}', [StudentsController::class, 'show'])->name('show');
        Route::post('students/{studentId}/status/{action}', [StudentsController::class, 'transitionStatus'])->where('action', 'suspend|withdraw|reactivate|complete|graduate')->name('status');
        Route::post('students/{studentId}/guardians', [StudentsController::class, 'recordGuardian'])->name('guardian.record');
        Route::post('guardians/{relationshipId}/verify', [StudentsController::class, 'verifyGuardian'])->name('guardian.verify');
        Route::post('guardians/{relationshipId}/revoke', [StudentsController::class, 'revokeGuardian'])->name('guardian.revoke');
        Route::post('students/{studentId}/transfer', [StudentsController::class, 'transferBranch'])->name('transfer');
        Route::post('students/{studentId}/hold/freeze', [StudentsController::class, 'freezeStudent'])->name('hold.freeze');
        Route::post('students/{studentId}/hold/resume', [StudentsController::class, 'resumeStudent'])->name('hold.resume');
        Route::post('students/{studentId}/communication', [StudentsController::class, 'setCommunicationPreference'])->name('communication');
    });

    // Visitor / Lead / CRM
    Route::prefix('crm')->name('crm.')->group(function (): void {
        Route::get('/', [CrmController::class, 'index'])->name('index');
        Route::post('visitors', [CrmController::class, 'capture'])->name('capture');
        Route::post('visitors/{visitorId}/transition', [CrmController::class, 'transition'])->name('transition');
        Route::post('visitors/{visitorId}/interactions', [CrmController::class, 'interaction'])->name('interaction');
        Route::post('visitors/{visitorId}/link-person', [CrmController::class, 'linkPerson'])->name('link-person');
        Route::post('visitors/{visitorId}/followups', [CrmController::class, 'followup'])->name('followup');
        Route::post('visitors/{visitorId}/convert', [CrmController::class, 'convert'])->name('convert');
        Route::post('followups/{followupId}/complete', [CrmController::class, 'completeFollowup'])->name('followup.complete');
        Route::post('followups/{followupId}/cancel', [CrmController::class, 'cancelFollowup'])->name('followup.cancel');
        Route::post('sources', [CrmController::class, 'defineSource'])->name('source.define');
        Route::post('campaigns', [CrmController::class, 'defineCampaign'])->name('campaign.define');
        Route::post('automation-rules', [CrmController::class, 'defineAutomationRule'])->name('automation.define');
    });

    // Academic
    Route::prefix('academic')->name('academic.')->group(function (): void {
        Route::get('/', [AcademicController::class, 'index'])->name('index');
        Route::post('programs', [AcademicController::class, 'defineProgram'])->name('program.define');
        Route::post('programs/{programId}/versions', [AcademicController::class, 'publishProgramVersion'])->name('version.publish');
        Route::post('periods', [AcademicController::class, 'definePeriod'])->name('period.define');
        Route::post('periods/{periodId}/transition', [AcademicController::class, 'transitionPeriod'])->name('period.transition');
        Route::post('levels', [AcademicController::class, 'defineLevel'])->name('level.define');
        Route::post('levels/prerequisites', [AcademicController::class, 'definePrerequisite'])->name('level.prerequisite.define');
        Route::post('levels/prerequisites/{prerequisiteId}/retire', [AcademicController::class, 'retirePrerequisite'])->name('level.prerequisite.retire');
        Route::post('levels/rules', [AcademicController::class, 'defineProgressionRule'])->name('level.rule.define');
        Route::post('levels/rules/{ruleId}/retire', [AcademicController::class, 'retireProgressionRule'])->name('level.rule.retire');
        Route::post('skills', [AcademicController::class, 'registerSkill'])->name('skill.register');
        Route::post('skills/{skillId}/retire', [AcademicController::class, 'retireSkill'])->name('skill.retire');
        Route::post('classes', [AcademicController::class, 'defineClass'])->name('class.define');
        Route::post('classes/{classId}/transition', [AcademicController::class, 'transitionClass'])->name('class.transition');
        Route::post('teacher-assignments', [AcademicController::class, 'assignTeacher'])->name('teacher.assign');
        Route::post('teacher-assignments/{assignmentId}/end', [AcademicController::class, 'endAssignment'])->name('teacher.end');
        Route::post('teacher-assignments/{assignmentId}/extend', [AcademicController::class, 'extendAssignment'])->name('teacher.extend');
        Route::post('teacher-assignments/{assignmentId}/handover', [AcademicController::class, 'handoverAssignment'])->name('teacher.handover');
        Route::get('sessions', [AcademicController::class, 'sessions'])->name('sessions');
        Route::post('sessions', [AcademicController::class, 'scheduleSession'])->name('schedule');
        Route::post('sessions/{sessionId}/attendance', [AcademicController::class, 'recordAttendance'])->name('attendance');
        Route::post('sessions/facts/{factId}/correct', [AcademicController::class, 'correctAttendance'])->name('attendance.correct');
        Route::post('rooms', [AcademicController::class, 'defineRoom'])->name('room.define');
        Route::post('rooms/{roomId}/transition', [AcademicController::class, 'transitionRoom'])->name('room.transition');
        Route::post('rooms/{roomId}/resize', [AcademicController::class, 'resizeRoom'])->name('room.resize');
        Route::post('sections', [AcademicController::class, 'defineSection'])->name('section.define');
        Route::post('sections/{sectionId}/transition', [AcademicController::class, 'transitionSection'])->name('section.transition');
        Route::post('enrollments', [AcademicController::class, 'requestEnrollment'])->name('enrollment.request');
        Route::post('enrollments/{enrollmentId}/activate', [AcademicController::class, 'activateEnrollment'])->name('enrollment.activate');
        Route::post('enrollments/{enrollmentId}/freeze', [AcademicController::class, 'freezeEnrollment'])->name('enrollment.freeze');
        Route::post('enrollments/{enrollmentId}/unfreeze', [AcademicController::class, 'unfreezeEnrollment'])->name('enrollment.unfreeze');
        Route::post('enrollments/{enrollmentId}/withdraw', [AcademicController::class, 'withdrawEnrollment'])->name('enrollment.withdraw');
        Route::post('enrollments/{enrollmentId}/complete', [AcademicController::class, 'completeEnrollment'])->name('enrollment.complete');
        Route::post('enrollments/{enrollmentId}/transfer', [AcademicController::class, 'transferEnrollment'])->name('enrollment.transfer');
        Route::post('progressions', [AcademicController::class, 'proposeProgression'])->name('progression.propose');
        Route::post('progressions/{decisionId}/review', [AcademicController::class, 'reviewProgression'])->name('progression.review');
        Route::post('progressions/{decisionId}/approve', [AcademicController::class, 'approveProgression'])->name('progression.approve');
        Route::post('progressions/{decisionId}/reject', [AcademicController::class, 'rejectProgression'])->name('progression.reject');
        Route::post('progressions/{decisionId}/mark-appealed', [AcademicController::class, 'markProgressionAppealed'])->name('progression.mark-appealed');
        Route::post('progressions/{decisionId}/supersede', [AcademicController::class, 'supersedeProgression'])->name('progression.supersede');
        Route::post('attempts', [AcademicController::class, 'submitAssessmentAttempt'])->name('attempt.submit');
        Route::post('attempts/{attemptId}/score', [AcademicController::class, 'scoreAttempt'])->name('attempt.score');
        Route::post('results/{resultId}/moderate', [AcademicController::class, 'moderateResult'])->name('result.moderate');
        Route::post('results/{resultId}/approve', [AcademicController::class, 'approveResult'])->name('result.approve');
        Route::post('results/{resultId}/release', [AcademicController::class, 'releaseResult'])->name('result.release');
        Route::post('results/{resultId}/mark-appealed', [AcademicController::class, 'markResultAppealed'])->name('result.mark-appealed');
        Route::post('results/{resultId}/corrections', [AcademicController::class, 'proposeCorrection'])->name('result.correction');
        Route::post('corrections/{correctionId}/approve', [AcademicController::class, 'approveCorrection'])->name('correction.approve');
        Route::post('waitlist', [AcademicController::class, 'joinWaitlist'])->name('waitlist.join');
        Route::post('waitlist/{entryId}/offer', [AcademicController::class, 'offerWaitlistEntry'])->name('waitlist.offer');
        Route::post('waitlist/{entryId}/promote', [AcademicController::class, 'promoteWaitlistEntry'])->name('waitlist.promote');
        Route::post('waitlist/{entryId}/withdraw', [AcademicController::class, 'withdrawWaitlistEntry'])->name('waitlist.withdraw');
        Route::post('waitlist/{entryId}/expire', [AcademicController::class, 'expireWaitlistEntry'])->name('waitlist.expire');
        Route::get('gradesheets/{classId}', [AcademicController::class, 'gradesheet'])->name('gradesheet');
        Route::post('graduations', [AcademicController::class, 'proposeGraduation'])->name('graduation.propose');
        Route::post('graduations/{decisionId}/review', [AcademicController::class, 'reviewGraduation'])->name('graduation.review');
        Route::post('graduations/{decisionId}/approve', [AcademicController::class, 'approveGraduation'])->name('graduation.approve');
        Route::post('graduations/{decisionId}/reject', [AcademicController::class, 'rejectGraduation'])->name('graduation.reject');
        Route::post('graduations/{decisionId}/certificate', [AcademicController::class, 'issueCertificate'])->name('graduation.certificate');
        Route::post('transcripts', [AcademicController::class, 'issueTranscript'])->name('transcript.issue');
        Route::post('availabilities', [AcademicController::class, 'declareAvailability'])->name('availability.declare');
        Route::post('availabilities/{availabilityId}/close', [AcademicController::class, 'closeAvailability'])->name('availability.close');
        Route::post('availabilities/{availabilityId}/reopen', [AcademicController::class, 'reopenAvailability'])->name('availability.reopen');
        Route::post('offerings', [AcademicController::class, 'openOffering'])->name('offering.open');
        Route::post('offerings/{offeringId}/close', [AcademicController::class, 'closeOffering'])->name('offering.close');
        Route::post('offerings/{offeringId}/reopen', [AcademicController::class, 'reopenOffering'])->name('offering.reopen');
        Route::post('offerings/{offeringId}/cancel', [AcademicController::class, 'cancelOffering'])->name('offering.cancel');
        Route::post('offerings/{offeringId}/complete', [AcademicController::class, 'completeOffering'])->name('offering.complete');
        Route::post('offerings/{offeringId}/resize', [AcademicController::class, 'resizeOffering'])->name('offering.resize');
        Route::post('appeals', [AcademicController::class, 'fileAppeal'])->name('appeal.file');
        Route::post('appeals/{appealId}/assign', [AcademicController::class, 'assignAppeal'])->name('appeal.assign');
        Route::post('appeals/{appealId}/investigate', [AcademicController::class, 'investigateAppeal'])->name('appeal.investigate');
        Route::post('appeals/{appealId}/resolve', [AcademicController::class, 'resolveAppeal'])->name('appeal.resolve');
        Route::post('appeals/{appealId}/reject', [AcademicController::class, 'rejectAppeal'])->name('appeal.reject');
        Route::post('appeals/{appealId}/escalate', [AcademicController::class, 'escalateAppeal'])->name('appeal.escalate');
        Route::post('appeals/{appealId}/close', [AcademicController::class, 'closeAppeal'])->name('appeal.close');
    });

    // Placement Decision System
    Route::prefix('placement')->name('placement.')->group(function (): void {
        Route::get('/', [PlacementController::class, 'index'])->name('index');
        Route::get('profiles/{profileId}', [PlacementController::class, 'show'])->name('show');
        Route::post('profiles', [PlacementController::class, 'openProfile'])->name('profile.open');
        Route::post('attempts', [PlacementController::class, 'startAttempt'])->name('attempt.start');
        Route::post('attempts/{attemptId}/submit', [PlacementController::class, 'submitDigital'])->name('attempt.submit');
        Route::post('attempts/{attemptId}/submit-physical', [PlacementController::class, 'submitPhysical'])->name('attempt.submit-physical');
        Route::post('sections/score', [PlacementController::class, 'scoreSection'])->name('section.score');
        Route::post('sections/results/{sectionResultId}/moderate', [PlacementController::class, 'moderateSection'])->name('section.moderate');
        Route::post('sections/results/{sectionResultId}/approve', [PlacementController::class, 'approveSection'])->name('section.approve');
        Route::post('profiles/{profileId}/mark-scored', [PlacementController::class, 'markScored'])->name('mark-scored');
        Route::post('profiles/{profileId}/recommend', [PlacementController::class, 'recommend'])->name('recommend');
        Route::post('profiles/{profileId}/review', [PlacementController::class, 'review'])->name('review');
        Route::post('profiles/{profileId}/approve', [PlacementController::class, 'approveProfile'])->name('approve');
        Route::post('profiles/{profileId}/release', [PlacementController::class, 'releaseProfile'])->name('release');
        Route::post('profiles/{profileId}/supersede', [PlacementController::class, 'supersedeProfile'])->name('supersede');
        Route::post('profiles/{profileId}/report', [PlacementController::class, 'registerReport'])->name('report.register');
        Route::post('tests', [PlacementController::class, 'defineTest'])->name('test.define');
        Route::post('tests/{testId}/publish', [PlacementController::class, 'publishTest'])->name('test.publish');
        Route::post('versions', [PlacementController::class, 'createVersion'])->name('version.create');
        Route::post('versions/{versionId}/publish', [PlacementController::class, 'publishVersion'])->name('version.publish');
        Route::post('sections', [PlacementController::class, 'defineSection'])->name('section.define');
        Route::post('sections/{sectionId}/transition', [PlacementController::class, 'transitionSection'])->name('section.transition');
        Route::post('questions', [PlacementController::class, 'defineQuestion'])->name('question.define');
        Route::post('rubrics', [PlacementController::class, 'defineRubric'])->name('rubric.define');
    });

    // Teachers & HR
    Route::prefix('hr')->name('hr.')->group(function (): void {
        Route::get('/', [HrController::class, 'index'])->name('index');
        Route::post('employ', [HrController::class, 'employ'])->name('employ');
        Route::post('employments/hire', [HrController::class, 'hire'])->name('employment.hire');
        Route::post('employments/leave', [HrController::class, 'placeOnLeave'])->name('employment.leave');
        Route::post('employments/suspend', [HrController::class, 'suspendEmployment'])->name('employment.suspend');
        Route::post('employments/reinstate', [HrController::class, 'reinstateEmployment'])->name('employment.reinstate');
        Route::post('employments/terminate', [HrController::class, 'terminateEmployment'])->name('employment.terminate');
        Route::get('contracts', [HrController::class, 'contracts'])->name('contracts');
        Route::post('contracts/draft', [HrController::class, 'draftContract'])->name('contract.draft');
        Route::post('contracts/{contractId}/sign', [HrController::class, 'signContract'])->name('contract.sign');
        Route::post('contracts/{contractId}/close', [HrController::class, 'closeContract'])->name('contract.close');
        Route::post('versions/prepare', [HrController::class, 'prepareVersion'])->name('version.prepare');
        Route::post('versions/{versionId}/rule', [HrController::class, 'addRule'])->name('version.rule');
        Route::post('versions/{versionId}/submit', [HrController::class, 'submitVersion'])->name('version.submit');
        Route::post('versions/{versionId}/withdraw', [HrController::class, 'withdrawVersion'])->name('version.withdraw');
        Route::post('versions/{versionId}/approve', [HrController::class, 'approveVersion'])->name('version.approve');
        Route::post('employments/{employmentId}/leave', [HrController::class, 'requestLeave'])->name('leave.request');
        Route::post('leaves/{leaveId}/decide', [HrController::class, 'decideLeave'])->name('leave.decide');
        Route::post('leaves/{leaveId}/cancel', [HrController::class, 'cancelLeave'])->name('leave.cancel');
        Route::post('scales', [HrController::class, 'registerScale'])->name('scale.register');
        Route::post('scales/{scaleId}/retire', [HrController::class, 'retireScale'])->name('scale.retire');
    });

    // Library & Resources
    Route::prefix('library')->name('library.')->group(function (): void {
        Route::get('/', [LibraryController::class, 'index'])->name('index');
        Route::post('assets', [LibraryController::class, 'registerAsset'])->name('asset.register');
        Route::post('assets/{assetId}/custody', [LibraryController::class, 'assignCustody'])->name('custody.assign');
        Route::post('assets/{assetId}/custody/release', [LibraryController::class, 'releaseCustody'])->name('custody.release');
        Route::post('assets/{assetId}/disposal', [LibraryController::class, 'requestDisposal'])->name('disposal.request');
        Route::post('disposals/{requestId}/approve', [LibraryController::class, 'approveDisposal'])->name('disposal.approve');
        Route::post('disposals/{requestId}/execute', [LibraryController::class, 'executeDisposal'])->name('disposal.execute');
        Route::post('work-orders', [LibraryController::class, 'requestWork'])->name('work.request');
        Route::post('work-orders/{orderId}/approve', [LibraryController::class, 'approveWork'])->name('work.approve');
        Route::post('work-orders/{orderId}/start', [LibraryController::class, 'startWork'])->name('work.start');
        Route::post('work-orders/{orderId}/complete', [LibraryController::class, 'completeWork'])->name('work.complete');
        Route::post('work-orders/{orderId}/cancel', [LibraryController::class, 'cancelWork'])->name('work.cancel');
        Route::post('books/{copyId}/issue', [LibraryController::class, 'issueBook'])->name('issue');
        Route::post('issuances/{issuanceId}/return', [LibraryController::class, 'returnBook'])->name('return');
        Route::post('issuances/{issuanceId}/loss', [LibraryController::class, 'reportLoss'])->name('loss');
    });

    // Finance
    Route::prefix('finance')->name('finance.')->group(function (): void {
        Route::get('/', [FinanceController::class, 'index'])->name('index');
        Route::post('periods', [FinanceController::class, 'openFinancialPeriod'])->name('period.open');
        Route::post('periods/{periodId}/close', [FinanceController::class, 'closeFinancialPeriod'])->name('period.close');
        Route::post('payments', [FinanceController::class, 'recordPayment'])->name('payment');
        Route::post('obligations', [FinanceController::class, 'postObligation'])->name('obligation.post');
        Route::post('payments/{paymentId}/refund', [FinanceController::class, 'refund'])->name('refund');
        Route::post('refunds/{refundId}/approve', [FinanceController::class, 'approveRefund'])->name('refund.approve');
        Route::post('obligations/{obligationId}/allocate', [FinanceController::class, 'allocate'])->name('allocate');
        Route::post('accounts', [FinanceController::class, 'defineAccount'])->name('account.define');
        Route::post('journals', [FinanceController::class, 'postJournal'])->name('journal.post');
        Route::post('journals/{journalId}/reverse', [FinanceController::class, 'reverseJournal'])->name('journal.reverse');
        Route::post('discounts', [FinanceController::class, 'proposeDiscount'])->name('discount.propose');
        Route::post('discounts/{discountId}/approve', [FinanceController::class, 'approveDiscount'])->name('discount.approve');
        Route::post('reconciliations', [FinanceController::class, 'observeReconciliation'])->name('reconciliation.observe');
        Route::post('reconciliations/{reconciliationId}/approve', [FinanceController::class, 'approveReconciliation'])->name('reconciliation.approve');
        Route::post('funds', [FinanceController::class, 'establishFund'])->name('fund.establish');
        Route::post('funds/{fundId}/allocations', [FinanceController::class, 'allocateFund'])->name('fund.allocate');
        Route::post('credits', [FinanceController::class, 'proposeCredit'])->name('credit.propose');
        Route::post('credits/{creditId}/approve', [FinanceController::class, 'approveCredit'])->name('credit.approve');
        Route::post('installments', [FinanceController::class, 'proposeInstallment'])->name('installment.propose');
        Route::post('installments/{planId}/approve', [FinanceController::class, 'approveInstallment'])->name('installment.approve');
        Route::post('gate-exceptions', [FinanceController::class, 'proposeGateException'])->name('gate_exception.propose');
        Route::post('gate-exceptions/{exceptionId}/approve', [FinanceController::class, 'approveGateException'])->name('gate_exception.approve');
    });

    // Communication
    Route::prefix('communication')->name('communication.')->group(function (): void {
        Route::get('/', [CommunicationController::class, 'index'])->name('index');
        Route::post('messages', [CommunicationController::class, 'queueMessage'])->name('message.queue');
        Route::post('messages/{messageId}/delivered', [CommunicationController::class, 'markDelivered'])->name('message.delivered');
        Route::post('messages/{messageId}/failed', [CommunicationController::class, 'markFailed'])->name('message.failed');
    });

    // Payroll
    Route::prefix('payroll')->name('payroll.')->group(function (): void {
        Route::get('/', [PayrollController::class, 'index'])->name('index');
        Route::post('periods', [PayrollController::class, 'openPeriod'])->name('period');
        Route::post('periods/{periodId}/close', [PayrollController::class, 'closePeriod'])->name('period.close');
        Route::post('periods/{periodId}/calculate', [PayrollController::class, 'calculate'])->name('calculate');
        Route::post('calculations/{calculationId}/approve', [PayrollController::class, 'approve'])->name('approve');
        Route::post('employments/{employmentId}/clearance', [PayrollController::class, 'clear'])->name('clearance');
        Route::post('employments/{employmentId}/settlements', [PayrollController::class, 'proposeSettlement'])->name('settlement.propose');
        Route::post('settlements/{proposalId}/approve', [PayrollController::class, 'approveSettlement'])->name('settlement.approve');
    });

    // Reporting & Dashboards
    Route::prefix('reporting')->name('reporting.')->group(function (): void {
        Route::get('/', [ReportingController::class, 'index'])->name('index');
        Route::post('reports', [ReportingController::class, 'runReport'])->name('run');
        Route::post('dashboards', [ReportingController::class, 'createDashboard'])->name('dashboard.create');
        Route::post('dashboards/{dashboardId}/pin', [ReportingController::class, 'pinDashboard'])->name('dashboard.pin');
    });

    // Documents & Evidence
    Route::prefix('documents')->name('documents.')->group(function (): void {
        Route::get('/', [DocumentsController::class, 'index'])->name('index');
        Route::post('classifications', [DocumentsController::class, 'defineClassification'])->name('classification.define');
        Route::post('retention-rules', [DocumentsController::class, 'defineRetentionRule'])->name('retention.rule');
        Route::post('', [DocumentsController::class, 'registerDocument'])->name('register');
        Route::post('{documentId}/submit', [DocumentsController::class, 'submitDocument'])->name('submit');
        Route::post('{documentId}/verify', [DocumentsController::class, 'verifyDocument'])->name('verify');
        Route::post('{documentId}/activate', [DocumentsController::class, 'activateDocument'])->name('activate');
        Route::post('{documentId}/expire', [DocumentsController::class, 'expireDocument'])->name('expire');
        Route::post('{documentId}/archive', [DocumentsController::class, 'archiveDocument'])->name('archive');
        Route::post('{documentId}/retention', [DocumentsController::class, 'decideRetention'])->name('retention.decide');
    });

    // Access administration
    Route::prefix('access')->name('access.')->group(function (): void {
        Route::get('/', [AccessController::class, 'index'])->name('index');
        Route::post('assignments', [AccessController::class, 'assignPosition'])->name('assignment.assign');
        Route::post('assignments/{assignmentId}/activate', [AccessController::class, 'activateAssignment'])->name('assignment.activate');
        Route::post('assignments/{assignmentId}/revoke', [AccessController::class, 'revokeAssignment'])->name('assignment.revoke');
        Route::post('policies/position-role', [AccessController::class, 'bindPositionRole'])->name('policy.bind');
        Route::post('policies/role-permission', [AccessController::class, 'grantRolePermission'])->name('policy.permission');
        Route::post('grants', [AccessController::class, 'grantPermission'])->name('grant.create');
        Route::post('grants/org-wide', [AccessController::class, 'requestOrgWideGrant'])->name('grant.request_org_wide');
        Route::post('grants/org-wide/{requestId}/approve', [AccessController::class, 'approveOrgWideGrant'])->name('grant.approve_org_wide');
        Route::post('grants/org-wide/{requestId}/execute', [AccessController::class, 'executeOrgWideGrant'])->name('grant.execute_org_wide');
        Route::post('grants/{grantId}/revoke', [AccessController::class, 'revokeGrant'])->name('grant.revoke');
        Route::post('delegations', [AccessController::class, 'delegate'])->name('delegation.create');
        Route::post('delegations/{delegationId}/revoke', [AccessController::class, 'revokeDelegation'])->name('delegation.revoke');
    });

    // Privacy
    Route::prefix('privacy')->name('privacy.')->group(function (): void {
        Route::get('/', [PrivacyController::class, 'index'])->name('index');
        Route::post('purposes', [PrivacyController::class, 'definePurpose'])->name('purpose.define');
        Route::post('consents', [PrivacyController::class, 'recordConsent'])->name('consent.record');
        Route::post('consents/{consentId}/submit', [PrivacyController::class, 'submitConsent'])->name('consent.submit');
        Route::post('consents/{consentId}/verify', [PrivacyController::class, 'verifyConsent'])->name('consent.verify');
        Route::post('consents/{consentId}/activate', [PrivacyController::class, 'activateConsent'])->name('consent.activate');
        Route::post('consents/{consentId}/revoke', [PrivacyController::class, 'revokeConsent'])->name('consent.revoke');
        Route::post('consents/{consentId}/archive', [PrivacyController::class, 'archiveConsent'])->name('consent.archive');
        Route::post('disclosures', [PrivacyController::class, 'recordDisclosure'])->name('disclosure.record');
        Route::post('exports', [PrivacyController::class, 'directExport'])->name('export.direct');
        Route::post('exports/bulk', [PrivacyController::class, 'requestExport'])->name('export.request');
        Route::post('exports/{requestId}/approve', [PrivacyController::class, 'approveExport'])->name('export.approve');
        Route::post('exports/{requestId}/execute', [PrivacyController::class, 'executeExport'])->name('export.execute');
    });

    // Audit & Governance
    Route::prefix('audit')->name('audit.')->group(function (): void {
        Route::get('/', [AuditController::class, 'index'])->name('index');
    });

    // Printing (operational documents)
    Route::prefix('print')->name('print.')->group(function (): void {
        Route::get('receipt/{paymentId}', [PrintingController::class, 'paymentReceipt'])->name('receipt');
        Route::get('invoice/{obligationId}', [PrintingController::class, 'invoice'])->name('invoice');
        Route::get('certificate/{certificateId}', [PrintingController::class, 'certificate'])->name('certificate');
        Route::get('transcript/{transcriptId}', [PrintingController::class, 'transcript'])->name('transcript');
        Route::get('payroll/{resultId}', [PrintingController::class, 'payrollSlip'])->name('payroll');
        Route::get('enrollment/{enrollmentId}', [PrintingController::class, 'enrollment'])->name('enrollment');
        Route::get('id-card/{studentId}', [PrintingController::class, 'idCard'])->name('idcard');
    });
});
