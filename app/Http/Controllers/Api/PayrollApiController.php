<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Modules\Hr\Models\Employment;
use App\Modules\Payroll\Commands\ApprovePayrollResult;
use App\Modules\Payroll\Commands\CalculatePayroll;
use App\Modules\Payroll\Models\PayrollCalculation;
use App\Modules\Payroll\Models\PayrollPeriod;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** JSON interface for payroll (delegates to the same commands). */
final class PayrollApiController extends Controller
{
    public function periods(): JsonResponse
    {
        $periods = PayrollPeriod::query()->orderByDesc('period_key')->limit(100)->get();

        return response()->json(['periods' => $periods]);
    }

    public function calculations(): JsonResponse
    {
        $calculations = PayrollCalculation::query()->orderByDesc('id')->limit(200)->get();

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
            PayrollPeriod::query()->findOrFail($input['period_id']),
            Employment::query()->findOrFail($input['employment_id']),
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
}
