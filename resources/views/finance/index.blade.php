@extends('layouts.app')

@section('title', 'Finance')

@section('content')
<div class="card">
    <h1>Finance</h1>
    <p class="sub">The money surface: obligations, payments, refunds, discounts, and funding. Every movement is balanced, source-linked, idempotent, and reconciliation-ready. Amounts are produced by commands — never edited by hand.</p>
</div>

<div class="card">
    <h2>Record a payment</h2>
    <form method="POST" action="{{ route('finance.payment') }}">
        @csrf
        <div class="row">
            <div>
                <label>Financial period</label>
                <select name="period_id" required>
                    <option value="">Select a period…</option>
                    @foreach ($periods as $period)
                        <option value="{{ $period->id }}">{{ $period->period_key }} ({{ $period->date_from }} → {{ $period->date_to }})</option>
                    @endforeach
                </select>
            </div>
            <div>
                <label>Student</label>
                <select name="student_id" required>
                    <option value="">Select a student…</option>
                    @foreach ($students as $student)
                        <option value="{{ $student->id }}">{{ $student->student_code }}</option>
                    @endforeach
                </select>
            </div>
            <div>
                <label>Amount</label>
                <input name="amount" type="text" inputmode="decimal" required>
            </div>
            <div>
                <label>Method</label>
                <input name="method" type="text" placeholder="e.g. cash, bank" required>
            </div>
            <div>
                <label>Payer reference</label>
                <input name="payer_ref" type="text" required>
            </div>
            <div>
                <label>Received on</label>
                <input type="date" name="received_on" required>
            </div>
        </div>
        <div class="actions"><button type="submit" class="btn">Record payment</button></div>
    </form>
</div>

<div class="row">
    <div class="card" style="flex:1 1 320px">
        <h2>Obligations (newest first)</h2>
        @if ($obligations->isEmpty())
            <p class="empty">No obligations posted.</p>
        @else
            <table class="grid">
                <tr><th>Student</th><th>Source</th><th></th></tr>
                @foreach ($obligations as $obligation)
                    <tr>
                        <td>{{ \Illuminate\Support\Str::limit($obligation->student_id, 16) }}</td>
                        <td>{{ \Illuminate\Support\Str::limit($obligation->source, 16) }}</td>
                        <td>
                            <details>
                                <summary class="btn small secondary" style="display:inline-block; cursor:pointer">Allocate</summary>
                                <form method="POST" action="{{ route('finance.allocate', $obligation->id) }}" style="margin-top:8px">
                                    @csrf
                                    <label>Payment</label>
                                    <select name="payment_id" required>
                                        @foreach ($payments as $payment)
                                            <option value="{{ $payment->id }}">{{ \Illuminate\Support\Str::limit($payment->id, 14) }} ({{ $payment->amount }})</option>
                                        @endforeach
                                    </select>
                                    <label>Amount</label>
                                    <input name="amount" type="text" inputmode="decimal" required>
                                    <div class="actions"><button type="submit" class="btn small">Allocate</button></div>
                                </form>
                            </details>
                        </td>
                    </tr>
                @endforeach
            </table>
        @endif
    </div>

    <div class="card" style="flex:1 1 320px">
        <h2>Payments (newest first)</h2>
        @if ($payments->isEmpty())
            <p class="empty">No payments recorded.</p>
        @else
            <table class="grid">
                <tr><th>Student</th><th>Reference</th><th>Amount</th><th>Method</th><th>Received</th><th></th></tr>
                @foreach ($payments as $payment)
                    <tr>
                        <td>{{ \Illuminate\Support\Str::limit($payment->student_id, 16) }}</td>
                        <td><code>{{ $payment->payer_ref }}</code></td>
                        <td>{{ $payment->amount }}</td>
                        <td>{{ $payment->method }}</td>
                        <td>{{ $payment->received_on }}</td>
                        <td>
                            <details>
                                <summary class="btn small secondary" style="display:inline-block; cursor:pointer">Refund</summary>
                                <form method="POST" action="{{ route('finance.refund', $payment->id) }}" style="margin-top:8px">
                                    @csrf
                                    <label>Period</label>
                                    <select name="period_id" required>
                                        @foreach ($periods as $period)
                                            <option value="{{ $period->id }}">{{ $period->period_key }}</option>
                                        @endforeach
                                    </select>
                                    <label>Amount</label>
                                    <input name="amount" type="text" inputmode="decimal" required>
                                    <label>Reason</label>
                                    <input name="reason" type="text" required>
                                    <label>Approver (person id)</label>
                                    <input name="approver_id" type="text" required>
                                    <div class="actions"><button type="submit" class="btn small">Refund</button></div>
                                </form>
                            </details>
                        </td>
                    </tr>
                @endforeach
            </table>
        @endif
    </div>
</div>

<div class="row">
    <div class="card" style="flex:1 1 320px">
        <h2>Refunds</h2>
        @if ($refunds->isEmpty())
            <p class="empty">No refunds recorded.</p>
        @else
            <table class="grid">
                <tr><th>Payment</th><th>Amount</th><th>Reason</th></tr>
                @foreach ($refunds as $refund)
                    <tr>
                        <td>{{ \Illuminate\Support\Str::limit($refund->payment_id, 16) }}</td>
                        <td>{{ $refund->amount }}</td>
                        <td class="muted">{{ \Illuminate\Support\Str::limit($refund->reason, 24) }}</td>
                    </tr>
                @endforeach
            </table>
        @endif
    </div>

    <div class="card" style="flex:1 1 320px">
        <h2>Funding sources</h2>
        @if ($fundingSources->isEmpty())
            <p class="empty">No funding sources recorded.</p>
        @else
            <table class="grid">
                <tr><th>Name</th><th>Committed</th><th>Restriction</th></tr>
                @foreach ($fundingSources as $fundingSource)
                    <tr>
                        <td>{{ $fundingSource->name }}</td>
                        <td>{{ $fundingSource->committed_amount }}</td>
                        <td class="muted">{{ $fundingSource->restricted_category ?? '—' }}</td>
                    </tr>
                @endforeach
            </table>
        @endif
    </div>
</div>
@endsection
