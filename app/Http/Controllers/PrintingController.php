<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Modules\Academic\Domain\RecordBranch;
use App\Modules\Academic\Models\Certificate;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Queries\TranscriptQuery;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Finance\Models\Obligation;
use App\Modules\Finance\Models\Payment;
use App\Modules\Hr\Models\Employment;
use App\Modules\Identity\Models\Person;
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
 *
 * Authorization (WP-ACAD-SCOPE) is enforced HERE, at the point where the
 * document is produced — not in the UI that links to it: a record is
 * rendered only when its owning branch is visible to the actor, every
 * production is audit-logged, and every denial is denial-audited. No new
 * read capabilities are invented (writer caps do not map to readers);
 * branch visibility is the control.
 */
final class PrintingController extends Controller
{
    public function paymentReceipt(string $paymentId): View
    {
        $payment = Payment::query()->findOrFail($paymentId);
        $branchId = $this->present($payment->originating_branch_id)
            ?? RecordBranch::studentBranchForId((string) $payment->student_id);
        $documentNo = $this->docNo('RCPT', $payment->id);
        $this->requireBranchVisible($branchId, 'print.receipt', 'payment', $payment->id, 'print.denied');
        $this->recordProduction('print.receipt', 'payment', $payment->id, $documentNo);

        return view('print.receipt', [
            'documentNo' => $documentNo,
            'payment' => $payment,
            'student' => Student::query()->whereKey($payment->student_id)->first(),
            'issuedOn' => now()->toDateString(),
        ]);
    }

    public function invoice(string $obligationId): View
    {
        $obligation = Obligation::query()->findOrFail($obligationId);
        $branchId = $this->present($obligation->originating_branch_id)
            ?? RecordBranch::studentBranchForId((string) $obligation->student_id);
        $documentNo = $this->docNo('INV', $obligation->id);
        $this->requireBranchVisible($branchId, 'print.invoice', 'obligation', $obligation->id, 'print.denied');
        $this->recordProduction('print.invoice', 'obligation', $obligation->id, $documentNo);

        return view('print.invoice', [
            'documentNo' => $documentNo,
            'obligation' => $obligation,
            'student' => Student::query()->whereKey($obligation->student_id)->first(),
            'issuedOn' => now()->toDateString(),
        ]);
    }

    public function certificate(string $certificateId): View
    {
        $certificate = Certificate::query()->findOrFail($certificateId);
        $documentNo = $this->docNo('CERT', $certificate->id);
        $this->requireBranchVisible(RecordBranch::certificateBranch($certificate), 'print.certificate', 'certificate', $certificate->id, 'print.denied');
        $this->recordProduction('print.certificate', 'certificate', $certificate->id, $documentNo);

        return view('print.certificate', [
            'documentNo' => $documentNo,
            'certificate' => $certificate,
            'student' => Student::query()->whereKey($certificate->student_id)->first(),
            'issuedOn' => now()->toDateString(),
        ]);
    }

    public function transcript(string $transcriptId): View
    {
        $issued = app(TranscriptQuery::class)->issued($transcriptId);
        abort_if($issued === null, 404);
        $documentNo = $this->docNo('TRX', $issued['transcript']->id);
        $this->requireBranchVisible(
            RecordBranch::studentBranchForId((string) $issued['transcript']->student_id),
            'print.transcript',
            'transcript',
            (string) $issued['transcript']->id,
            'print.denied',
        );
        $this->recordProduction('print.transcript', 'transcript', (string) $issued['transcript']->id, $documentNo);

        return view('print.transcript', [
            'documentNo' => $documentNo,
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
        $documentNo = $this->docNo('PAYSLIP', $result->id);
        $this->requireBranchVisible($this->payrollBranch($result), 'print.payroll_slip', 'payroll_result', $result->id, 'print.denied');
        $this->recordProduction('print.payroll_slip', 'payroll_result', $result->id, $documentNo);

        return view('print.payroll', [
            'documentNo' => $documentNo,
            'result' => $result,
            'period' => $period,
            'issuedOn' => now()->toDateString(),
        ]);
    }

    public function enrollment(string $enrollmentId): View
    {
        $enrollment = Enrollment::query()->findOrFail($enrollmentId);
        $documentNo = $this->docNo('ENR', $enrollment->id);
        $this->requireBranchVisible(RecordBranch::enrollmentBranch($enrollment), 'print.enrollment', 'enrollment', $enrollment->id, 'print.denied');
        $this->recordProduction('print.enrollment', 'enrollment', $enrollment->id, $documentNo);

        return view('print.enrollment', [
            'documentNo' => $documentNo,
            'enrollment' => $enrollment,
            'student' => Student::query()->whereKey($enrollment->student_id)->first(),
            'issuedOn' => now()->toDateString(),
        ]);
    }

    public function idCard(string $studentId): View
    {
        $student = Student::query()->findOrFail($studentId);
        $documentNo = $this->docNo('ID', $student->id);
        $this->requireBranchVisible(RecordBranch::studentBranchForId($student->id), 'print.id_card', 'student', $student->id, 'print.denied');
        $this->recordProduction('print.id_card', 'student', $student->id, $documentNo);

        return view('print.idcard', [
            'documentNo' => $documentNo,
            'student' => $student,
            'issuedOn' => now()->toDateString(),
        ]);
    }

    /** Deterministic, reproducible document number derived from the source record id. */
    private function docNo(string $prefix, string $sourceId): string
    {
        return strtoupper($prefix).'-'.substr(str_replace('-', '', $sourceId), 0, 12);
    }

    private function recordProduction(string $operation, string $targetType, string $targetId, string $documentNo): void
    {
        app(AuditRecorder::class)->record($this->actor()->actorId, $operation, $targetType, $targetId, null, [
            'document_no' => $documentNo,
        ]);
    }

    private function payrollBranch(PayrollResult $result): ?string
    {
        /** @var Employment|null $employment */
        $employment = Employment::query()->find($result->employment_id);
        if ($employment === null) {
            return null;
        }
        /** @var Person|null $person */
        $person = Person::query()->find($employment->person_id);

        return $person === null ? null : $this->present($person->home_branch_id);
    }

    private function present(mixed $value): ?string
    {
        $trimmed = trim((string) ($value ?? ''));

        return $trimmed === '' ? null : $trimmed;
    }
}
