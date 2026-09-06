@extends('layouts.app')

@section('title', $student->student_code)

@section('content')
<div class="card">
    <h1>Student {{ $student->student_code }}</h1>
    <p class="sub">{{ $student->person?->legal_name ?? $student->person_id }}</p>
    <div class="actions">
        <a class="btn secondary" href="{{ route('print.idcard', $student->id) }}">Print ID card</a>
        <a class="btn secondary" href="{{ route('students.index') }}">Back to students</a>
    </div>
</div>

<div class="row">
    <div class="card" style="flex:1 1 320px">
        <h2>Status history (append-only)</h2>
        @if ($statuses->isEmpty())
            <p class="empty">No status recorded.</p>
        @else
            <table class="grid">
                <tr><th>Status</th><th>Effective from</th><th>Reason</th></tr>
                @foreach ($statuses as $status)
                    <tr>
                        <td><span class="pill {{ $status->status === 'active' ? 'ok' : '' }}">{{ $status->status }}</span></td>
                        <td>{{ $status->effective_from }}</td>
                        <td class="muted">{{ $status->reason }}</td>
                    </tr>
                @endforeach
            </table>
        @endif
    </div>

    <div class="card" style="flex:1 1 320px">
        <h2>Enrollments</h2>
        @if ($enrollments->isEmpty())
            <p class="empty">No enrollments yet. Enroll the student into a class from the Academic area.</p>
        @else
            <table class="grid">
                <tr><th>Class</th><th>State</th></tr>
                @foreach ($enrollments as $enrollment)
                    <tr>
                        <td>{{ \Illuminate\Support\Str::limit($enrollment->class_id, 18) }}</td>
                        <td><span class="pill {{ $enrollment->lifecycle_state === 'active' ? 'ok' : '' }}">{{ $enrollment->lifecycle_state }}</span></td>
                    </tr>
                @endforeach
            </table>
        @endif
    </div>
</div>
<div class="card">
    <h2>Status transitions</h2>
    <p class="sub">Allowed transitions are owned by the students module; invalid ones are rejected with the domain error code. Reactivation requires its own capability.</p>
    <div class="actions">
        @foreach (['suspend', 'withdraw', 'reactivate', 'complete', 'graduate'] as $action)
            <form method="POST" action="{{ route('students.status', [$student->id, $action]) }}" style="display:inline">
                @csrf
                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                <input name="reason" type="text" placeholder="{{ \Illuminate\Support\Str::headline($action) }} reason" required>
                <button type="submit" class="btn small">{{ \Illuminate\Support\Str::headline($action) }}</button>
            </form>
        @endforeach
    </div>
</div>

