<?php

use App\Http\Controllers\Api\AcademicApiController;
use App\Http\Controllers\Api\FinanceApiController;
use App\Http\Controllers\Api\IdentityApiController;
use App\Http\Controllers\Api\PayrollApiController;
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
        Route::post('/applicants', [StudentsApiController::class, 'registerApplicant'])->name('register');
        Route::post('/applicants/{applicantId}/initiate', [StudentsApiController::class, 'initiate'])->name('initiate');
        Route::post('/decisions/{decisionId}/review', [StudentsApiController::class, 'review'])->name('decision.review');
        Route::post('/decisions/{decisionId}/approve', [StudentsApiController::class, 'approve'])->name('decision.approve');
        Route::post('/applicants/{applicantId}/enroll', [StudentsApiController::class, 'enroll'])->name('enroll');
    });

    Route::prefix('academic')->name('api.academic.')->group(function (): void {
        Route::get('/sessions', [AcademicApiController::class, 'sessions'])->name('sessions');
        Route::post('/sessions', [AcademicApiController::class, 'schedule'])->name('schedule');
        Route::post('/sessions/{sessionId}/attendance', [AcademicApiController::class, 'attendance'])->name('attendance');
    });

    Route::prefix('identity')->name('api.identity.')->group(function (): void {
        Route::get('/people', [IdentityApiController::class, 'people'])->name('people');
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
});
