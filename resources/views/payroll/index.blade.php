@extends('layouts.app')

@section('title', 'Payroll')

@section('content')
<div class="card">
    <h1>Payroll</h1>
    <p class="sub">Open a period, calculate per employment (deterministic rule resolution; contract-silent rules are HELD), then approve to produce an immutable, versioned result. No amount is typed or edited.</p>
</div>

<div class="card">
    <h2>Open a payroll period</h2>
    <form method="POST" action="{{ route('payroll.period') }}">
        @csrf
        <div class="row">
            <div>
                <label>Period key</label>
                <input name="period_key" type="text" placeholder="e.g. 2026-09" required>
            </div>
            <div>
                <label>From</label>
                <input type="date" name="date_from" required>
            </div>
            <div>
                <label>To</label>
                <input type="date" name="date_to" required>
            </div>
        </div>
        <div class="actions"><button type="submit" class="btn">Open period</button></div>
    </form>
</div>

<div class="card">
    <h2>Periods</h2>
    @if ($periods->isEmpty())
        <p class="empty">No payroll periods opened.</p>
    @else
        <table class="grid">
            <tr><th>Period</th><th>Range</th><th>State</th><th>Actions</th></tr>
            @foreach ($periods as $period)
                <tr>
                    <td>{{ $period->period_key }}</td>
                    <td>{{ $period->date_from }} → {{ $period->date_to }}</td>
                    <td><span class="pill {{ $period->lifecycle_state === 'open' ? 'ok' : '' }}">{{ $period->lifecycle_state }}</span></td>
                    <td>
                        @if (in_array($period->lifecycle_state, ['open', 'calculating'], true))
                            <details>
                                <summary class="btn small secondary" style="display:inline-block; cursor:pointer">Calculate</summary>
                                <form method="POST" action="{{ route('payroll.calculate', $period->id) }}" style="margin-top:8px">
                                    @csrf
                                    <label>Employment</label>
                                    <select name="employment_id" required>
                                        @foreach ($employments as $employment)
                                            <option value="{{ $employment->id }}">{{ \Illuminate\Support\Str::limit($employment->person_id, 16) }}</option>
                                        @endforeach
                                    </select>
                                    <div class="actions"><button type="submit" class="btn small">Calculate</button></div>
                                </form>
                            </details>
                            <form method="POST" action="{{ route('payroll.period.close', $period->id) }}" style="display:inline">
                                @csrf
                                <button type="submit" class="btn small secondary">Close</button>
                            </form>
                        @endif
                    </td>
                </tr>
            @endforeach
        </table>
    @endif
</div>

<div class="card">
    <h2>Calculations (newest first)</h2>
    @if ($calculations->isEmpty())
        <p class="empty">No payroll calculations yet.</p>
    @else
        <table class="grid">
            <tr><th>Employment</th><th>Base</th><th>State</th><th></th></tr>
            @foreach ($calculations as $calculation)
                <tr>
                    <td>{{ \Illuminate\Support\Str::limit($calculation->employment_id, 16) }}</td>
                    <td>{{ $calculation->base_amount }}</td>
                    <td><span class="pill {{ $calculation->lifecycle_state === 'held' ? 'held' : ($calculation->lifecycle_state === 'prepared' ? 'ok' : '') }}">{{ $calculation->lifecycle_state }}</span></td>
                    <td>
                        @if ($calculation->lifecycle_state === 'prepared')
                            <form method="POST" action="{{ route('payroll.approve', $calculation->id) }}" style="display:inline">
                                @csrf
                                <button type="submit" class="btn small">Approve &amp; produce result</button>
                            </form>
                        @endif
                    </td>
                </tr>
            @endforeach
        </table>
    @endif
</div>

<div class="card">
    <h2>Approved results</h2>
    @if ($results->isEmpty())
        <p class="empty">No approved results yet.</p>
    @else
        <table class="grid">
            <tr><th>Employment</th><th>Amount</th><th>State</th><th></th></tr>
            @foreach ($results as $result)
                <tr>
                    <td>{{ \Illuminate\Support\Str::limit($result->employment_id, 16) }}</td>
                    <td>{{ $result->amount }}</td>
                    <td><span class="pill ok">{{ $result->lifecycle_state }}</span></td>
                    <td><a class="btn small secondary" href="{{ route('print.payroll', $result->id) }}">Pay slip</a></td>
                </tr>
            @endforeach
        </table>
    @endif
</div>
@endsection
