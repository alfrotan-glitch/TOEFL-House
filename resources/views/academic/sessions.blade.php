@extends('layouts.app')

@section('title', 'Session Calendar')

@section('content')
<div class="card">
    <h1>Session Calendar &amp; Attendance</h1>
    <p class="sub">Schedule sessions for active classes (optionally tagged with a skill) and record append-only attendance facts for enrolled students.</p>
</div>

<div class="card">
    <h2>Schedule a session</h2>
    <form method="POST" action="{{ route('academic.schedule') }}">
        @csrf
        <div class="row">
            <div>
                <label>Active class</label>
                <select name="class_id" required>
                    <option value="">Select a class…</option>
                    @foreach ($classes as $class)
                        <option value="{{ $class->id }}">{{ \Illuminate\Support\Str::limit($class->id, 16) }} (cap {{ $class->capacity }})</option>
                    @endforeach
                </select>
            </div>
            <div>
                <label>Date</label>
                <input type="date" name="scheduled_on" required>
            </div>
            <div>
                <label>Starts (HH:MM)</label>
                <input type="text" name="starts_at" placeholder="09:00" required>
            </div>
            <div>
                <label>Ends (HH:MM)</label>
                <input type="text" name="ends_at" placeholder="10:30" required>
            </div>
            <div>
                <label>Skill (optional)</label>
                <select name="skill_id">
                    <option value="">Whole session</option>
                    @foreach ($skills as $skill)
                        <option value="{{ $skill->id }}">{{ $skill->name }}</option>
                    @endforeach
                </select>
            </div>
        </div>
        <div class="actions"><button type="submit" class="btn">Schedule session</button></div>
    </form>
</div>

<div class="card">
    <h2>Sessions (newest first)</h2>
    @if ($sessions->isEmpty())
        <p class="empty">No sessions scheduled yet.</p>
    @else
        <table class="grid">
            <tr><th>When</th><th>Class</th><th>Skill</th><th>Attendance</th></tr>
            @foreach ($sessions as $session)
                <tr>
                    <td>{{ $session->scheduled_on }}<br><span class="muted">{{ $session->starts_at }}–{{ $session->ends_at }}</span></td>
                    <td>{{ \Illuminate\Support\Str::limit($session->class_id, 16) }}</td>
                    <td>{{ $session->skill_id ? \Illuminate\Support\Str::limit($session->skill_id, 14) : 'whole' }}</td>
                    <td>
                        @php($classEnrollments = $enrollments->where('class_id', $session->class_id))
                        @if ($classEnrollments->isEmpty())
                            <span class="muted">no enrolled students</span>
                        @else
                            <details>
                                <summary class="btn small secondary" style="display:inline-block; cursor:pointer">Record attendance</summary>
                                <form method="POST" action="{{ route('academic.attendance', $session->id) }}" style="margin-top:8px">
                                    @csrf
                                    <label>Enrollment</label>
                                    <select name="enrollment_id" required>
                                        @foreach ($classEnrollments as $enrollment)
                                            <option value="{{ $enrollment->id }}">{{ \Illuminate\Support\Str::limit($enrollment->student_id, 16) }}</option>
                                        @endforeach
                                    </select>
                                    <label>Status</label>
                                    <select name="status" required>
                                        <option value="present">Present</option>
                                        <option value="late">Late</option>
                                        <option value="absent">Absent</option>
                                        <option value="excused">Excused</option>
                                    </select>
                                    <div class="actions"><button type="submit" class="btn small">Record fact</button></div>
                                </form>
                            </details>
                        @endif
                    </td>
                </tr>
            @endforeach
        </table>
    @endif
</div>
@endsection
