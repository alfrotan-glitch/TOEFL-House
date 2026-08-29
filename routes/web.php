<?php

use App\Http\Controllers\AcademicController;
use App\Http\Controllers\AuditController;
use App\Http\Controllers\AuthenticationController;
use App\Http\Controllers\FinanceController;
use App\Http\Controllers\HealthController;
use App\Http\Controllers\HomeController;
use App\Http\Controllers\HrController;
use App\Http\Controllers\IdentityController;
use App\Http\Controllers\LibraryController;
use App\Http\Controllers\OrganizationController;
use App\Http\Controllers\PayrollController;
use App\Http\Controllers\PrintingController;
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
        Route::post('people/{personId}/verify', [IdentityController::class, 'verifyPerson'])->name('verify');
        Route::post('accounts', [IdentityController::class, 'linkAccount'])->name('link');
        Route::post('accounts/{accountId}/password', [IdentityController::class, 'setPassword'])->name('password');
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
    });

    // Academic
    Route::prefix('academic')->name('academic.')->group(function (): void {
        Route::get('/', [AcademicController::class, 'index'])->name('index');
        Route::get('sessions', [AcademicController::class, 'sessions'])->name('sessions');
        Route::post('sessions', [AcademicController::class, 'scheduleSession'])->name('schedule');
        Route::post('sessions/{sessionId}/attendance', [AcademicController::class, 'recordAttendance'])->name('attendance');
        Route::post('enrollments', [AcademicController::class, 'requestEnrollment'])->name('enrollment.request');
        Route::post('enrollments/{enrollmentId}/activate', [AcademicController::class, 'activateEnrollment'])->name('enrollment.activate');
        Route::post('progressions', [AcademicController::class, 'proposeProgression'])->name('progression.propose');
        Route::post('progressions/{decisionId}/review', [AcademicController::class, 'reviewProgression'])->name('progression.review');
        Route::post('progressions/{decisionId}/approve', [AcademicController::class, 'approveProgression'])->name('progression.approve');
    });

    // Teachers & HR
    Route::prefix('hr')->name('hr.')->group(function (): void {
        Route::get('/', [HrController::class, 'index'])->name('index');
        Route::post('employ', [HrController::class, 'employ'])->name('employ');
        Route::get('contracts', [HrController::class, 'contracts'])->name('contracts');
        Route::post('versions/prepare', [HrController::class, 'prepareVersion'])->name('version.prepare');
        Route::post('versions/{versionId}/rule', [HrController::class, 'addRule'])->name('version.rule');
        Route::post('versions/{versionId}/submit', [HrController::class, 'submitVersion'])->name('version.submit');
        Route::post('versions/{versionId}/withdraw', [HrController::class, 'withdrawVersion'])->name('version.withdraw');
        Route::post('versions/{versionId}/approve', [HrController::class, 'approveVersion'])->name('version.approve');
    });

    // Library & Resources
    Route::prefix('library')->name('library.')->group(function (): void {
        Route::get('/', [LibraryController::class, 'index'])->name('index');
        Route::post('books/{copyId}/issue', [LibraryController::class, 'issueBook'])->name('issue');
        Route::post('issuances/{issuanceId}/return', [LibraryController::class, 'returnBook'])->name('return');
        Route::post('issuances/{issuanceId}/loss', [LibraryController::class, 'reportLoss'])->name('loss');
    });

    // Finance
    Route::prefix('finance')->name('finance.')->group(function (): void {
        Route::get('/', [FinanceController::class, 'index'])->name('index');
        Route::post('payments', [FinanceController::class, 'recordPayment'])->name('payment');
        Route::post('obligations', [FinanceController::class, 'postObligation'])->name('obligation.post');
        Route::post('payments/{paymentId}/refund', [FinanceController::class, 'refund'])->name('refund');
        Route::post('refunds/{refundId}/approve', [FinanceController::class, 'approveRefund'])->name('refund.approve');
        Route::post('obligations/{obligationId}/allocate', [FinanceController::class, 'allocate'])->name('allocate');
    });

    // Payroll
    Route::prefix('payroll')->name('payroll.')->group(function (): void {
        Route::get('/', [PayrollController::class, 'index'])->name('index');
        Route::post('periods', [PayrollController::class, 'openPeriod'])->name('period');
        Route::post('periods/{periodId}/close', [PayrollController::class, 'closePeriod'])->name('period.close');
        Route::post('periods/{periodId}/calculate', [PayrollController::class, 'calculate'])->name('calculate');
        Route::post('calculations/{calculationId}/approve', [PayrollController::class, 'approve'])->name('approve');
    });

    // Reporting & Dashboards
    Route::prefix('reporting')->name('reporting.')->group(function (): void {
        Route::get('/', [ReportingController::class, 'index'])->name('index');
        Route::post('reports', [ReportingController::class, 'runReport'])->name('run');
        Route::post('dashboards', [ReportingController::class, 'createDashboard'])->name('dashboard.create');
        Route::post('dashboards/{dashboardId}/pin', [ReportingController::class, 'pinDashboard'])->name('dashboard.pin');
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
        Route::get('payroll/{resultId}', [PrintingController::class, 'payrollSlip'])->name('payroll');
        Route::get('enrollment/{enrollmentId}', [PrintingController::class, 'enrollment'])->name('enrollment');
        Route::get('id-card/{studentId}', [PrintingController::class, 'idCard'])->name('idcard');
    });
});
