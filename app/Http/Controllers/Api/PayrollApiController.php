<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Modules\Hr\Models\Employment;
use App\Modules\Identity\Models\Person;
use App\Modules\Payroll\Commands\ApprovePayrollResult;
use App\Modules\Payroll\Commands\CalculatePayroll;
use App\Modules\Payroll\Commands\ResolveHeldPayrollCalculation;
use App\Modules\Payroll\Commands\SettleEmployment;
use App\Modules\Payroll\Models\PayrollCalculation;
use App\Modules\Payroll\Models\PayrollPeriod;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** JSON interface for payroll (delegates to the same commands). */
final class PayrollApiController extends Controller
{
    public function periods(): JsonResponse
    {
        $this->requireOrganizationRead('payroll.calculate', 'api.payroll.periods');
        $periods = PayrollPeriod::query()->orderByDesc('period_key')->limit(100)->get();

        return response()->json(['periods' => $periods]);
    }

    public function calculations(): JsonResponse
    {
        $this->requireOrganizationRead('payroll.calculate', 'api.payroll.calculations');
        $payrollBranches = $this->authorizedBranches('payroll.calculate');
        $employmentIds = Employment::query()
            ->whereIn('person_id', Person::query()->whereIn('home_branch_id', $payrollBranches)->select('id'))
            ->select('id');
        $calculations = PayrollCalculation::query()
            ->whereIn('employment_id', $employmentIds)
            ->orderByDesc('id')
            ->limit(200)
            ->get();

        return response()->json(['calculations' => $calculations]);
    }

    public function calculate(Request $request): JsonResponse
    {
        $input = $request->validate([
            'period_id' => ['required', 'string'],
            'employment_id' => ['required', 'string'],
        ]);

        $result = app(CalculatePayroll::class)->prepare(
            $this->actor(),
            PayrollPeriod::query()->findOrFail((string) $input['period_id']),
            Employment::query()->findOrFail((string) $input['employment_id']),
            $this->idempotencyKey('payroll.calculate'),
        );

        return response()->json(['status' => 'prepared', 'calculation_id' => $result['calculation_id'], 'lifecycle_state' => $result['lifecycle_state']], 201);
    }

    public function approve(Request $request, string $calculationId): JsonResponse
    {
        app(ApprovePayrollResult::class)->approve(
            $this->actor(),
            PayrollCalculation::query()->findOrFail($calculationId),
            $this->idempotencyKey('payroll.approve'),
        );

        return response()->json(['status' => 'approved']);
    }

    public function resolveHeld(Request $request, string $calculationId): JsonResponse
    {
        $input = $request->validate([
            'replacement_calculation_id' => ['required', 'string'],
            'resolution_ref' => ['required', 'string', 'max:2000'],
        ]);

        $result = app(ResolveHeldPayrollCalculation::class)->resolve(
            $this->actor(),
            PayrollCalculation::query()->findOrFail($calculationId),
            PayrollCalculation::query()->findOrFail((string) $input['replacement_calculation_id']),
            $input['resolution_ref'],
            $this->idempotencyKey('payroll.resolve-held'),
        );

        return response()->json(['status' => 'resolved', ...$result]);
    }

    public function clear(Request $request, string $employmentId): JsonResponse
    {
        $input = $request->validate([
            'domain' => ['required', 'in:hr,finance'],
            'note' => ['required', 'string', 'max:1000'],
        ]);
        $result = app(SettleEmployment::class)->clear(
            $this->actor(), Employment::query()->findOrFail($employmentId), $input['domain'], $input['note'],
            $this->idempotencyKey('payroll.clearance'),
        );

        return response()->json(['status' => 'cleared', ...$result], 201);
    }

    public function proposeSettlement(Request $request, string $employmentId): JsonResponse
    {
        $input = $request->validate([
            'amount' => ['required', 'numeric', 'money', 'min:0', 'max:99999999999999'],
            'basis' => ['required', 'string', 'max:1000'],
        ]);
        $result = app(SettleEmployment::class)->propose(
            $this->actor(), Employment::query()->findOrFail($employmentId), $input['amount'], $input['basis'],
            $this->idempotencyKey('payroll.settlement.propose'),
        );

        return response()->json(['status' => 'proposed', ...$result], 201);
    }


}
