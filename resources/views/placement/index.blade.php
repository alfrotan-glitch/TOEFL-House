@extends('layouts.app')

@section('title', 'Placement Decision System')

@section('content')
<div class="card">
    <h1>Placement Decision System</h1>
    <p class="sub">Server-authoritative test bank, attempts, evidence marking, CEFR components, academic-level recommendation, staged approval, release, retake, and appeal. Placement measures evidence and establishes eligibility only; Enrollment and Scheduling retain class/offering authority. Every action is committed through Academic Placement commands — authorization, idempotency, anti-tamper, audit, and business rules are enforced server-side.</p>
    <div class="toolbar">
        <div><strong>{{ $profiles->count() }}</strong> profiles shown</div>
        <div><strong>{{ $tests->count() }}</strong> tests</div>
        <div><strong>{{ $versions->count() }}</strong> versions</div>
    </div>
</div>

@if ($canMaintainCatalog)
<div class="card">
    <h2>Definition: test bank</h2>
    @if ($catalogBranches->isEmpty())
        <p class="sub">No active branch is currently within your Placement catalog scope. A test bank cannot be created without an accountable operational branch.</p>
    @else
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
            <div>
                <label>Operational branch</label>
                <select name="branch_id" required>
                    @foreach ($catalogBranches as $branch)
                        <option value="{{ $branch->id }}">{{ $branch->name }}</option>
                    @endforeach
                </select>
            </div>
        </div>
        <div class="row">
            @foreach (['grammar','reading','listening','writing','speaking'] as $component)
                <div><label>{{ ucfirst($component) }} weight %</label><input name="{{ $component }}_weight" type="number" step="0.01" value="20" required></div>
            @endforeach
        </div>
        <button type="submit" class="btn">Define test</button>
    </form>
    @endif

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
        @php
            $draftVersions = $versions->where('lifecycle_state', 'draft');
            $draftSections = $sections->where('lifecycle_state', 'draft');
        @endphp
        <details>
            <summary>Build and publish a frozen version</summary>
            <p class="sub">Build all five components while the version is draft: define sections, then questions and rubrics, publish questions/rubrics, publish sections, then publish the version. Published versions and their evidence content cannot be edited; publish a corrected successor instead.</p>
            @foreach ($versions as $version)
                <form method="POST" action="{{ route('placement.version.publish', $version->id) }}">
                    @csrf
                    <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                    <span>v{{ $version->version_no }} ({{ $version->lifecycle_state }}) — {{ $version->summary }}</span>
                    @if ($version->lifecycle_state === 'draft')
                        <button type="submit" class="btn small">Validate &amp; publish version</button>
                    @endif
                </form>
            @endforeach

            @if ($draftVersions->isNotEmpty())
                <form method="POST" action="{{ route('placement.section.define') }}" style="margin-top:8px">
                    @csrf
                    <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                    <select name="version_id" required>
                        @foreach ($draftVersions as $version)
                            <option value="{{ $version->id }}">draft v{{ $version->version_no }}</option>
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
                    <label><input type="checkbox" name="can_auto_score" value="1"> server auto-score (MCQ / short answer only; leave clear for accountable physical marking)</label>
                    <button type="submit" class="btn small">Add draft section</button>
                </form>

                <form method="POST" action="{{ route('placement.rubric.define') }}" style="margin-top:8px">
                    @csrf
                    <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                    <select name="version_id" required>
                        @foreach ($draftVersions as $version)
                            <option value="{{ $version->id }}">draft v{{ $version->version_no }}</option>
                        @endforeach
                    </select>
                    <select name="component" required>@foreach (['grammar','reading','listening','writing','speaking'] as $c)<option value="{{ $c }}">{{ ucfirst($c) }}</option>@endforeach</select>
                    <input name="band" placeholder="Band label, e.g. B1" required>
                    <input name="min_score" type="number" step="0.01" min="0" max="100" placeholder="min" required>
                    <input name="max_score" type="number" step="0.01" min="0" max="100" placeholder="max" required>
                    <select name="cefr_ref" required><option value="A1">A1</option><option value="A2">A2</option><option value="B1">B1</option><option value="B2">B2</option><option value="C1">C1</option></select>
                    <input name="description" placeholder="Descriptor" required>
                    <button type="submit" class="btn small">Add draft rubric</button>
                </form>
            @endif

            @if ($draftSections->isNotEmpty())
                <form method="POST" action="{{ route('placement.question.define') }}" style="margin-top:8px">
                    @csrf
                    <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                    <select name="section_id" required>
                        @foreach ($draftSections as $section)
                            <option value="{{ $section->id }}">{{ $section->code }} · {{ $section->component }} · {{ $section->can_auto_score ? 'auto' : 'professional' }}</option>
                        @endforeach
                    </select>
                    <input name="code" placeholder="Question code" required>
                    <input name="stem" placeholder="Question / prompt" required>
                    <select name="question_type" required><option value="mcq">MCQ</option><option value="short_answer">Short answer</option><option value="essay">Essay</option><option value="speaking">Speaking</option></select>
                    <input name="points" type="number" step="0.01" min="0.01" placeholder="Points" required>
                    <input name="correct_answer" placeholder="Correct answer (required for auto)">
                    <span class="sub">Attach any checksummed media separately after creating the draft question.</span>
                    <button type="submit" class="btn small">Add draft question</button>
                </form>
            @endif

            <h3>Draft/catalog state</h3>
            @foreach ($sections as $section)
                <div class="row" style="margin:6px 0">
                    <span><strong>Section {{ $section->code }}</strong> · {{ $section->component }} · {{ $section->lifecycle_state }}</span>
                    @if ($section->lifecycle_state === 'draft')
                        <form method="POST" action="{{ route('placement.section.transition', $section->id) }}"><input type="hidden" name="_token" value="{{ csrf_token() }}"><input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}"><input type="hidden" name="to_state" value="published"><button class="btn small">Publish section</button></form>
                    @endif
                </div>
            @endforeach
            @foreach ($questions as $question)
                <div class="row" style="margin:6px 0">
                    <span>Question <strong>{{ $question->code }}</strong> · {{ $question->question_type }} · {{ $question->lifecycle_state }}
                        @foreach ($question->media as $media)
                            · media {{ $media->media_type }} ({{ $media->lifecycle_state }}, SHA-256 {{ $media->sha256 }})
                        @endforeach
                    </span>
                    @if ($question->lifecycle_state === 'draft')
                        <form method="POST" action="{{ route('placement.question.transition', $question->id) }}"><input type="hidden" name="_token" value="{{ csrf_token() }}"><input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}"><input type="hidden" name="to_state" value="published"><button class="btn small">Publish question</button></form>
                        <form method="POST" action="{{ route('placement.question.media.attach', $question->id) }}" class="row" style="margin-top:4px">
                            @csrf
                            <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                            <input name="uri" placeholder="Immutable media URI" required>
                            <input name="media_type" placeholder="Media type" required>
                            <input name="sha256" pattern="[0-9a-f]{64}" placeholder="SHA-256 (64 lowercase hex)" required>
                            <input name="mime_type" placeholder="MIME type" required>
                            <button class="btn small">Attach checksummed media</button>
                        </form>
                    @endif
                </div>
            @endforeach
            @foreach ($rubrics as $rubric)
                <div class="row" style="margin:6px 0">
                    <span>Rubric <strong>{{ $rubric->component }} {{ $rubric->band }}</strong> · {{ $rubric->min_score }}–{{ $rubric->max_score }} → {{ $rubric->cefr_ref }} · {{ $rubric->lifecycle_state }}</span>
                    @if ($rubric->lifecycle_state === 'draft')
                        <form method="POST" action="{{ route('placement.rubric.transition', $rubric->id) }}"><input type="hidden" name="_token" value="{{ csrf_token() }}"><input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}"><input type="hidden" name="to_state" value="published"><button class="btn small">Publish rubric</button></form>
                    @endif
                </div>
            @endforeach
        </details>
    @endif
