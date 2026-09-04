<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Modules\Academic\Models\Certificate;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Queries\TranscriptQuery;
use App\Modules\Finance\Models\Obligation;
use App\Modules\Finance\Models\Payment;
use App\Modules\Payroll\Models\PayrollPeriod;
use App\Modules\Payroll\Models\PayrollResult;
use App\Modules\Students\Models\Student;
use Illuminate\View\View;

/**
 * Printing — a first-class capability. Produces operational documents
 * (receipts, invoices, certificates, payroll slips, enrollment records,
 * student IDs) that carry the organization/branch identity, document
 * number, date, and responsible user. Every document consumes the SAME
 * authoritative domain records the console and API read — printing never
 * computes or stores a second financial or academic truth.
 */
final class PrintingController extends Controller
{
    public function paymentReceipt(string $paymentId): View
    {
        $payment = Payment::query()->findOrFail($paymentId);

        return view('print.receipt', [
            'documentNo' => $this->docNo('RCPT', $payment->id),
            'payment' => $payment,
            'student' => Student::query()->whereKey($payment->student_id)->first(),
            'issuedOn' => now()->toDateString(),
        ]);
    }

    public function invoice(string $obligationId): View
    {
        $obligation = Obligation::query()->findOrFail($obligationId);

        return view('print.invoice', [
            'documentNo' => $this->docNo('INV', $obligation->id),
            'obligation' => $obligation,
            'student' => Student::query()->whereKey($obligation->student_id)->first(),
            'issuedOn' => now()->toDateString(),
        ]);
    }

    public function certificate(string $certificateId): View
    {
        $certificate = Certificate::query()->findOrFail($certificateId);

        return view('print.certificate', [
            'documentNo' => $this->docNo('CERT', $certificate->id),
            'certificate' => $certificate,
            'student' => Student::query()->whereKey($certificate->student_id)->first(),
            'issuedOn' => now()->toDateString(),
        ]);
    }

    public function transcript(string $transcriptId): View
    {
        $issued = app(TranscriptQuery::class)->issued($transcriptId);
        abort_if($issued === null, 404);

        return view('print.transcript', [
            'documentNo' => $this->docNo('TRX', $issued['transcript']->id),
            'transcript' => $issued['transcript'],
            'payload' => $issued['payload'],
            'verified' => app(TranscriptQuery::class)->verify($issued['transcript']),
            'issuedOn' => $issued['transcript']->issued_at->toDateString(),
        ]);
    }

    public function payrollSlip(string $resultId): View
    {
        $result = PayrollResult::query()->findOrFail($resultId);
        $period = PayrollPeriod::query()->whereKey($result->period_id)->first();

        return view('print.payroll', [
            'documentNo' => $this->docNo('PAYSLIP', $result->id),
            'result' => $result,
            'period' => $period,
            'issuedOn' => now()->toDateString(),
        ]);
    }

    public function enrollment(string $enrollmentId): View
    {
        $enrollment = Enrollment::query()->findOrFail($enrollmentId);

        return view('print.enrollment', [
            'documentNo' => $this->docNo('ENR', $enrollment->id),
            'enrollment' => $enrollment,
            'student' => Student::query()->whereKey($enrollment->student_id)->first(),
            'issuedOn' => now()->toDateString(),
        ]);
    }

    public function idCard(string $studentId): View
    {
        $student = Student::query()->findOrFail($studentId);

        return view('print.idcard', [
            'documentNo' => $this->docNo('ID', $student->id),
            'student' => $student,
            'issuedOn' => now()->toDateString(),
        ]);
    }

    /** Deterministic, reproducible document number derived from the source record id. */
    private function docNo(string $prefix, string $sourceId): string
    {
        return strtoupper($prefix).'-'.substr(str_replace('-', '', $sourceId), 0, 12);
    }
}
