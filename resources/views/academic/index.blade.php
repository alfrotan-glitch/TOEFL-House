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

<div class="card">
    <h2>Structure</h2>
    <p class="sub">Programs publish immutable versions; periods move draft → published → closed; skills drive delivery and payroll evidence.</p>
    <form method="POST" action="{{ route('academic.program.define') }}">
        @csrf
        <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
        <div class="fields">
            <input name="name" type="text" placeholder="Program name" required>
        </div>
        <div class="actions"><button type="submit" class="btn">Define program</button></div>
    </form>
    @if ($programs->isEmpty())
        <p class="empty">No programs recorded.</p>
    @else
        <table class="grid" style="margin-top:8px">
            <tr><th>Program</th><th>Publish an immutable version</th></tr>
            @foreach ($programs as $program)
                <tr>
                    <td>{{ $program->name }}</td>
                    <td>
                        <form method="POST" action="{{ route('academic.version.publish', $program->id) }}" style="display:inline">
                            @csrf
                            <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                            <input name="summary" type="text" placeholder="Version summary" required>
                            <button type="submit" class="btn small">Publish version</button>
                        </form>
                    </td>
                </tr>
            @endforeach
        </table>
    @endif
    <form method="POST" action="{{ route('academic.period.define') }}" style="margin-top:8px">
        @csrf
        <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
        <div class="fields">
            <input name="name" type="text" placeholder="Period name" required>
            <input type="date" name="starts_on" required>
            <input type="date" name="ends_on" required>
        </div>
        <div class="actions"><button type="submit" class="btn">Define period</button></div>
    </form>
    @if ($periods->isEmpty())
        <p class="empty">No periods recorded.</p>
    @else
        <table class="grid" style="margin-top:8px">
            <tr><th>Period</th><th>Window</th><th>Transition</th></tr>
            @foreach ($periods as $period)
                <tr>
                    <td>{{ $period->name }}</td>
                    <td>{{ $period->starts_on }} → {{ $period->ends_on }}</td>
                    <td><span class="pill">{{ $period->lifecycle_state }}</span>
                        @if ($period->lifecycle_state === 'draft')
                            <form method="POST" action="{{ route('academic.period.transition', $period->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <input type="hidden" name="to_state" value="published">
                                <button type="submit" class="btn small">Publish</button>
                            </form>
                        @endif
                        @if ($period->lifecycle_state === 'published')
                            <form method="POST" action="{{ route('academic.period.transition', $period->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <input type="hidden" name="to_state" value="closed">
                                <button type="submit" class="btn small">Close</button>
                            </form>
                        @endif
                    </td>
                </tr>
            @endforeach
        </table>
    @endif
    <form method="POST" action="{{ route('academic.skill.register') }}" style="margin-top:8px">
        @csrf
        <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
        <div class="fields">
            <input name="key" type="text" placeholder="Skill key (e.g. reading)" required>
            <input name="name" type="text" placeholder="Skill name" required>
        </div>
        <div class="actions"><button type="submit" class="btn">Register skill</button></div>
    </form>
    @foreach ($skills as $skill)
        <form method="POST" action="{{ route('academic.skill.retire', $skill->id) }}" style="display:inline;margin-top:8px">
            @csrf
            <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
            <span class="pill">{{ $skill->name }} ({{ $skill->key }})</span>
            @if ($skill->lifecycle_state !== 'retired')
                <button type="submit" class="btn small">Retire</button>
            @endif
        </form>
    @endforeach
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

