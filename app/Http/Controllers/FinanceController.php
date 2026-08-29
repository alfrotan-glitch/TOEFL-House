<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Modules\Finance\Commands\AllocatePayment;
use App\Modules\Finance\Commands\PostObligation;
use App\Modules\Finance\Commands\RecordPayment;
use App\Modules\Finance\Commands\RefundPayment;
use App\Modules\Finance\Models\Discount;
use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Finance\Models\FundingSource;
use App\Modules\Finance\Models\Obligation;
use App\Modules\Finance\Models\Payment;
use App\Modules\Finance\Models\Refund;
use App\Modules\Students\Models\Student;
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
            'refunds' => Refund::query()->where('lifecycle_state', 'recorded')->orderByDesc('id')->limit(200)->get(),
            'proposedRefunds' => Refund::query()->where('lifecycle_state', 'proposed')->orderByDesc('id')->limit(200)->get(),
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

    /**
     * The signed-in session PROPOSES the refund. A different session,
     * signed in as an approver holding finance.refund_approve, records it
     * via approveRefund() — the transport can no longer type a colleague's
     * person id into the form.
     */
    public function refund(Request $request, string $paymentId): RedirectResponse
    {
        $input = $request->validate([
            'period_id' => ['required', 'string'],
            'amount' => ['required', 'numeric', 'gt:0'],
            'reason' => ['required', 'string', 'max:1000'],
        ]);

        app(RefundPayment::class)->propose(
            $this->actor(),
            Payment::query()->findOrFail($paymentId),
            FinancialPeriod::query()->findOrFail($input['period_id']),
            $input['amount'],
            $input['reason'],
            $this->idempotencyKey('finance.refund.propose'),
        );

        return redirect()->route('finance.index')->with('success', 'Refund proposed; it takes effect once a distinct approver records it.');
    }

    public function approveRefund(Request $request, string $refundId): RedirectResponse
    {
        app(RefundPayment::class)->approve(
            $this->actor(),
            Refund::query()->findOrFail($refundId),
            $this->idempotencyKey('finance.refund.approve'),
        );

        return redirect()->route('finance.index')->with('success', 'Refund approved and recorded.');
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

    public function postObligation(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'period_id' => ['required', 'string'],
            'student_id' => ['required', 'string'],
            'source' => ['required', 'string', 'max:120'],
            'reason' => ['required', 'string', 'max:1000'],
            'category' => ['required', 'string', 'max:120'],
            'amount' => ['required', 'numeric', 'gt:0'],
            'source_ref' => ['required', 'string', 'max:120'],
        ]);

        app(PostObligation::class)->post(
            $this->actor(),
            FinancialPeriod::query()->findOrFail($input['period_id']),
            $input['student_id'],
            $input['source'],
            $input['reason'],
            [['category' => $input['category'], 'amount' => $input['amount'], 'source_ref' => $input['source_ref']]],
            $this->idempotencyKey('finance.obligation.post'),
        );

        return redirect()->route('finance.index')->with('success', 'Obligation posted.');
    }
}
