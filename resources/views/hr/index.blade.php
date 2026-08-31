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
        <h2>Compensation scales</h2>
        <form method="POST" action="{{ route('hr.scale.register') }}">
            @csrf
            <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
            <label>Catalog key</label>
            <input type="text" name="key" required maxlength="64">
            <label>Name</label>
            <input type="text" name="name" required maxlength="255">
            <label>Rank order</label>
            <input type="number" name="rank_order" min="1" required>
            <div class="actions"><button type="submit" class="btn small">Register scale</button></div>
        </form>
        @if ($scales->isEmpty())
            <p class="empty">No scales recorded.</p>
        @else
            <table class="grid" style="margin-top:12px">
                <tr><th>Scale</th><th>Key</th><th>Rank</th><th>State</th><th></th></tr>
                @foreach ($scales as $scale)
                    <tr>
                        <td>{{ $scale->name }}</td>
                        <td>{{ $scale->key }}</td>
                        <td>{{ $scale->rank_order }}</td>
                        <td><span class="pill {{ $scale->lifecycle_state === 'active' ? 'ok' : '' }}">{{ $scale->lifecycle_state }}</span></td>
                        <td>
                            @if ($scale->lifecycle_state === 'active')
                                <form method="POST" action="{{ route('hr.scale.retire', $scale->id) }}" style="display:inline">
                                    @csrf
                                    <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                    <button type="submit" class="btn small secondary">Retire</button>
                                </form>
                            @endif
                        </td>
                    </tr>
                @endforeach
            </table>
        @endif
    </div>
</div>

<div class="card">
    <h2>Leave</h2>
    <p class="sub">Leave attaches to an open employment; a decider distinct from the requester approves or rejects; approved periods never overlap. Decisions feed payroll proration evidence.</p>
    @foreach ($employments as $employment)
        @if (in_array($employment->lifecycle_state, ['active', 'on_leave'], true))
            <form method="POST" action="{{ route('hr.leave.request', $employment->id) }}" style="margin-bottom:8px">
                @csrf
                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                <div class="row">
                    <div>
                        <label>Employment</label>
                        <input type="text" value="{{ \Illuminate\Support\Str::limit($employment->id, 18) }}" readonly>
                    </div>
                    <div>
                        <label>Category</label>
                        <input name="category" type="text" placeholder="e.g. sick, annual" required>
                    </div>
                    <div>
                        <label>From</label>
                        <input type="date" name="date_from" required>
                    </div>
                    <div>
                        <label>To</label>
                        <input type="date" name="date_to" required>
                    </div>
                    <div>
                        <label>Reason</label>
                        <input name="reason" type="text" required>
                    </div>
                </div>
                <div class="actions"><button type="submit" class="btn small">Request leave</button></div>
            </form>
        @endif
    @endforeach
    @if ($leaves->isEmpty())
        <p class="empty">No leave recorded.</p>
    @else
        <table class="grid">
            <tr><th>Employment</th><th>Category</th><th>From</th><th>To</th><th>State</th><th>Actions</th></tr>
            @foreach ($leaves as $leave)
                <tr>
                    <td>{{ \Illuminate\Support\Str::limit($leave->employment_id, 16) }}</td>
                    <td>{{ $leave->category }}</td>
                    <td>{{ $leave->date_from }}</td>
                    <td>{{ $leave->date_to }}</td>
                    <td><span class="pill {{ $leave->lifecycle_state === 'approved' ? 'ok' : '' }}">{{ $leave->lifecycle_state }}</span></td>
                    <td>
                        @if ($leave->lifecycle_state === 'requested')
                            <form method="POST" action="{{ route('hr.leave.decide', $leave->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <select name="decision" style="display:inline">
                                    <option value="approve">Approve</option>
                                    <option value="reject">Reject</option>
                                </select>
                                <button type="submit" class="btn small">Decide</button>
                            </form>
                            <form method="POST" action="{{ route('hr.leave.cancel', $leave->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <button type="submit" class="btn small secondary">Cancel</button>
                            </form>
                        @endif
                    </td>
                </tr>
            @endforeach
        </table>
    @endif
</div>
@endsection
