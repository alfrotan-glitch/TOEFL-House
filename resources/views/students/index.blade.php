@extends('layouts.app')

@section('title', 'Students & Admissions')

@section('content')
<div class="card">
    <h1>Students &amp; Admissions</h1>
    <p class="sub">The student lifecycle: applicant → admission decision → enrollment → active student, with append-only status history.</p>
    <div class="actions">
        <a class="btn" href="{{ route('students.applicants') }}">Manage applicants &amp; admissions</a>
    </div>
</div>

<div class="card">
    <h2>Students ({{ $activeCount }} active)</h2>
    @if ($students->isEmpty())
        <p class="empty">No students enrolled yet. Register and admit applicants to create students.</p>
    @else
        <table class="grid">
            <tr><th>Code</th><th>Status</th><th></th></tr>
            @foreach ($students as $student)
                <tr>
                    <td><a href="{{ route('students.show', $student->id) }}">{{ $student->student_code }}</a></td>
                    <td><span class="pill {{ $student->current_status === 'active' ? 'ok' : '' }}">{{ $student->current_status ?? '—' }}</span></td>
                    <td><a class="btn small secondary" href="{{ route('students.show', $student->id) }}">View</a></td>
                </tr>
            @endforeach
        </table>
    @endif
</div>
@endsection
