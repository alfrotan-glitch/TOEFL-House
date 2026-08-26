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
@endsection
