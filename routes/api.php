<?php

use App\Http\Controllers\Api\AcademicApiController;
use App\Http\Controllers\Api\CrmApiController;
use App\Http\Controllers\Api\FinanceApiController;
use App\Http\Controllers\Api\IdentityApiController;
use App\Http\Controllers\Api\PayrollApiController;
use App\Http\Controllers\Api\PlacementApiController;
use App\Http\Controllers\Api\StudentsApiController;
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

Route::middleware('employee')->group(function (): void {
    Route::get('/me', function (Request $request) {
        /** @var Actor $actor */
        $actor = $request->attributes->get('actor');
        $user = $request->user();

        return response()->json([
            'username' => $user->username,
            'person_id' => $actor->actorId,
            'display_name' => $actor->displayName,
        ]);
    })->name('api.me');

    Route::prefix('students')->name('api.students.')->group(function (): void {
        Route::get('/', [StudentsApiController::class, 'index'])->name('index');
        Route::get('/{studentId}', [StudentsApiController::class, 'show'])->name('show');
        Route::post('/applicants', [StudentsApiController::class, 'registerApplicant'])->name('register');
        Route::post('/applicants/{applicantId}/initiate', [StudentsApiController::class, 'initiate'])->name('initiate');
        Route::post('/decisions/{decisionId}/review', [StudentsApiController::class, 'review'])->name('decision.review');
        Route::post('/decisions/{decisionId}/approve', [StudentsApiController::class, 'approve'])->name('decision.approve');
        Route::post('/applicants/{applicantId}/enroll', [StudentsApiController::class, 'enroll'])->name('enroll');
        Route::post('/{studentId}/transfer', [StudentsApiController::class, 'transfer'])->name('transfer');
        Route::post('/{studentId}/hold', [StudentsApiController::class, 'hold'])->name('hold');
        Route::post('/{studentId}/communication-preference', [StudentsApiController::class, 'communicationPreference'])->name('communication');
    });

    Route::prefix('academic')->name('api.academic.')->group(function (): void {
        Route::get('/sessions', [AcademicApiController::class, 'sessions'])->name('sessions');
        Route::post('/sessions', [AcademicApiController::class, 'schedule'])->name('schedule');
        Route::post('/sessions/{sessionId}/attendance', [AcademicApiController::class, 'attendance'])->name('attendance');
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
        Route::post('/payments', [FinanceApiController::class, 'record'])->name('record');
        Route::post('/payments/{paymentId}/refund', [FinanceApiController::class, 'proposeRefund'])->name('refund.propose');
        Route::post('/refunds/{refundId}/approve', [FinanceApiController::class, 'approveRefund'])->name('refund.approve');
    });

    Route::prefix('payroll')->name('api.payroll.')->group(function (): void {
        Route::get('/periods', [PayrollApiController::class, 'periods'])->name('periods');
        Route::get('/calculations', [PayrollApiController::class, 'calculations'])->name('calculations');
        Route::post('/calculations', [PayrollApiController::class, 'calculate'])->name('calculate');
        Route::post('/calculations/{calculationId}/approve', [PayrollApiController::class, 'approve'])->name('approve');
    });

    Route::prefix('placement')->name('api.placement.')->group(function (): void {
        Route::get('/tests', [PlacementApiController::class, 'tests'])->name('tests');
        Route::get('/versions', [PlacementApiController::class, 'versions'])->name('versions');
        Route::get('/profiles', [PlacementApiController::class, 'profiles'])->name('profiles');
        Route::get('/profiles/{profileId}', [PlacementApiController::class, 'show'])->name('profiles.show');
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
        Route::post('/profiles/{profileId}/appeal', [PlacementApiController::class, 'fileAppeal'])->name('profiles.appeal');
    });

    Route::prefix('crm')->name('api.crm.')->group(function (): void {
        Route::get('/sources', [CrmApiController::class, 'sources'])->name('sources');
        Route::post('/sources', [CrmApiController::class, 'defineSource'])->name('source.define');
        Route::get('/campaigns', [CrmApiController::class, 'campaigns'])->name('campaigns');
        Route::post('/campaigns', [CrmApiController::class, 'defineCampaign'])->name('campaign.define');
        Route::get('/visitors', [CrmApiController::class, 'index'])->name('visitors.index');
        Route::post('/visitors', [CrmApiController::class, 'captures'])->name('visitors.capture');
        Route::get('/visitors/{visitorId}', [CrmApiController::class, 'show'])->name('visitors.show');
        Route::get('/visitors/{visitorId}/timeline', [CrmApiController::class, 'timeline'])->name('visitors.timeline');
        Route::post('/visitors/{visitorId}/link-person', [CrmApiController::class, 'linkPerson'])->name('visitors.link-person');
        Route::patch('/visitors/{visitorId}', [CrmApiController::class, 'update'])->name('visitors.update');
        Route::post('/visitors/{visitorId}/transition', [CrmApiController::class, 'transition'])->name('visitors.transition');
        Route::post('/visitors/{visitorId}/interactions', [CrmApiController::class, 'interactions'])->name('visitors.interactions');
        Route::post('/visitors/{visitorId}/followups', [CrmApiController::class, 'followups'])->name('visitors.followups');
        Route::post('/visitors/{visitorId}/conversion', [CrmApiController::class, 'convert'])->name('visitors.convert');
        Route::post('/followups/{followupId}/complete', [CrmApiController::class, 'completeFollowup'])->name('followups.complete');
        Route::post('/followups/{followupId}/cancel', [CrmApiController::class, 'cancelFollowup'])->name('followups.cancel');
        Route::get('/automation-rules', [CrmApiController::class, 'automationRules'])->name('automation.rules');
        Route::post('/automation-rules', [CrmApiController::class, 'defineAutomationRule'])->name('automation.define');
    });
});
