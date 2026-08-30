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