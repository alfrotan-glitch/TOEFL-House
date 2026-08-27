@extends('layouts.app')

@section('title', 'Applicants & Admissions')

@section('content')
<div class="card">
    <h1>Applicants &amp; Admissions</h1>
    <p class="sub">Register a verified person as an applicant, run the three-signature admission decision (initiator, reviewer, approver — distinct people, enforced server-side), then enroll the admitted applicant.</p>
</div>

@php $applicantById = $applicants->keyBy('id'); @endphp
<div class="card">
    <h2>Admission decisions in progress</h2>
    @if ($pendingDecisions->isEmpty())
        <p class="empty">No decisions awaiting review or approval.</p>
    @else
        <table class="grid">
            <tr><th>Applicant</th><th>Decision</th><th>Reason</th><th>Initiator</th><th>State</th><th></th></tr>
            @foreach ($pendingDecisions as $decision)
                <tr>
                    <td>{{ $applicantById[$decision->applicant_id]?->person?->legal_name ?? \Illuminate\Support\Str::limit($decision->applicant_id, 16) }}</td>
                    <td>{{ $decision->outcome }}</td>
                    <td class="muted">{{ \Illuminate\Support\Str::limit($decision->reason, 24) }}</td>
                    <td class="muted">{{ \Illuminate\Support\Str::limit($decision->initiator_id, 16) }}</td>
                    <td><span class="pill">{{ $decision->lifecycle_state }}</span></td>
                    <td>
                        @if ($decision->lifecycle_state === 'proposed')
                            <form method="POST" action="{{ route('students.decision.review', $decision->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <button type="submit" class="btn small" title="Records your review (you must differ from the initiator)">Review</button>
                            </form>
                        @else
                            <form method="POST" action="{{ route('students.decision.approve', $decision->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <button type="submit" class="btn small" title="Finalizes the decision (you must differ from the initiator and the reviewer)">Approve</button>
                            </form>
                        @endif
                    </td>
                </tr>
            @endforeach
        </table>
    @endif
</div>

<div class="card">
    <h2>Register an applicant</h2>
    <form method="POST" action="{{ route('students.register') }}">
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
            <div>
                <label>Program interest</label>
                <input name="program_interest" type="text" required>
            </div>
        </div>
        <div class="actions"><button type="submit" class="btn">Register applicant</button></div>
    </form>
</div>

<div class="card">
    <h2>Applicants</h2>
    @if ($applicants->isEmpty())
        <p class="empty">No applicants yet.</p>
    @else
        <table class="grid">
            <tr><th>Person</th><th>Interest</th><th>State</th><th></th></tr>
            @foreach ($applicants as $applicant)
                <tr>
                    <td>{{ $applicant->person?->legal_name ?? $applicant->person_id }}</td>
                    <td>{{ $applicant->program_interest }}</td>
                    <td><span class="pill {{ in_array($applicant->lifecycle_state, ['admitted'], true) ? 'ok' : (in_array($applicant->lifecycle_state, ['rejected'], true) ? 'held' : '') }}">{{ $applicant->lifecycle_state }}</span></td>
                    <td>
                        @if (in_array($applicant->lifecycle_state, ['prospect', 'applicant'], true))
                            <details>
                                <summary class="btn small secondary" style="display:inline-block; cursor:pointer">Initiate decision</summary>
                                <form method="POST" action="{{ route('students.initiate', $applicant->id) }}" style="margin-top:8px">
                                    @csrf
                                    <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                    <label>Decision</label>
                                    <select name="decision" required>
                                        <option value="admit">Admit</option>
                                        <option value="reject">Reject</option>
                                    </select>
                                    <label>Reason</label>
                                    <input name="reason" type="text" required>
                                    <label>Evidence reference</label>
                                    <input name="evidence_ref" type="text" required>
                                    <p class="muted" style="font-size:12px">You are initiating this decision. A different employee (reviewer) and a third (approver) act on it from their own sessions before it takes effect.</p>
                                    <div class="actions"><button type="submit" class="btn small">Initiate decision</button></div>
                                </form>
                            </details>
                        @endif
                        @if ($applicant->lifecycle_state === 'admitted')
                            <form method="POST" action="{{ route('students.enroll', $applicant->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <button type="submit" class="btn small">Enroll as student</button>
                            </form>
                        @endif
                    </td>
                </tr>
            @endforeach
        </table>
    @endif
</div>
@endsection
