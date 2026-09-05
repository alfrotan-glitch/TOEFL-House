@extends('layouts.app')

@section('title', 'Session Calendar')

@section('content')
<div class="card">
    <h1>Session Calendar &amp; Attendance</h1>
    <p class="sub">Schedule sessions for active classes (optionally tagged with a skill, a room, and a class section) and record append-only attendance facts for enrolled students. A fact is never edited: correcting one appends a new fact linked to the original with a mandatory reason. The day timetable shows who teaches where.</p>
</div>

<div class="card">
    <h2>Rooms</h2>
    <p class="sub">A room is a branch-owned physical resource. It is bookable while <strong>available</strong>; taking it into maintenance or retiring it is refused while future sessions reference it.</p>
    <form method="POST" action="{{ route('academic.room.define') }}">
        @csrf
        <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
        <div class="row">
            <div>
                <label>Branch</label>
                <select name="branch_id" required>
                    <option value="">Select a branch…</option>
                    @foreach ($branches as $branch)
                        <option value="{{ $branch->id }}">{{ $branch->name }}</option>
                    @endforeach
                </select>
            </div>
            <div>
                <label>Name</label>
                <input type="text" name="name" placeholder="Room name" required>
            </div>
            <div>
                <label>Code (unique per branch)</label>
                <input type="text" name="code" placeholder="R-01" required>
            </div>
            <div>
                <label>Capacity</label>
                <input type="number" name="capacity" min="1" max="10000" placeholder="Capacity" required>
            </div>
            <div>
                <label>Type</label>
                <select name="room_type" required>
                    <option value="classroom">Classroom</option>
                    <option value="lab">Lab</option>
                    <option value="computer">Computer</option>
                    <option value="hall">Hall</option>
                    <option value="other">Other</option>
                </select>
            </div>
        </div>
        <div class="actions"><button type="submit" class="btn">Define room</button></div>
    </form>
    @if ($rooms->isEmpty())
        <p class="empty">No rooms defined yet.</p>
    @else
        <table class="grid" style="margin-top:8px">
            <tr><th>Code</th><th>Name</th><th>Type</th><th>Capacity</th><th>State</th><th>Actions</th></tr>
            @foreach ($rooms as $room)
                <tr>
                    <td>{{ $room->code }}</td>
                    <td>{{ $room->name }}</td>
                    <td>{{ $room->room_type }}</td>
                    <td>{{ $room->capacity }}</td>
                    <td><span class="pill {{ $room->lifecycle_state === 'available' ? 'ok' : '' }}">{{ $room->lifecycle_state }}</span></td>
                    <td>
                        @if ($room->lifecycle_state === 'available')
                            <form method="POST" action="{{ route('academic.room.transition', $room->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <input type="hidden" name="to_state" value="maintenance">
                                <button type="submit" class="btn small secondary">Maintenance</button>
                            </form>
                            <form method="POST" action="{{ route('academic.room.transition', $room->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <input type="hidden" name="to_state" value="retired">
                                <button type="submit" class="btn small secondary">Retire</button>
                            </form>
                        @endif
                        @if ($room->lifecycle_state === 'maintenance')
                            <form method="POST" action="{{ route('academic.room.transition', $room->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <input type="hidden" name="to_state" value="available">
                                <button type="submit" class="btn small">Back to available</button>
                            </form>
                            <form method="POST" action="{{ route('academic.room.transition', $room->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <input type="hidden" name="to_state" value="retired">
                                <button type="submit" class="btn small secondary">Retire</button>
                            </form>
                        @endif
                        @if ($room->lifecycle_state !== 'retired')
                            <form method="POST" action="{{ route('academic.room.resize', $room->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <input name="capacity" type="number" min="1" max="10000" placeholder="New cap…" required style="width:90px">
                                <button type="submit" class="btn small">Resize</button>
                            </form>
                        @endif
                    </td>
                </tr>
            @endforeach
        </table>
    @endif
</div>

