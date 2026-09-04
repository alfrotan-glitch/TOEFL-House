@extends('print.layout')

@section('docTitle', 'Official Transcript')
@section('docName', 'Official Transcript of Academic Record')

@section('body')
    <div style="text-align:center; padding: 18px 0 8px 0;">
        <div style="font-size: 26px; font-weight: 700;">{{ $payload['student']['legal_name'] ?? '—' }}</div>
        <div style="font-size: 13px; color:#5b6472;">Student code {{ $payload['student']['student_code'] ?? '—' }} · {{ $payload['program']['program_name'] ?? '' }} ({{ $payload['program']['version_summary'] ?? '' }})</div>
        <div style="font-size: 12px; color:#5b6472;">Issued {{ $issuedOn }} · Content hash <code>{{ \Illuminate\Support\Str::limit($transcript->content_hash, 20) }}</code> · {{ $verified ? 'hash verified' : 'HASH MISMATCH' }}</div>
    </div>

    <h3>Level achievements</h3>
    @if (empty($payload['levels']))
        <p>No level achievements recorded in this program version.</p>
    @else
        <table class="doc">
            <tr><th>Level</th><th>CEFR</th><th>Outcome</th><th>Class period</th><th>Score</th><th>Achieved</th></tr>
            @foreach ($payload['levels'] as $level)
                <tr>
                    <td>{{ $level['to_level']['title'] ?? $level['level']['title'] ?? '—' }}</td>
                    <td>{{ $level['to_level']['cefr_ref'] ?? $level['level']['cefr_ref'] ?? '—' }}</td>
                    <td>{{ $level['outcome'] }}@if(($level['repeat_count'] ?? 0) > 0) (repeat {{ $level['repeat_count'] }})@endif</td>
                    <td>{{ $level['period']['name'] ?? '—' }}</td>
                    <td>{{ $level['result_score'] ?? '—' }}</td>
                    <td>{{ isset($level['achieved_at']) ? substr($level['achieved_at'], 0, 10) : '—' }}</td>
                </tr>
            @endforeach
        </table>
    @endif

    <h3>Released assessment results</h3>
    @if (empty($payload['results']))
        <p>No released results in this program version.</p>
    @else
        <table class="doc">
            <tr><th>Attempt</th><th>Score</th></tr>
            @foreach ($payload['results'] as $result)
                <tr>
                    <td>{{ $result['attempt_kind'] ?? 'assessment' }}</td>
                    <td>{{ $result['score'] }}</td>
                </tr>
            @endforeach
        </table>
    @endif

    <h3>Seats</h3>
    <table class="doc">
        <tr><th>Period</th><th>State</th><th>Basis</th></tr>
        @foreach ($payload['seats']['completed'] ?? [] as $seat)
            <tr>
                <td>{{ $seat['period']['name'] ?? '—' }}</td>
                <td>{{ $seat['state'] }}</td>
                <td>{{ $seat['completion_basis'] ?? '—' }}</td>
            </tr>
        @endforeach
        @foreach ($payload['seats']['in_progress'] ?? [] as $seat)
            <tr>
                <td>{{ $seat['period']['name'] ?? '—' }}</td>
                <td>{{ $seat['state'] }} (in progress — not yet certified)</td>
                <td>—</td>
            </tr>
        @endforeach
    </table>

    <h3>Attendance totals</h3>
    @if (empty($payload['attendance']))
        <p>No attendance recorded.</p>
    @else
        <table class="doc">
            <tr><th>Sessions</th><th>Marked</th><th>Present</th><th>Absent</th><th>Late</th><th>Excused</th></tr>
            @foreach ($payload['attendance'] as $row)
                <tr>
                    <td>{{ $row['sessions'] }}</td>
                    <td>{{ $row['marked'] }}</td>
                    <td>{{ $row['present'] }}</td>
                    <td>{{ $row['absent'] }}</td>
                    <td>{{ $row['late'] }}</td>
                    <td>{{ $row['excused'] }}</td>
                </tr>
            @endforeach
        </table>
    @endif

    @if (!empty($payload['entry']))
        <h3>Placement entry</h3>
        <table class="doc">
            <tr><th>Recommended level</th><th>CEFR</th><th>Snapshot</th></tr>
            <tr>
                <td>{{ $payload['entry']['recommended_level']['title'] ?? '—' }}</td>
                <td>{{ $payload['entry']['recommended_level']['cefr_ref'] ?? '—' }}</td>
                <td><code>{{ \Illuminate\Support\Str::limit($payload['entry']['snapshot_id'] ?? '', 14) }}</code></td>
            </tr>
        </table>
    @endif

    @if (!empty($payload['graduation']))
        <h3>Graduation</h3>
        <table class="doc">
            <tr><th>Certificate serial</th><td><code>{{ $payload['graduation']['certificate_serial'] ?? '—' }}</code></td></tr>
        </table>
    @endif
@endsection

@push('signatures')
    <div class="sig">
        <div class="box">Issuing authority (director)</div>
        <div class="box">Registrar / academic office</div>
    </div>
@endpush
