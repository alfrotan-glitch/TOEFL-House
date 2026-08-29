@extends('layouts.app')

@section('title', 'Teachers & HR')

@section('content')
<div class="card">
    <h1>Teachers &amp; HR</h1>
    <p class="sub">The teacher lifecycle: employment, contract versions with approval, scales, and leave. Compensation is defined per contract version and resolved deterministically by payroll.</p>
    <div class="actions">
        <a class="btn" href="{{ route('hr.contracts') }}">Contract versions</a>
    </div>
</div>

<div class="card">
    <h2>Create an employment</h2>
    <form method="POST" action="{{ route('hr.employ') }}">
        @csrf
        <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
        <div class="row">
            <div>
                <label>Verified person</label>
                <select name="person_id" required>
                    <option value="">Select a person…</option>
                    @foreach ($people as $person)
                        <option value="{{ $person->id }}">{{ $person->legal_name }}</option>
                    @endforeach
                </select>
            </div>
        </div>
        <div class="actions"><button type="submit" class="btn">Create employment (candidate)</button></div>
    </form>
</div>

<div class="row">
    <div class="card" style="flex:1 1 320px">
        <h2>Employments</h2>
        @if ($employments->isEmpty())
            <p class="empty">No employments recorded.</p>
        @else
            <table class="grid">
                <tr><th>Person</th><th>State</th><th>Actions</th></tr>
                @foreach ($employments as $employment)
                    <tr>
                        <td>{{ \Illuminate\Support\Str::limit($employment->person_id, 18) }}</td>
                        <td><span class="pill {{ $employment->lifecycle_state === 'active' ? 'ok' : '' }}">{{ $employment->lifecycle_state }}</span></td>
                        <td>
                            @if ($employment->lifecycle_state === 'candidate')
                                <form method="POST" action="{{ route('hr.employment.hire') }}" style="display:inline">
                                    @csrf
                                    <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                    <input type="hidden" name="employment_id" value="{{ $employment->id }}">
                                    <input type="date" name="effective_from" required>
                                    <button type="submit" class="btn small">Hire</button>
                                </form>
                            @endif
                            @if ($employment->lifecycle_state === 'active')
                                <form method="POST" action="{{ route('hr.employment.leave') }}" style="display:inline">
                                    @csrf
                                    <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                    <input type="hidden" name="employment_id" value="{{ $employment->id }}">
                                    <input type="date" name="effective_from" required>
                                    <button type="submit" class="btn small">Leave</button>
                                </form>
                                <form method="POST" action="{{ route('hr.employment.suspend') }}" style="display:inline">
                                    @csrf
                                    <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                    <input type="hidden" name="employment_id" value="{{ $employment->id }}">
                                    <input type="date" name="effective_from" required>
                                    <button type="submit" class="btn small secondary">Suspend</button>
                                </form>
                            @endif
                            @if (in_array($employment->lifecycle_state, ['on_leave', 'suspended'], true))
                                <form method="POST" action="{{ route('hr.employment.reinstate') }}" style="display:inline">
                                    @csrf
                                    <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                    <input type="hidden" name="employment_id" value="{{ $employment->id }}">
                                    <input type="date" name="effective_from" required>
                                    <button type="submit" class="btn small">Reinstate</button>
                                </form>
                            @endif
                            @if (in_array($employment->lifecycle_state, ['candidate', 'active', 'on_leave', 'suspended'], true))
                                <form method="POST" action="{{ route('hr.employment.terminate') }}" style="display:inline">
                                    @csrf
                                    <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                    <input type="hidden" name="employment_id" value="{{ $employment->id }}">
                                    <input type="date" name="effective_from" required>
                                    <input name="reason" type="text" placeholder="Reason" required>
                                    <button type="submit" class="btn small secondary">Terminate</button>
                                </form>
                            @endif
                        </td>
                    </tr>
                @endforeach
            </table>
        @endif
    </div>

    <div class="card" style="flex:1 1 320px">
        <h2>Scales</h2>
        @if ($scales->isEmpty())
            <p class="empty">No scales recorded.</p>
        @else
            <table class="grid">
                <tr><th>Scale</th><th>Key</th></tr>
                @foreach ($scales as $scale)
                    <tr><td>{{ $scale->name }}</td><td>{{ $scale->key }}</td></tr>
                @endforeach
            </table>
        @endif
    </div>
</div>

<div class="card">
    <h2>Leave</h2>
    @if ($leaves->isEmpty())
        <p class="empty">No leave recorded.</p>
    @else
        <table class="grid">
            <tr><th>Employment</th><th>Category</th><th>From</th><th>To</th><th>State</th></tr>
            @foreach ($leaves as $leave)
                <tr>
                    <td>{{ \Illuminate\Support\Str::limit($leave->employment_id, 16) }}</td>
                    <td>{{ $leave->category }}</td>
                    <td>{{ $leave->date_from }}</td>
                    <td>{{ $leave->date_to }}</td>
                    <td><span class="pill">{{ $leave->lifecycle_state }}</span></td>
                </tr>
            @endforeach
        </table>
    @endif
</div>
@endsection
