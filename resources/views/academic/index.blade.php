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
@endsection