<div class="card">
    <h2>Class sections</h2>
    <p class="sub">A section is a named operational group within a class with its own capacity and lifecycle. Sessions can target an <strong>open</strong> section; closing is refused while future sessions reference it.</p>
    <form method="POST" action="{{ route('academic.section.define') }}">
        @csrf
        <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
        <div class="row">
            <div>
                <label>Class</label>
                <select name="class_id" required>
                    <option value="">Select a class…</option>
                    @foreach ($sectionClasses as $class)
                        <option value="{{ $class->id }}">{{ \Illuminate\Support\Str::limit($class->id, 16) }} ({{ $class->lifecycle_state }})</option>
                    @endforeach
                </select>
            </div>
            <div>
                <label>Name (unique per class)</label>
                <input type="text" name="name" placeholder="Section A" required>
            </div>
            <div>
                <label>Capacity</label>
                <input type="number" name="capacity" min="1" max="10000" placeholder="Capacity" required>
            </div>
        </div>
        <div class="actions"><button type="submit" class="btn">Define section</button></div>
    </form>
    @if ($sections->isEmpty())
        <p class="empty">No sections defined yet.</p>
    @else
        <table class="grid" style="margin-top:8px">
            <tr><th>Class</th><th>Section</th><th>Capacity</th><th>State</th><th>Actions</th></tr>
            @foreach ($sections as $section)
                <tr>
                    <td>{{ \Illuminate\Support\Str::limit($section->class_id, 16) }}</td>
                    <td>{{ $section->name }}</td>
                    <td>{{ $section->capacity }}</td>
                    <td><span class="pill {{ $section->lifecycle_state === 'open' ? 'ok' : '' }}">{{ $section->lifecycle_state }}</span></td>
                    <td>
                        @if ($section->lifecycle_state === 'planned')
                            <form method="POST" action="{{ route('academic.section.transition', $section->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <input type="hidden" name="to_state" value="open">
                                <button type="submit" class="btn small">Open</button>
                            </form>
                            <form method="POST" action="{{ route('academic.section.transition', $section->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <input type="hidden" name="to_state" value="cancelled">
                                <button type="submit" class="btn small secondary">Cancel</button>
                            </form>
                        @endif
                        @if ($section->lifecycle_state === 'open')
                            <form method="POST" action="{{ route('academic.section.transition', $section->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <input type="hidden" name="to_state" value="closed">
                                <button type="submit" class="btn small secondary">Close</button>
                            </form>
                            <form method="POST" action="{{ route('academic.section.transition', $section->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <input type="hidden" name="to_state" value="cancelled">
                                <button type="submit" class="btn small secondary">Cancel</button>
                            </form>
                        @endif
                        @if (in_array($section->lifecycle_state, ['closed', 'cancelled'], true))
                            <form method="POST" action="{{ route('academic.section.transition', $section->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <input type="hidden" name="to_state" value="archived">
                                <button type="submit" class="btn small secondary">Archive</button>
                            </form>
                        @endif
                    </td>
                </tr>
            @endforeach
        </table>
    @endif
</div>

<div class="card">
    <h2>Schedule a session</h2>
    <form method="POST" action="{{ route('academic.schedule') }}">
        @csrf
        <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
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
            <div>
                <label>Room (optional)</label>
                <select name="room_id">
                    <option value="">No room</option>
                    @foreach ($rooms as $room)
                        @if ($room->lifecycle_state === 'available')
                            <option value="{{ $room->id }}">{{ $room->code }} — {{ $room->name }}</option>
                        @endif
                    @endforeach
                </select>
            </div>
            <div>
                <label>Section (optional)</label>
                <select name="section_id">
                    <option value="">Whole class</option>
                    @foreach ($sections as $section)
                        @if ($section->lifecycle_state === 'open')
                            <option value="{{ $section->id }}">{{ $section->name }} ({{ \Illuminate\Support\Str::limit($section->class_id, 12) }})</option>
                        @endif
                    @endforeach
                </select>
            </div>
        </div>
        <div class="actions"><button type="submit" class="btn">Schedule session</button></div>
    </form>
</div>

