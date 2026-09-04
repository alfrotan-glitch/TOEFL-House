@extends('layouts.app')

@section('title', 'Placement Profile')

@section('content')
<div class="card">
    <h1>Placement Profile</h1>
    <p class="sub">Person {{ $profile->person_id }} · state <strong>{{ $profile->lifecycle_state }}</strong> · overall CEFR <strong>{{ $profile->overall_cefr_ref ?? '—' }}</strong></p>
    <div class="toolbar">
        @if ($profile->recommended_level_id)
            <div><strong>{{ $profile->recommendedLevel?->level_key ?? '—' }}</strong> recommended level</div>
        @endif
        @if ($profile->recommended_class_id)
            <div><strong>{{ $profile->recommendedClass?->id ?? '—' }}</strong> recommended class</div>
        @endif
    </div>
    @if (\in_array($profile->lifecycle_state, ['draft','scored'], true))
        <form method="POST" action="{{ route('placement.attempt.start') }}">
            @csrf
            <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
            <input type="hidden" name="profile_id" value="{{ $profile->id }}">
            <div class="row">
                <select name="test_version_id" required>
                    @foreach ($versions as $version)
                        <option value="{{ $version->id }}">v{{ $version->version_no }} ({{ $version->lifecycle_state }})</option>
                    @endforeach
                </select>
                <select name="delivery_mode" required><option value="digital">Digital</option><option value="physical">Physical</option></select>
                <input name="proctor_person_id" placeholder="Proctor person id (optional)">
                <button type="submit" class="btn small">Start attempt</button>
            </div>
        </form>
    @endif
</div>

@if ($inProgressAttempt !== null)
    <div class="card">
        <h2>Attempt {{ $inProgressAttempt->attempt_no }} ({{ $inProgressAttempt->delivery_mode }}) — answer intake</h2>
        @if ($inProgressAttempt->delivery_mode === 'digital')
            <form method="POST" action="{{ route('placement.attempt.submit', $inProgressAttempt->id) }}">
                @csrf
                @foreach ($questions as $question)
                    <div style="margin-bottom:8px">
                        <strong>{{ $question->code }} ({{ $question->question_type }})</strong>: {{ $question->stem }}
                        @if ($question->media_ref)
                            <em>media {{ $question->media_ref }}</em>
                        @endif
                        <input name="answers[{{ $question->id }}]" type="text" required>
                    </div>
                @endforeach
                <button type="submit" class="btn">Submit &amp; auto-score</button>
            </form>
        @else
            <form method="POST" action="{{ route('placement.attempt.submit-physical', $inProgressAttempt->id) }}">
                @csrf
                <input name="evidence_ref" placeholder="Evidence ref (answer sheet / recording)" required>
                <button type="submit" class="btn small">Record physical evidence</button>
            </form>
        @endif
    </div>
@endif

<div class="card">
    <h2>Section results</h2>
    @if ($section_results->isEmpty())
        <p class="sub">No section results.</p>
    @else
        <table>
            <thead><tr><th>Component</th><th>Raw</th><th>Weighted %</th><th>CEFR</th><th>State</th><th>Actions</th></tr></thead>
            <tbody>
                @foreach ($section_results as $result)
                    <tr>
                        <td>{{ $result->component }}</td>
                        <td>{{ $result->raw_score ?? '—' }}</td>
                        <td>{{ $result->weighted_score ?? '—' }}</td>
                        <td>{{ $result->cefr_ref ?? '—' }}</td>
                        <td>{{ $result->lifecycle_state }}</td>
                        <td>
                            @if ($result->lifecycle_state === 'scored')
                                <form method="POST" action="{{ route('placement.section.moderate', $result->id) }}" style="display:inline">
                                    @csrf
                                    <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                    <button type="submit" class="btn small">Moderate</button>
                                </form>
                            @elseif ($result->lifecycle_state === 'moderated')
                                <form method="POST" action="{{ route('placement.section.approve', $result->id) }}" style="display:inline">
                                    @csrf
                                    <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                    <button type="submit" class="btn small">Approve</button>
                                </form>
                            @endif
                        </td>
                    </tr>
                @endforeach
            </tbody>
        </table>
        <form method="POST" action="{{ route('placement.section.score') }}" style="margin-top:10px">
            @csrf
            @php $attempt = $attempts->first(); @endphp
            @if ($attempt)
                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                <input type="hidden" name="attempt_id" value="{{ $attempt->id }}">
                <select name="section_id" required>
                    @foreach ($section_results->filter(fn($r) => $r->raw_score === null) as $r)
                        <option value="{{ $r->section_id }}">{{ $r->component }}</option>
                    @endforeach
                </select>
                <input name="raw_score" type="number" step="0.01" placeholder="Score" required>
                <input name="cefr_ref" placeholder="CEFR" required>
                <input name="rationale" placeholder="Rationale">
                <button type="submit" class="btn small">Professional mark</button>
            @endif
        </form>
    @endif