<div class="card">
    <h2>Assessment &amp; results</h2>
    <p class="sub">Attempt → scored → moderated → approved → released; a released result is corrected by a proposed new score that a distinct approver approves. A score never becomes a decision automatically.</p>
    <form method="POST" action="{{ route('academic.attempt.submit') }}">
        @csrf
        <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
        <div class="fields">
            <select name="enrollment_id" required>
                <option value="">Select an active enrollment…</option>
                @foreach ($activeEnrollments as $enrollment)
                    <option value="{{ $enrollment->id }}">{{ \Illuminate\Support\Str::limit($enrollment->student_id, 14) }} / {{ \Illuminate\Support\Str::limit($enrollment->class_id, 14) }}</option>
                @endforeach
            </select>
            <select name="kind" required>
                <option value="placement">Placement</option>
                <option value="assessment">Assessment</option>
            </select>
            <input name="evidence_ref" type="text" placeholder="Evidence reference" required>
        </div>
        <div class="actions"><button type="submit" class="btn">Submit attempt</button></div>
    </form>
</div>

<div class="card">
    <h2>Attempts awaiting a score</h2>
    @if ($attempts->isEmpty())
        <p class="empty">No submitted attempts awaiting a score.</p>
    @else
        <table class="grid">
            <tr><th>Enrollment</th><th>Kind</th><th>Evidence</th><th>Score</th></tr>
            @foreach ($attempts as $attempt)
                <tr>
                    <td>{{ \Illuminate\Support\Str::limit($attempt->enrollment_id, 18) }}</td>
                    <td>{{ $attempt->kind }}</td>
                    <td>{{ \Illuminate\Support\Str::limit($attempt->evidence_ref, 24) }}</td>
                    <td>
                        <form method="POST" action="{{ route('academic.attempt.score', $attempt->id) }}" style="display:inline">
                            @csrf
                            <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                            <input name="score" type="text" inputmode="decimal" placeholder="Score" required>
                            <button type="submit" class="btn small">Score</button>
                        </form>
                    </td>
                </tr>
            @endforeach
        </table>
    @endif
</div>

<div class="card">
    <h2>Results in flight</h2>
    @if ($results->isEmpty())
        <p class="empty">No results awaiting moderation, approval or release.</p>
    @else
        <table class="grid">
            <tr><th>Attempt</th><th>Score</th><th>State</th><th>Next stage</th></tr>
            @foreach ($results as $result)
                <tr>
                    <td>{{ \Illuminate\Support\Str::limit($result->attempt_id, 18) }}</td>
                    <td>{{ $result->score }}</td>
                    <td><span class="pill">{{ $result->lifecycle_state }}</span></td>
                    <td>
                        @if ($result->lifecycle_state === 'scored')
                            <form method="POST" action="{{ route('academic.result.moderate', $result->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <button type="submit" class="btn small">Moderate</button>
                            </form>
                        @endif
                        @if ($result->lifecycle_state === 'moderated')
                            <form method="POST" action="{{ route('academic.result.approve', $result->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <button type="submit" class="btn small">Approve</button>
                            </form>
                        @endif
                        @if ($result->lifecycle_state === 'approved')
                            <form method="POST" action="{{ route('academic.result.release', $result->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <button type="submit" class="btn small">Release</button>
                            </form>
                        @endif
                    </td>
                </tr>
            @endforeach
        </table>
    @endif
</div>

<div class="card">
    <h2>Corrections awaiting approval</h2>
    @if ($corrections->isEmpty())
        <p class="empty">No correction proposals awaiting approval.</p>
    @else
        <table class="grid">
            <tr><th>Result</th><th>New score</th><th>Reason</th><th>Proposed by</th><th>Approve</th></tr>
            @foreach ($corrections as $correction)
                <tr>
                    <td>{{ \Illuminate\Support\Str::limit($correction->result_id, 18) }}</td>
                    <td>{{ $correction->score }}</td>
                    <td>{{ \Illuminate\Support\Str::limit($correction->reason, 30) }}</td>
                    <td>{{ \Illuminate\Support\Str::limit($correction->proposed_by, 16) }}</td>
                    <td>
                        <form method="POST" action="{{ route('academic.correction.approve', $correction->id) }}" style="display:inline">
                            @csrf
                            <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                            <button type="submit" class="btn">Approve</button>
                        </form>
                    </td>
                </tr>
            @endforeach
        </table>
    @endif
</div>
@endsection