<div class="card">
    <h2>Day timetable</h2>
    <p class="sub">Branch day view: every session booked in the branch's rooms, ordered by start time.</p>
    <form method="GET" action="{{ route('academic.sessions') }}">
        <div class="row">
            <div>
                <label>Branch</label>
                <select name="timetable_branch_id" required>
                    <option value="">Select a branch…</option>
                    @foreach ($branches as $branch)
                        <option value="{{ $branch->id }}">{{ $branch->name }}</option>
                    @endforeach
                </select>
            </div>
            <div>
                <label>Day (defaults to today)</label>
                <input type="date" name="timetable_day">
            </div>
        </div>
        <div class="actions"><button type="submit" class="btn">Show timetable</button></div>
    </form>
    @if ($timetable !== null)
        <h3 style="margin-top:12px">Timetable for {{ $timetable['day'] }}</h3>
        @if (empty($timetable['sessions']))
            <p class="empty">No room bookings in this branch on that day.</p>
        @else
            <table class="grid" style="margin-top:8px">
                <tr><th>Time</th><th>Class</th><th>Section</th><th>Room</th></tr>
                @foreach ($timetable['sessions'] as $booking)
                    <tr>
                        <td>{{ $booking['starts_at'] }}–{{ $booking['ends_at'] }}</td>
                        <td>{{ \Illuminate\Support\Str::limit($booking['class_id'], 16) }}</td>
                        <td>{{ $booking['section'] ?? 'whole class' }}</td>
                        <td>{{ $booking['room'] ?? '—' }}</td>
                    </tr>
                @endforeach
            </table>
        @endif
    @endif
</div>

<div class="card">
    <h2>Sessions (newest first)</h2>
    @if ($sessions->isEmpty())
        <p class="empty">No sessions scheduled yet.</p>
    @else
        <table class="grid">
            <tr><th>When</th><th>Class</th><th>Skill</th><th>Room</th><th>Section</th><th>Attendance</th></tr>
            @foreach ($sessions as $session)
                <tr>
                    <td>{{ $session->scheduled_on }}<br><span class="muted">{{ $session->starts_at }}–{{ $session->ends_at }}</span></td>
                    <td>{{ \Illuminate\Support\Str::limit($session->class_id, 16) }}</td>
                    <td>{{ $session->skill_id ? \Illuminate\Support\Str::limit($session->skill_id, 14) : 'whole' }}</td>
                    <td>{{ $session->room?->code ?? '—' }}</td>
                    <td>{{ $session->section?->name ?? 'whole' }}</td>
                    <td>
                        @php($classEnrollments = $enrollments->where('class_id', $session->class_id))
                        @if ($classEnrollments->isEmpty())
                            <span class="muted">no enrolled students</span>
                        @else
                            <details>
                                <summary class="btn small secondary" style="display:inline-block; cursor:pointer">Record attendance</summary>
                                <form method="POST" action="{{ route('academic.attendance', $session->id) }}" style="margin-top:8px">
                                    @csrf
                                    <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
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

<div class="card">
    <h2>Correct an attendance fact</h2>
    <p class="sub">Corrections append a new fact and keep the original as history; a reason is mandatory and a correction must target a fact of the same enrollment.</p>
    @if ($attendanceFacts->isEmpty())
        <p class="empty">No attendance facts recorded yet.</p>
    @else
        <table class="grid" style="margin-top:8px">
            <tr><th>Fact</th><th>Session</th><th>Enrollment</th><th>Status</th><th>Corrects</th><th>Correction</th></tr>
            @foreach ($attendanceFacts as $fact)
                <tr>
                    <td>{{ \Illuminate\Support\Str::limit($fact->id, 14) }}</td>
                    <td>{{ \Illuminate\Support\Str::limit($fact->session_id, 14) }}</td>
                    <td>{{ \Illuminate\Support\Str::limit($fact->enrollment_id, 14) }}</td>
                    <td><span class="pill">{{ $fact->status }}</span></td>
                    <td>{{ $fact->corrects_id !== null ? \Illuminate\Support\Str::limit($fact->corrects_id, 14) : '—' }}</td>
                    <td>
                        <form method="POST" action="{{ route('academic.attendance.correct', $fact->id) }}" style="display:inline">
                            @csrf
                            <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                            <select name="status" required style="width:100px">
                                <option value="present">Present</option>
                                <option value="late">Late</option>
                                <option value="absent">Absent</option>
                                <option value="excused">Excused</option>
                            </select>
                            <input name="reason" type="text" placeholder="Correction reason…" required maxlength="1000" style="width:150px">
                            <button type="submit" class="btn small secondary">Correct</button>
                        </form>
                    </td>
                </tr>
            @endforeach
        </table>
    @endif
</div>
@endsection
