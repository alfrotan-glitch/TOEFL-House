@extends('layouts.app')

@section('title', 'Class gradesheet')

@section('content')
<div class="card">
    <h1>Class gradesheet</h1>
    <p class="sub">Class {{ \Illuminate\Support\Str::limit($gradesheet['class']['id'], 24) }} · state <strong>{{ $gradesheet['class']['lifecycle_state'] }}</strong> · capacity {{ $gradesheet['class']['capacity'] }}</p>
    <p class="sub">Teachers:
        @if (empty($gradesheet['teachers']))
            <em>none assigned</em>
        @else
            @foreach ($gradesheet['teachers'] as $teacher)
                <span class="pill" title="{{ $teacher['effective_from'] }} → {{ $teacher['effective_to'] ?? 'open' }}">{{ \Illuminate\Support\Str::limit($teacher['teacher_person_id'], 18) }}{{ $teacher['effective_to'] !== null ? ' (ended)' : '' }}</span>
            @endforeach
        @endif
    </p>
    <div class="actions">
        <a class="btn secondary" href="{{ route('academic.index') }}">Back to Academic</a>
    </div>
</div>

@foreach ($gradesheet['seats'] as $seat)
    <div class="card">
        <h2>{{ $seat['student_code'] ?? \Illuminate\Support\Str::limit($seat['student_id'], 14) }}@if ($seat['legal_name']) — {{ $seat['legal_name'] }}@endif</h2>
        <p class="sub">Seat <span class="pill">{{ $seat['lifecycle_state'] }}</span></p>
        @if (empty($seat['attempts']))
            <p class="empty">No assessment attempts recorded for this seat.</p>
        @else
            @foreach ($seat['attempts'] as $attempt)
                <h3 style="margin-top:12px">{{ ucfirst($attempt['kind']) }} attempt · {{ \Illuminate\Support\Str::limit($attempt['evidence_ref'], 40) }}</h3>
                @if ($attempt['live'] === null)
                    <p class="empty">Submitted, awaiting a score.</p>
                    <form method="POST" action="{{ route('academic.attempt.score', $attempt['attempt_id']) }}" style="display:inline">
                        @csrf
                        <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                        <input name="score" type="text" inputmode="decimal" placeholder="Score" required>
                        <button type="submit" class="btn small">Score</button>
                    </form>
                @else
                    <p>
                        Score <strong>{{ $attempt['live']['score'] }}</strong>
                        <span class="pill {{ $attempt['live']['lifecycle_state'] === 'released' ? 'ok' : '' }}">{{ $attempt['live']['lifecycle_state'] }}</span>
                        @if ($attempt['live']['official'])
                            <strong>· official line</strong>
                        @endif
                    </p>
                    <p class="sub">Scored by {{ \Illuminate\Support\Str::limit($attempt['live']['scored_by'] ?? '—', 16) }}
                        · moderated by {{ \Illuminate\Support\Str::limit($attempt['live']['moderated_by'] ?? '—', 16) }}
                        · approved by {{ \Illuminate\Support\Str::limit($attempt['live']['approved_by'] ?? '—', 16) }}
                        · released by {{ \Illuminate\Support\Str::limit($attempt['live']['released_by'] ?? '—', 16) }}</p>
                    @if ($attempt['live']['lifecycle_state'] === 'scored')
                        <form method="POST" action="{{ route('academic.result.moderate', $attempt['live']['result_id']) }}" style="display:inline">
                            @csrf
                            <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                            <button type="submit" class="btn small">Moderate</button>
                        </form>
                    @endif
                    @if ($attempt['live']['lifecycle_state'] === 'moderated')
                        <form method="POST" action="{{ route('academic.result.approve', $attempt['live']['result_id']) }}" style="display:inline">
                            @csrf
                            <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                            <button type="submit" class="btn small">Approve</button>
                        </form>
                    @endif
                    @if ($attempt['live']['lifecycle_state'] === 'approved')
                        <form method="POST" action="{{ route('academic.result.release', $attempt['live']['result_id']) }}" style="display:inline">
                            @csrf
                            <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                            <button type="submit" class="btn small">Release</button>
                        </form>
                    @endif
                    @if ($attempt['live']['lifecycle_state'] === 'released')
                        <form method="POST" action="{{ route('academic.result.mark-appealed', $attempt['live']['result_id']) }}" style="display:inline">
                            @csrf
                            <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                            <button type="submit" class="btn small secondary">Mark appealed</button>
                        </form>
                    @endif
                    @if (in_array($attempt['live']['lifecycle_state'], ['released', 'appealed'], true))
                        <form method="POST" action="{{ route('academic.result.correction', $attempt['live']['result_id']) }}" style="display:inline">
                            @csrf
                            <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                            <input name="score" type="text" inputmode="decimal" placeholder="Corrected score" required style="width:130px">
                            <input name="reason" type="text" placeholder="Correction reason" required>
                            <button type="submit" class="btn small secondary">Propose correction</button>
                        </form>
                    @endif
                    @if ($attempt['open_correction'] !== null)
                        <p class="sub">Open correction: new score <strong>{{ $attempt['open_correction']['score'] }}</strong> — {{ $attempt['open_correction']['reason'] }} (proposed by {{ \Illuminate\Support\Str::limit($attempt['open_correction']['proposed_by'], 16) }})</p>
                        <form method="POST" action="{{ route('academic.correction.approve', $attempt['open_correction']['correction_id']) }}" style="display:inline">
                            @csrf
                            <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                            <button type="submit" class="btn small">Approve correction</button>
                        </form>
                    @endif
                    @if (count($attempt['history']) > 1)
                        <p class="sub">Correction lineage:</p>
                        <ul>
                            @foreach ($attempt['history'] as $row)
                                <li>{{ $row['score'] }} ({{ $row['lifecycle_state'] }})@if ($row['corrects_id']) — corrects {{ \Illuminate\Support\Str::limit($row['corrects_id'], 14) }}: {{ $row['correction_reason'] }}@endif</li>
                            @endforeach
                        </ul>
                    @endif
                @endif
            @endforeach
        @endif
    </div>
@endforeach

@if (empty($gradesheet['seats']))
    <div class="card"><p class="empty">No seats have joined this class yet.</p></div>
@endif
@endsection