</div>
@endif

@if ($canConduct)
<div class="card">
    <h2>Open a placement profile</h2>
    @if ($conductBranches->isEmpty())
        <p class="sub">No active branch is currently within your Placement conduct scope, so a profile cannot be opened.</p>
    @else
    <form method="POST" action="{{ route('placement.profile.open') }}">
        @csrf
        <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
        <div class="row">
            <div><label>Person id</label><input name="person_id" required></div>
            <div><label>Program version</label><input name="program_version_id" placeholder="optional"></div>
            <div><label>Visitor id</label><input name="visitor_id" placeholder="optional"></div>
            <div>
                <label>Operational branch</label>
                <select name="branch_id" required>
                    @foreach ($conductBranches as $branch)
                        <option value="{{ $branch->id }}">{{ $branch->name }}</option>
                    @endforeach
                </select>
            </div>
        </div>
        <button type="submit" class="btn">Open profile</button>
    </form>
    @endif
</div>

<div class="card">
    <h2>Profiles</h2>
    @if ($profiles->isEmpty())
        <p class="sub">No placement profiles yet.</p>
    @else
        <table>
            <thead><tr><th>Person</th><th>State</th><th>CEFR</th><th>Recommended academic level</th><th>Updated</th></tr></thead>
            <tbody>
                @foreach ($profiles as $profile)
                    <tr>
                        <td><a href="{{ route('placement.show', $profile->id) }}">{{ $profile->person?->legal_name ?? $profile->person_id }}</a></td>
                        <td>{{ $profile->lifecycle_state }}</td>
                        <td>{{ $profile->overall_cefr_ref ?? '—' }}</td>
                        <td>{{ $profile->recommendedLevel?->level_key ?? '—' }}</td>
                        <td>{{ $profile->updated_at }}</td>
                    </tr>
                @endforeach
            </tbody>
        </table>
    @endif
</div>
@endif
@endsection
