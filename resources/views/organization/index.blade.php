@extends('layouts.app')

@section('title', 'Organization & Configuration')

@section('content')
<div class="card">
    <h1>Organization &amp; Configuration</h1>
    <p class="sub">The authoritative institutional structure. Structural changes are governed by the organization module commands and audited.</p>
</div>

<div class="row">
    <div class="card" style="flex:1 1 300px">
        <h2>Organizations</h2>
        @if ($organizations->isEmpty()) <p class="empty">No organizations recorded.</p> @else
        <table class="grid">
            <tr><th>Name</th><th>State</th></tr>
            @foreach ($organizations as $org)
                <tr><td>{{ $org->name }}</td><td><span class="pill {{ $org->lifecycle_state === 'active' ? 'ok' : '' }}">{{ $org->lifecycle_state }}</span></td></tr>
            @endforeach
        </table>
        @endif
    </div>
    <div class="card" style="flex:1 1 300px">
        <h2>Departments</h2>
        @if ($departments->isEmpty()) <p class="empty">No departments recorded.</p> @else
        <table class="grid">
            <tr><th>Name</th><th>State</th></tr>
            @foreach ($departments as $dept)
                <tr><td>{{ $dept->name }}</td><td><span class="pill {{ $dept->lifecycle_state === 'active' ? 'ok' : '' }}">{{ $dept->lifecycle_state }}</span></td></tr>
            @endforeach
        </table>
        @endif
    </div>
</div>

<div class="row">
    <div class="card" style="flex:1 1 300px">
        <h2>Branches &amp; Campuses</h2>
        @if ($branches->isEmpty()) <p class="empty">No branches recorded.</p> @else
        <table class="grid">
            <tr><th>Branch</th><th>State</th></tr>
            @foreach ($branches as $branch)
                <tr><td>{{ $branch->name }}</td><td><span class="pill {{ $branch->lifecycle_state === 'active' ? 'ok' : '' }}">{{ $branch->lifecycle_state }}</span></td></tr>
            @endforeach
        </table>
        @endif
    </div>
    <div class="card" style="flex:1 1 300px">
        <h2>Positions</h2>
        @if ($positions->isEmpty()) <p class="empty">No positions recorded.</p> @else
        <table class="grid">
            <tr><th>Position</th></tr>
            @foreach ($positions as $position)
                <tr><td>{{ $position->name }}</td></tr>
            @endforeach
        </table>
        @endif
    </div>
</div>
@endsection
