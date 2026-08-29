<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Modules\Hr\Models\Employment;
use App\Modules\Payroll\Commands\ApprovePayrollResult;
use App\Modules\Payroll\Commands\CalculatePayroll;
use App\Modules\Payroll\Commands\MaintainPayrollPeriod;
use App\Modules\Payroll\Commands\SettleEmployment;
use App\Modules\Payroll\Models\PayrollCalculation;
use App\Modules\Payroll\Models\PayrollClearance;
use App\Modules\Payroll\Models\PayrollPeriod;
use App\Modules\Payroll\Models\PayrollResult;
use App\Modules\Payroll\Models\SettlementProposal;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\View\View;

/**
 * Payroll console: the period lifecycle (open → calculate per employment →
 * approve) and the immutable, versioned results. Calculation delegates to the
 * payroll engine (deterministic rule resolution, contract-silent HELD);
 * approval enforces the separation of duties. No amount is typed or edited
 * here — results are produced, not entered.
 */
final class PayrollController extends Controller
{
    public function index(): View
    {
        return view('payroll.index', [
            'periods' => PayrollPeriod::query()->orderByDesc('period_key')->limit(100)->get(),
            'calculations' => PayrollCalculation::query()->orderByDesc('id')->limit(200)->get(),
            'results' => PayrollResult::query()->orderByDesc('id')->limit(200)->get(),
            'employments' => Employment::query()->where('lifecycle_state', 'active')->orderBy('id')->get(),
            'terminatedEmployments' => Employment::query()->where('lifecycle_state', 'terminated')->orderBy('id')->limit(200)->get(),
            'clearances' => PayrollClearance::query()->orderBy('id')->limit(500)->get(),
            'settlementProposals' => SettlementProposal::query()->where('lifecycle_state', SettlementProposal::STATE_PROPOSED)->orderBy('id')->limit(200)->get(),
        ]);
    }

    public function openPeriod(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'period_key' => ['required', 'string', 'max:40'],
            'date_from' => ['required', 'date'],
            'date_to' => ['required', 'date', 'after_or_equal:date_from'],
        ]);

        app(MaintainPayrollPeriod::class)->open(
            $this->actor(),
            $input['period_key'],
            $input['date_from'],
            $input['date_to'],
            $this->idempotencyKey('payroll.open'),
        );

        return redirect()->route('payroll.index')->with('success', 'Payroll period opened.');
    }

    public function closePeriod(Request $request, string $periodId): RedirectResponse
    {
        app(MaintainPayrollPeriod::class)->close(
            $this->actor(),
            PayrollPeriod::query()->findOrFail($periodId),
            $this->idempotencyKey('payroll.close'),
        );

        return redirect()->route('payroll.index')->with('success', 'Payroll period closed and locked.');
    }

    public function calculate(Request $request, string $periodId): RedirectResponse
    {
        $input = $request->validate([
            'employment_id' => ['required', 'string'],
        ]);

        app(CalculatePayroll::class)->prepare(
            $this->actor(),
            PayrollPeriod::query()->findOrFail($periodId),
            Employment::query()->findOrFail($input['employment_id']),
            $this->idempotencyKey('payroll.calculate'),
        );

        return redirect()->route('payroll.index')->with('success', 'Payroll calculation prepared for the employment.');
    }

    public function approve(Request $request, string $calculationId): RedirectResponse
    {
        app(ApprovePayrollResult::class)->approve(
            $this->actor(),
            PayrollCalculation::query()->findOrFail($calculationId),
            $this->idempotencyKey('payroll.approve'),
        );

        return redirect()->route('payroll.index')->with('success', 'Payroll result approved and versioned.');
    }

    public function clear(Request $request, string $employmentId): RedirectResponse
    {
        $input = $request->validate([
            'domain' => ['required', 'in:hr,finance'],
            'note' => ['required', 'string', 'max:1000'],
        ]);

        app(SettleEmployment::class)->clear(
            $this->actor(),
            Employment::query()->findOrFail($employmentId),
            $input['domain'],
            $input['note'],
            $this->idempotencyKey('payroll.clearance'),
        );

        return redirect()->route('payroll.index')->with('success', 'Clearance recorded.');
    }

    public function proposeSettlement(Request $request, string $employmentId): RedirectResponse
    {
        $input = $request->validate([
            'amount' => ['required', 'numeric', 'min:0', 'max:99999999999999'],
            'basis' => ['required', 'string', 'max:1000'],
        ]);

        app(SettleEmployment::class)->propose(
            $this->actor(),
            Employment::query()->findOrFail($employmentId),
            $input['amount'],
            $input['basis'],
            $this->idempotencyKey('payroll.settlement.propose'),
        );

        return redirect()->route('payroll.index')->with('success', 'Settlement proposed; it is recorded only when a distinct approver approves it.');
    }

    public function approveSettlement(Request $request, string $proposalId): RedirectResponse
    {
        app(SettleEmployment::class)->approve(
            $this->actor(),
            SettlementProposal::query()->findOrFail($proposalId),
            $this->idempotencyKey('payroll.settlement.approve'),
        );

        return redirect()->route('payroll.index')->with('success', 'Settlement approved and recorded.');
    }
}