</div>

<div class="card">
    <h2>Decision chain</h2>
    <div class="toolbar">
        @if ($profile->lifecycle_state === 'released')
            <form method="POST" action="{{ route('placement.supersede', $profile->id) }}">
                @csrf
                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                <button type="submit" class="btn small">Supersede (retake)</button>
            </form>
        @endif
        @if ($profile->lifecycle_state === 'recommended')
            <form method="POST" action="{{ route('placement.review', $profile->id) }}">
                @csrf
                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                <button type="submit" class="btn small">Review</button>
            </form>
        @endif
        @if ($profile->lifecycle_state === 'reviewed')
            <form method="POST" action="{{ route('placement.approve', $profile->id) }}">
                @csrf
                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                <button type="submit" class="btn small">Approve</button>
            </form>
        @endif
        @if ($profile->lifecycle_state === 'approved')
            <form method="POST" action="{{ route('placement.release', $profile->id) }}">
                @csrf
                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                <button type="submit" class="btn small">Release</button>
            </form>
        @endif
        @if (\in_array($profile->lifecycle_state, ['scored','recommended'], true))
            <form method="POST" action="{{ route('placement.recommend', $profile->id) }}">
                @csrf
                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                <button type="submit" class="btn small">Generate recommendation</button>
            </form>
        @endif
    </div>
</div>

<div class="card">
    <h2>Finance lineage (read-only)</h2>
    @if (empty($financeLink['student_id']))
        <p class="sub">No student conversion yet, so no Finance facts are linked.</p>
    @else
        <p class="sub">Student {{ $financeLink['student_id'] }} · {{ count($financeLink['obligations']) }} obligation(s) · {{ count($financeLink['payments']) }} payment(s)</p>
        @if (count($financeLink['obligations']) || count($financeLink['payments']))
            <table>
                <thead><tr><th>Type</th><th>Reference</th><th>Amount</th><th>Detail</th><th>Date</th></tr></thead>
                <tbody>
                    @foreach ($financeLink['obligations'] as $obligation)
                        <tr><td>Obligation</td><td>{{ $obligation->id }}</td><td>{{ $obligation->original_amount }}</td><td>{{ $obligation->source }}</td><td>{{ $obligation->created_at }}</td></tr>
                    @endforeach
                    @foreach ($financeLink['payments'] as $payment)
                        <tr><td>Payment</td><td>{{ $payment->id }}</td><td>{{ $payment->amount }}</td><td>{{ $payment->method }}</td><td>{{ $payment->received_on }}</td></tr>
                    @endforeach
                </tbody>
            </table>
        @else
            <p class="sub">No obligations or payments for this student yet.</p>
        @endif
    @endif
</div>

<div class="card">
    <h2>Official placement report (Documents)</h2>
    <form method="POST" action="{{ route('placement.report.register', $profile->id) }}">
        @csrf
        <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
        <div class="row">
            <input name="classification_id" placeholder="Document classification id" required>
            <input name="title" placeholder="Report title" required>
        </div>
        <div class="row">
            <input name="content_hash" placeholder="sha256 content hash" required>
            <input name="storage_ref" placeholder="Storage reference" required>
        </div>
        <button type="submit" class="btn small">Register report via Documents</button>
    </form>
</div>

<div class="card">
    <h2>Recommendation history</h2>
    @if ($recommendations->isEmpty())
        <p class="sub">None yet.</p>
    @else
        @foreach ($recommendations as $recommendation)
            <div style="margin-bottom:8px">
                <strong>{{ $recommendation->level?->level_key ?? $recommendation->recommended_level_id }}</strong>
                <em>{{ $recommendation->model_version }}</em>
                <p>{{ $recommendation->rationale }}</p>
            </div>
        @endforeach
    @endif
</div>
@endsection
