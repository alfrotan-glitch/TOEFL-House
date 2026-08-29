@extends('layouts.app')

@section('title', 'Academic')

@section('content')
<div class="card">
    <h1>Academic</h1>
    <p class="sub">Structure (programs, periods, classes, skills, teacher assignments) and delivery (session calendar, attendance). One coherent multi-skill model across reading, vocabulary, listening, speaking, writing, and grammar.</p>
    <div class="actions">
        <a class="btn" href="{{ route('academic.sessions') }}">Session calendar &amp; attendance</a>
    </div>
</div>

<div class="row">
    <div class="card" style="flex:1 1 220px">
        <h2>Programs</h2>
        @forelse ($programs as $program)
            <div class="pill">{{ $program->name }} <span class="muted">({{ $program->lifecycle_state }})</span></div>
        @empty
            <p class="empty">No programs recorded.</p>
        @endforelse
    </div>
    <div class="card" style="flex:1 1 220px">
        <h2>Periods</h2>
        @forelse ($periods as $period)
            <div class="pill">{{ $period->name }} <span class="muted">({{ $period->starts_on }} → {{ $period->ends_on }})</span></div>
        @empty
            <p class="empty">No periods recorded.</p>
        @endforelse
    </div>
    <div class="card" style="flex:1 1 220px">
        <h2>Skills</h2>
        @forelse ($skills as $skill)
            <div class="pill">{{ $skill->name }} <span class="muted">({{ $skill->key }})</span></div>
        @empty
            <p class="empty">No skills recorded.</p>
        @endforelse
    </div>
</div>

<div class="card">
    <h2>Classes</h2>
    @if ($classes->isEmpty())
        <p class="empty">No classes recorded.</p>
    @else
        <table class="grid">
            <tr><th>Class</th><th>Capacity</th><th>State</th></tr>
            @foreach ($classes as $class)
                <tr>
                    <td>{{ \Illuminate\Support\Str::limit($class->id, 18) }}</td>
                    <td>{{ $class->capacity }}</td>
                    <td><span class="pill {{ $class->lifecycle_state === 'active' ? 'ok' : '' }}">{{ $class->lifecycle_state }}</span></td>
                </tr>
            @endforeach
        </table>
    @endif
</div>

<div class="card">
    <h2>Teacher assignments</h2>
    @if ($assignments->isEmpty())
        <p class="empty">No teacher assignments recorded.</p>
    @else
        <table class="grid">
            <tr><th>Class</th><th>Teacher</th><th>Effective</th></tr>
            @foreach ($assignments as $assignment)
                <tr>
                    <td>{{ \Illuminate\Support\Str::limit($assignment->class_id, 18) }}</td>
                    <td>{{ \Illuminate\Support\Str::limit($assignment->teacher_person_id, 18) }}</td>
                    <td>{{ $assignment->effective_from }}</td>
                </tr>
            @endforeach
        </table>
    @endif
</div>

<div class="card">
    <h2>Seats</h2>
    <p class="sub">A seat is requested by the clerk and activated by an approver; capacity and the active student/class state are owned by the academic module.</p>
    <form method="POST" action="{{ route('academic.enrollment.request') }}">
        @csrf
        <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
        <div class="fields">
            <select name="student_id" required>
                <option value="">Select a student…</option>
                @foreach ($students as $student)
                    <option value="{{ $student->id }}">{{ $student->student_code }}</option>
                @endforeach
            </select>
            <select name="class_id" required>
                <option value="">Select an active class…</option>
                @foreach ($classes as $class)
                    @if ($class->lifecycle_state === 'active')
                        <option value="{{ $class->id }}">{{ \Illuminate\Support\Str::limit($class->id, 14) }} (cap {{ $class->capacity }})</option>
                    @endif
                @endforeach
            </select>
        </div>
        <div class="actions"><button type="submit" class="btn">Request seat</button></div>
    </form>
    @if ($requestedEnrollments->isEmpty())
        <p class="empty">No seats awaiting activation.</p>
    @else
        <table class="grid">
            <tr><th>Student</th><th>Class</th><th>Activate</th></tr>
            @foreach ($requestedEnrollments as $seat)
                <tr>
                    <td>{{ \Illuminate\Support\Str::limit($seat->student_id, 18) }}</td>
                    <td>{{ \Illuminate\Support\Str::limit($seat->class_id, 18) }}</td>
                    <td>
                        <form method="POST" action="{{ route('academic.enrollment.activate', $seat->id) }}" style="display:inline">
                            @csrf
                            <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                            <button type="submit" class="btn">Activate</button>
                        </form>
                    </td>
                </tr>
            @endforeach
        </table>
    @endif
</div>

<div class="card">
    <h2>Progression decisions</h2>
    <p class="sub">Propose, review and approve are signed by three distinct employees in their own sessions.</p>
    <form method="POST" action="{{ route('academic.progression.propose') }}">
        @csrf
        <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
        <div class="fields">
            <select name="student_id" required>
                <option value="">Select a student…</option>
                @foreach ($students as $student)
                    <option value="{{ $student->id }}">{{ $student->student_code }}</option>
                @endforeach
            </select>
            <select name="class_id" required>
                <option value="">Select a class…</option>
                @foreach ($classes as $class)
                    <option value="{{ $class->id }}">{{ \Illuminate\Support\Str::limit($class->id, 14) }}</option>
                @endforeach
            </select>
            <select name="outcome" required>
                <option value="advance">Advance</option>
                <option value="repeat">Repeat</option>
            </select>
            <input name="reason" type="text" placeholder="Reason" required>
        </div>
        <div class="actions"><button type="submit" class="btn">Propose progression</button></div>
    </form>
    @if ($progressions->isEmpty())
        <p class="empty">No progression decisions awaiting review or approval.</p>
    @else
        <table class="grid">
            <tr><th>Student</th><th>Class</th><th>Outcome</th><th>State</th><th>Signatures</th></tr>
            @foreach ($progressions as $decision)
                <tr>
                    <td>{{ \Illuminate\Support\Str::limit($decision->student_id, 18) }}</td>
                    <td>{{ \Illuminate\Support\Str::limit($decision->class_id, 18) }}</td>
                    <td>{{ $decision->outcome }}</td>
                    <td><span class="pill">{{ $decision->lifecycle_state }}</span></td>
                    <td>
                        @if ($decision->lifecycle_state === 'proposed')
                            <form method="POST" action="{{ route('academic.progression.review', $decision->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <button type="submit" class="btn">Review</button>
                            </form>
                        @endif
                        @if ($decision->lifecycle_state === 'reviewed')
                            <form method="POST" action="{{ route('academic.progression.approve', $decision->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <button type="submit" class="btn">Approve</button>
                            </form>
                        @endif
                    </td>
                </tr>
            @endforeach
        </table>
    @endif
</div>
@endsection
