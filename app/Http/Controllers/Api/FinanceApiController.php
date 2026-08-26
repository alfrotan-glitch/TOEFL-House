<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Modules\Finance\Commands\RecordPayment;
use App\Modules\Finance\Commands\RefundPayment;
use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Finance\Models\Obligation;
use App\Modules\Finance\Models\Payment;
use App\Support\Authorization\Actor;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** JSON interface for the money surface (delegates to the same commands). */
final class FinanceApiController extends Controller
{
    public function obligations(): JsonResponse
    {
        $obligations = Obligation::query()->orderByDesc('id')->limit(200)->get();

        return response()->json(['obligations' => $obligations]);
    }

    public function payments(): JsonResponse
    {
        $payments = Payment::query()->orderByDesc('received_on')->limit(200)->get();

        return response()->json(['payments' => $payments]);
    }

    public function record(Request $request): JsonResponse
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

        return response()->json(['status' => 'recorded'], 201);
    }

    public function refund(Request $request, string $paymentId): JsonResponse
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

        return response()->json(['status' => 'refunded']);
    }
}
