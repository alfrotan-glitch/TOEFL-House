@extends('layouts.app')

@section('title', 'Placement Decision System')

@section('content')
<div class="card">
    <h1>Placement Decision System</h1>
    <p class="sub">Server-authoritative test bank, attempts, evidence marking, CEFR components, level/class recommendation, staged approval, release, retake, and appeal. Every action is committed through the Academic Placement commands — authorization, idempotency, anti-tamper, audit, and business rules are enforced server-side.</p>
    <div class="toolbar">
        <div><strong>{{ $profiles->count() }}</strong> profiles shown</div>
        <div><strong>{{ $tests->count() }}</strong> tests</div>
        <div><strong>{{ $versions->count() }}</strong> versions</div>
    </div>
</div>

<div class="card">
    <h2>Definition: test bank</h2>
    <form method="POST" action="{{ route('placement.test.define') }}">
        @csrf
        <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
        <div class="row">
            <div><label>Key</label><input name="key" required></div>
            <div><label>Name</label><input name="name" required></div>
            <div>
                <label>Program version</label>
                <select name="program_version_id">
                    <option value="">None</option>
                    @foreach ($programVersions as $version)
                        <option value="{{ $version->id }}">{{ $version->id }}</option>
                    @endforeach
                </select>
            </div>
            <div><label>Total minutes</label><input name="total_time_minutes" type="number" min="1" value="90" required></div>
        </div>
        <div class="row">
            @foreach (['grammar','reading','listening','writing','speaking'] as $component)
                <div><label>{{ ucfirst($component) }} weight %</label><input name="{{ $component }}_weight" type="number" step="0.01" value="20" required></div>
            @endforeach
        </div>
        <button type="submit" class="btn">Define test</button>
    </form>

    @if ($tests->count())
        <div class="row">
            <form method="POST" action="{{ route('placement.version.create') }}" style="margin-top:10px">
                @csrf
                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                <select name="test_id" required>
                    @foreach ($tests as $test)
                        <option value="{{ $test->id }}">{{ $test->name }}</option>
                    @endforeach
                </select>
                <input name="summary" placeholder="Version summary" required>
                <button type="submit" class="btn small">Create draft version</button>
            </form>
        </div>
        <div class="row">
            @foreach ($tests as $test)
                <form method="POST" action="{{ route('placement.test.publish', $test->id) }}" style="margin-right:8px">
                    @csrf
                    <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                    <strong>{{ $test->name }}</strong> <em>({{ $test->lifecycle_state }})</em>
                    @if ($test->lifecycle_state === 'draft')
                        <button type="submit" class="btn small">Publish test</button>
                    @endif
                </form>
            @endforeach
        </div>
    @endif

    @if ($versions->count())
        <details>
            <summary>Publish / add sections to versions</summary>
            @foreach ($versions as $version)
                <form method="POST" action="{{ route('placement.version.publish', $version->id) }}">
                    @csrf
                    <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                    <span>v{{ $version->version_no }} ({{ $version->lifecycle_state }}) — {{ $version->summary }}</span>
                    @if ($version->lifecycle_state === 'draft')
                        <button type="submit" class="btn small">Publish version</button>
                    @endif
                </form>
            @endforeach
            <form method="POST" action="{{ route('placement.section.define') }}" style="margin-top:8px">
                @csrf
                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                <select name="version_id" required>
                    @foreach ($versions as $version)
                        <option value="{{ $version->id }}">v{{ $version->version_no }}</option>
                    @endforeach
                </select>
                <input name="code" placeholder="Section code" required>
                <input name="name" placeholder="Section name" required>
                <select name="component" required>
                    @foreach (['grammar','reading','listening','writing','speaking'] as $component)
                        <option value="{{ $component }}">{{ ucfirst($component) }}</option>
                    @endforeach
                </select>
                <input name="section_order" type="number" min="0" placeholder="Order" required>
                <input name="time_minutes" type="number" min="1" placeholder="Minutes" value="18" required>
                <select name="delivery_mode" required><option value="digital">Digital</option><option value="physical">Physical</option></select>
                <label><input type="checkbox" name="can_auto_score" value="1"> auto-score</label>
                <button type="submit" class="btn small">Add section</button>
            </form>
            <form method="POST" action="{{ route('placement.rubric.define') }}" style="margin-top:8px">
                @csrf
                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                <input type="hidden" name="version_id" value="{{ $versions->first()->id }}">
                <select name="component">@foreach (['grammar','reading','listening','writing','speaking'] as $c)<option value="{{ $c }}">{{ ucfirst($c) }}</option>@endforeach</select>
                <input name="band" placeholder="Band (A1..C1)" required>
                <input name="min_score" type="number" step="0.01" placeholder="min" required>
                <input name="max_score" type="number" step="0.01" placeholder="max" required>
                <input name="cefr_ref" placeholder="CEFR e.g. B1" required>
                <input name="description" placeholder="Descriptor" required>
                <button type="submit" class="btn small">Add rubric</button>
            </form>
        </details>
    @endif
</div>

<div class="card">
    <h2>Open a placement profile</h2>
    <form method="POST" action="{{ route('placement.profile.open') }}">
        @csrf
        <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
        <div class="row">
            <div><label>Person id</label><input name="person_id" required></div>
            <div><label>Program version</label><input name="program_version_id" placeholder="optional"></div>
            <div><label>Visitor id</label><input name="visitor_id" placeholder="optional"></div>
            <div><label>Branch id</label><input name="branch_id" placeholder="optional"></div>
        </div>
        <button type="submit" class="btn">Open profile</button>
    </form>
</div>

<div class="card">
    <h2>Profiles</h2>
    @if ($profiles->isEmpty())
        <p class="sub">No placement profiles yet.</p>
    @else
        <table>
            <thead><tr><th>Person</th><th>State</th><th>CEFR</th><th>Recommended level</th><th>Recommended class</th><th>Updated</th></tr></thead>
            <tbody>
                @foreach ($profiles as $profile)
                    <tr>
                        <td><a href="{{ route('placement.show', $profile->id) }}">{{ $profile->person?->legal_name ?? $profile->person_id }}</a></td>
                        <td>{{ $profile->lifecycle_state }}</td>
                        <td>{{ $profile->overall_cefr_ref ?? '—' }}</td>
                        <td>{{ $profile->recommendedLevel?->level_key ?? '—' }}</td>
                        <td>{{ $profile->recommendedClass?->id ?? '—' }}</td>
                        <td>{{ $profile->updated_at }}</td>
                    </tr>
                @endforeach
            </tbody>
        </table>
    @endif
</div>
@endsection
