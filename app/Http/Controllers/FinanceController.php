<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Modules\Finance\Commands\AllocatePayment;
use App\Modules\Finance\Commands\RecordPayment;
use App\Modules\Finance\Commands\RefundPayment;
use App\Modules\Finance\Models\Discount;
use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Finance\Models\FundingSource;
use App\Modules\Finance\Models\Obligation;
use App\Modules\Finance\Models\Payment;
use App\Modules\Finance\Models\Refund;
use App\Modules\Students\Models\Student;
use App\Support\Authorization\Actor;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\View\View;

/**
 * Finance console: the money surface (obligations, payments, refunds,
 * discounts, funding, periods). Every money movement delegates to the
 * finance module commands — balanced, source-linked, idempotent, and
 * reconciliation-ready. The console never computes financial truth itself.
 */
final class FinanceController extends Controller
{
    public function index(): View
    {
        return view('finance.index', [
            'obligations' => Obligation::query()->orderByDesc('id')->limit(200)->get(),
            'payments' => Payment::query()->orderByDesc('received_on')->limit(200)->get(),
            'refunds' => Refund::query()->orderByDesc('id')->limit(200)->get(),
            'discounts' => Discount::query()->orderByDesc('id')->limit(100)->get(),
            'fundingSources' => FundingSource::query()->orderBy('name')->get(),
            'periods' => FinancialPeriod::query()->orderBy('period_key')->get(),
            'students' => Student::query()->orderBy('student_code')->limit(300)->get(),
        ]);
    }

    public function recordPayment(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'period_id' => ['required', 'string'],
            'student_id' => ['required', 'string'],
            'amount' => ['required', 'numeric', 'gt:0'],
            'method' => ['required', 'string', 'max:40'],
            'payer_ref' => ['required', 'string', 'max:120'],
            'received_on' => ['required', 'date'],
        ]);

        app(RecordPayment::class)->record(
            $this->actor(),
            FinancialPeriod::query()->findOrFail($input['period_id']),
            $input['student_id'],
            $input['amount'],
            $input['method'],
            $input['payer_ref'],
            $input['received_on'],
            $this->idempotencyKey('finance.payment'),
        );

        return redirect()->route('finance.index')->with('success', 'Payment recorded.');
    }

    public function refund(Request $request, string $paymentId): RedirectResponse
    {
        $input = $request->validate([
            'period_id' => ['required', 'string'],
            'amount' => ['required', 'numeric', 'gt:0'],
            'reason' => ['required', 'string', 'max:1000'],
            'approver_id' => ['required', 'string'],
        ]);

        app(RefundPayment::class)->refund(
            $this->actor(),
            new Actor($input['approver_id'], 'Refund Approver'),
            Payment::query()->findOrFail($paymentId),
            FinancialPeriod::query()->findOrFail($input['period_id']),
            $input['amount'],
            $input['reason'],
            $this->idempotencyKey('finance.refund'),
        );

        return redirect()->route('finance.index')->with('success', 'Refund recorded.');
    }

    public function allocate(Request $request, string $obligationId): RedirectResponse
    {
        $input = $request->validate([
            'payment_id' => ['required', 'string'],
            'amount' => ['required', 'numeric', 'gt:0'],
        ]);

        app(AllocatePayment::class)->allocate(
            $this->actor(),
            Payment::query()->findOrFail($input['payment_id']),
            Obligation::query()->findOrFail($obligationId),
            $input['amount'],
            $this->idempotencyKey('finance.allocate'),
        );

        return redirect()->route('finance.index')->with('success', 'Payment allocated to the obligation.');
    }
}