<div class="card">
    <h2>Lifecycle: branch, hold and communication</h2>
    <p class="sub">Branch provenance is immutable; the current home branch advances through append-only transfer facts. Holds require the active status and are append-only freeze/resume evidence. Communication preferences are per-channel and are consumed by the Communication module.</p>

    <div class="row">
        <div class="card" style="flex:1 1 320px">
            <h3>Home branch</h3>
            <p class="sub">Origin: <span class="muted">{{ $lifecycle['originating_branch_id'] ?: 'not yet assigned' }}</span></p>
            <p class="sub">Current: <span class="muted">{{ $lifecycle['current_home_branch_id'] ?: 'not assigned' }}</span></p>
            <form method="POST" action="{{ route('students.transfer', $student->id) }}">
                @csrf
                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                <div class="row">
                    <div>
                        <label>Target branch</label>
                        <select name="branch_id" required>
                            <option value="">Select an active branch…</option>
                            @foreach ($branches as $branch)
                                <option value="{{ $branch->id }}" @if ($branch->id === $lifecycle['current_home_branch_id']) selected @endif>{{ $branch->name }}</option>
                            @endforeach
                        </select>
                    </div>
                    <div>
                        <label>Reason</label>
                        <input name="reason" type="text" placeholder="Transfer reason" required>
                    </div>
                </div>
                <div class="actions"><button type="submit" class="btn small">Transfer home branch</button></div>
            </form>
            @if ($lifecycle['branch_transfers'] !== [])
                <table class="grid" style="margin-top:8px">
                    <tr><th>From</th><th>To</th><th>Effective</th><th>Reason</th></tr>
                    @foreach ($lifecycle['branch_transfers'] as $transfer)
                        <tr>
                            <td class="muted">{{ \Illuminate\Support\Str::limit($transfer['from_branch_id'] ?: '—', 12) }}</td>
                            <td>{{ \Illuminate\Support\Str::limit($transfer['to_branch_id'], 12) }}</td>
                            <td>{{ $transfer['effective_from'] }}</td>
                            <td class="muted">{{ $transfer['reason'] }}</td>
                        </tr>
                    @endforeach
                </table>
            @endif
        </div>

        <div class="card" style="flex:1 1 320px">
            <h3>Student hold</h3>
            <p class="sub">Current hold: <span class="pill {{ $lifecycle['holds']['open'] ? '' : 'ok' }}">{{ $lifecycle['holds']['open'] ? 'frozen' : 'not frozen' }}</span></p>
            <div class="actions">
                @if (! $lifecycle['holds']['open'])
                    <form method="POST" action="{{ route('students.hold.freeze', $student->id) }}" style="display:inline">
                        @csrf
                        <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                        <input name="reason" type="text" placeholder="Freeze reason" required>
                        <button type="submit" class="btn small">Freeze</button>
                    </form>
                @else
                    <form method="POST" action="{{ route('students.hold.resume', $student->id) }}" style="display:inline">
                        @csrf
                        <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                        <input name="reason" type="text" placeholder="Resume reason" required>
                        <button type="submit" class="btn small secondary">Resume</button>
                    </form>
                @endif
            </div>
        </div>

        <div class="card" style="flex:1 1 320px">
            <h3>Communication</h3>
            @foreach (['email', 'sms', 'whatsapp', 'push'] as $channel)
                @php $pref = collect($lifecycle['communication_preferences'])->firstWhere('channel', $channel); @endphp
                <form method="POST" action="{{ route('students.communication', $student->id) }}" style="display:flex; align-items:center; gap:8px; margin:6px 0">
                    @csrf
                    <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                    <input type="hidden" name="channel" value="{{ $channel }}">
                    <label style="display:flex; align-items:center; gap:4px">
                        <input type="checkbox" name="enabled" value="1" @if ($pref && $pref['enabled']) checked @endif>
                        {{ ucfirst($channel) }}
                    </label>
                    <button type="submit" class="btn small secondary">Save</button>
                </form>
            @endforeach
        </div>
    </div>
</div>

<div class="card">
    <h2>Guardian relationships</h2>
    <p class="sub">Relationship-specific permissions only; verification is a separate, audited step; revocation is evidence, not erasure.</p>
    <form method="POST" action="{{ route('students.guardian.record', $student->id) }}">
        @csrf
        <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
        <div class="row">
            <div>
                <label>Guardian (verified person)</label>
                <select name="guardian_person_id" required>
                    <option value="">Select a person…</option>
                    @foreach ($people as $person)
                        @if ($person->id !== $student->person_id)
                            <option value="{{ $person->id }}">{{ $person->legal_name }}</option>
                        @endif
                    @endforeach
                </select>
            </div>
            <div>
                <label>Relationship</label>
                <input name="relationship" type="text" placeholder="e.g. parent, legal guardian" required>
            </div>
            <div>
                <label>Permissions (comma-separated)</label>
                <input name="permissions" type="text" placeholder="e.g. view_records, receive_reports" required>
            </div>
        </div>
        <div class="actions"><button type="submit" class="btn">Record relationship</button></div>
    </form>
    @if ($guardians->isEmpty())
        <p class="empty">No guardian relationships recorded.</p>
    @else
        <table class="grid" style="margin-top:8px">
            <tr><th>Guardian</th><th>Relationship</th><th>Permissions</th><th>Verification</th><th>State</th><th>Actions</th></tr>
            @foreach ($guardians as $guardian)
                <tr>
                    <td>{{ \Illuminate\Support\Str::limit($guardian->guardian_person_id, 16) }}</td>
                    <td>{{ $guardian->relationship }}</td>
                    <td class="muted">{{ \Illuminate\Support\Str::limit(implode(', ', (array) $guardian->permissions), 40) }}</td>
                    <td><span class="pill {{ $guardian->verification_state === 'verified' ? 'ok' : '' }}">{{ $guardian->verification_state }}</span></td>
                    <td><span class="pill">{{ $guardian->lifecycle_state }}</span></td>
                    <td>
                        @if ($guardian->lifecycle_state === 'active' && $guardian->verification_state !== 'verified')
                            <form method="POST" action="{{ route('students.guardian.verify', $guardian->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <button type="submit" class="btn small">Verify</button>
                            </form>
                        @endif
                        @if ($guardian->lifecycle_state === 'active')
                            <form method="POST" action="{{ route('students.guardian.revoke', $guardian->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <button type="submit" class="btn small secondary">Revoke</button>
                            </form>
                        @endif
                    </td>
                </tr>
            @endforeach
        </table>
    @endif
</div>
@endsection