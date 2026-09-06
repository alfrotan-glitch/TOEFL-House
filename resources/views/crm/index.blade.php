@extends('layouts.app')

@section('title', 'Visitor / Lead CRM')

@section('content')
<div class="card">
    <h1>Visitor / Lead CRM</h1>
    <p class="sub">Capture every contact, attribute it to a source/campaign, own the follow-up, record immutable interactions, and trace the lead into Applicants/Students. Everything here delegates to the CRM module commands — authorization, idempotency, business rules, and audit are enforced server-side.</p>
    <div class="toolbar">
        <div><strong>{{ $openCount }}</strong> open leads</div>
        <div><strong>{{ $convertedCount }}</strong> converted</div>
        <div><strong>{{ $visitors->count() }}</strong> shown</div>
    </div>
</div>

<div class="card">
    <h2>Capture a visitor</h2>
    <form method="POST" action="{{ route('crm.capture') }}">
        @csrf
        <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
        <div class="row">
            <div>
                <label>Full name (omit if person-linked)</label>
                <input name="full_name" type="text">
            </div>
            <div>
                <label>Phone</label>
                <input name="phone" type="text">
            </div>
            <div>
                <label>Email</label>
                <input name="email" type="email">
            </div>
        </div>
        <div class="row">
            <div>
                <label>Preferred channel</label>
                <select name="preferred_channel" required>
                    @foreach (['phone','whatsapp','email','sms','in_person','other'] as $channel)
                        <option value="{{ $channel }}">{{ $channel }}</option>
                    @endforeach
                </select>
            </div>
            <div>
                <label>Visitor type</label>
                <select name="visitor_type" required>
                    @foreach (['walk_in','online','phone','whatsapp','referral','admissions_event','social','other'] as $type)
                        <option value="{{ $type }}">{{ $type }}</option>
                    @endforeach
                </select>
            </div>
            <div>
                <label>Source</label>
                <select name="source_id">
                    <option value="">None</option>
                    @foreach ($sources as $source)
                        <option value="{{ $source->id }}">{{ $source->name }}</option>
                    @endforeach
                </select>
            </div>
            <div>
                <label>Campaign</label>
                <select name="campaign_id">
                    <option value="">None</option>
                    @foreach ($campaigns as $campaign)
                        <option value="{{ $campaign->id }}">{{ $campaign->name }} ({{ $campaign->channel }})</option>
                    @endforeach
                </select>
            </div>
        </div>
        <div class="row">
            <div>
                <label>Interest</label>
                <input name="interest" type="text">
            </div>
            <div>
                <label>Notes</label>
                <input name="notes" type="text">
            </div>
            <div>
                <label>Origin branch id (optional)</label>
                <input name="origin_branch_id" type="text" title="Branch provenance is immutable once assigned.">
            </div>
        </div>
        <div class="actions"><button type="submit" class="btn">Capture visitor</button></div>
    </form>
</div>

<div class="card">
    <h2>Sources &amp; campaigns</h2>
    <div class="row">
        <div>
            <form method="POST" action="{{ route('crm.source.define') }}">
                @csrf
                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                <h3>New source</h3>
                <label>Key</label><input name="key" type="text" required>
                <label>Name</label><input name="name" type="text" required>
                <label>Category</label><input name="category" type="text">
                <div class="actions"><button type="submit" class="btn small">Define source</button></div>
            </form>
        </div>
        <div>
            <form method="POST" action="{{ route('crm.campaign.define') }}">
                @csrf
                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                <h3>New campaign</h3>
                <label>Key</label><input name="key" type="text" required>
                <label>Name</label><input name="name" type="text" required>
                <label>Source</label>
                <select name="source_id"><option value="">None</option>@foreach ($sources as $source)<option value="{{ $source->id }}">{{ $source->name }}</option>@endforeach</select>
                <label>Channel</label>
                <select name="channel" required>@foreach (['walk_in','phone','whatsapp','email','social','website','referral','event','other'] as $channel)<option value="{{ $channel }}">{{ $channel }}</option>@endforeach</select>
                <label>Starts</label><input name="starts_on" type="date" required>
                <label>Ends</label><input name="ends_on" type="date">
                <div class="actions"><button type="submit" class="btn small">Define campaign</button></div>
            </form>
        </div>
        <div>
            <form method="POST" action="{{ route('crm.automation.define') }}">
                @csrf
                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                <h3>Automation rule</h3>
                <label>Key</label><input name="key" type="text" required>
                <label>Name</label><input name="name" type="text" required>
                <label>On outcome</label>
                <select name="trigger_value" required>@foreach (['requested_info','scheduled_visit','qualified','not_interested','no_answer'] as $o)<option value="{{ $o }}">{{ $o }}</option>@endforeach</select>
                <label>Assignee (person id)</label><input name="assignee" type="text" required>
                <label>Follow-up title</label><input name="title" type="text" required>
                <label>Due in days</label><input name="due_in_days" type="number" min="0" max="365" required>
                <div class="actions"><button type="submit" class="btn small">Define rule</button></div>
            </form>
        </div>
    </div>
</div>

<div class="card">
    <h2>Visitors</h2>
    @if ($visitors->isEmpty())
        <p class="empty">No visitors captured yet.</p>
    @else
        <table class="grid">
            <tr><th>Visitor</th><th>Contact</th><th>Source / Campaign</th><th>Stage</th><th>Owner</th><th>Actions</th></tr>
            @foreach ($visitors as $visitor)
                <tr>
                    <td>
                        <strong>{{ $visitor->full_name }}</strong><br>
                        <span class="muted">{{ $visitor->visitor_code }}</span>
                        @if ($visitor->conversion)
                            <span class="pill ok">{{ $visitor->conversion->conversion_type }}</span>
                        @endif
                    </td>
                    <td>{{ $visitor->phone ?? '—' }}<br>{{ $visitor->email ?? '—' }}</td>
                    <td>
                        {{ $visitor->source?->name ?? '—' }}<br>
                        <span class="muted">{{ $visitor->campaign?->name ?? '' }}</span>
                    </td>
                    <td><span class="pill {{ in_array($visitor->status, ['converted','lost','archived'], true) ? 'held' : 'ok' }}">{{ $visitor->status }}</span><br><span class="muted">{{ $visitor->rating ?? 'unrated' }}</span></td>
                    <td>{{ $visitor->assignee?->legal_name ?? $visitor->assigned_to ?? '—' }}</td>
                    <td>
                        <details>
                            <summary class="btn small secondary" style="display:inline-block; cursor:pointer">Manage</summary>
                            <div style="margin-top:8px; border:1px solid var(--line); padding:10px; border-radius:8px;">
                                @if (\in_array($visitor->status, ['new','contacted','engaged','qualified','unqualified'], true))
                                    <form method="POST" action="{{ route('crm.transition', $visitor->id) }}" style="margin-bottom:8px">
                                        @csrf
                                        <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                        <label>Advance / close</label>
                                        <select name="status">
                                            @foreach (['contacted','engaged','qualified','unqualified','lost','archived'] as $state)
                                                @if ($state !== $visitor->status)<option value="{{ $state }}">{{ $state }}</option>@endif
                                            @endforeach
                                        </select>
                                        <label>Reason (required for lost)</label><input name="reason" type="text">
                                        <button type="submit" class="btn small">Move</button>
                                    </form>
                                @endif

                                <form method="POST" action="{{ route('crm.interaction', $visitor->id) }}" style="margin-bottom:8px">
                                    @csrf
                                    <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                    <label>Record interaction</label>
                                    <div class="row">
                                        <select name="direction" required><option value="inbound">Inbound</option><option value="outbound">Outbound</option></select>
                                        <select name="type" required>@foreach (['call','whatsapp','email','sms','visit','meeting','form_submission','document','note','other'] as $t)<option value="{{ $t }}">{{ $t }}</option>@endforeach</select>
                                        <select name="outcome" required>@foreach (['no_answer','connected','positive','neutral','negative','unreachable','requested_info','scheduled_visit','followup_required','not_interested','qualified','converted','other'] as $o)<option value="{{ $o }}">{{ $o }}</option>@endforeach</select>
                                    </div>
                                    <label>Summary</label><input name="summary" type="text" required>
                                    <label>Occurred on</label><input name="occurred_on" type="date" required>
                                    <label>Placement/assessment attempt id (optional)</label><input name="assessment_attempt_id" type="text" title="Links this interaction to a placement/assessment attempt for pipeline traceability.">
                                    <label>Payment id (optional)</label><input name="payment_id" type="text" title="Links this interaction to a recorded finance payment for pipeline traceability.">
                                    <button type="submit" class="btn small">Record</button>
                                </form>

                                <form method="POST" action="{{ route('crm.followup', $visitor->id) }}" style="margin-bottom:8px">
                                    @csrf
                                    <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                    <label>Schedule follow-up</label>
                                    <div class="row">
                                        <input name="assigned_to" type="text" placeholder="Assignee person id" required>
                                        <input name="scheduled_for" type="date" required>
                                    </div>
                                    <label>Title</label><input name="title" type="text" required>
                                    <button type="submit" class="btn small">Schedule</button>
                                </form>

                                @if (!$visitor->person_id && \in_array($visitor->status, ['new','contacted','engaged','qualified','unqualified'], true))
                                    <form method="POST" action="{{ route('crm.link-person', $visitor->id) }}" style="margin-bottom:8px">
                                        @csrf
                                        <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                        <label>Link identity (person id)</label>
                                        <input name="person_id" type="text" placeholder="Verified/known person id" required>
                                        <button type="submit" class="btn small">Link person</button>
                                    </form>
                                @endif

                                @if (\in_array($visitor->status, ['new','contacted','engaged','qualified','unqualified'], true))
                                    <form method="POST" action="{{ route('crm.convert', $visitor->id) }}">
                                        @csrf
                                        <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                        <label>Record conversion</label>
                                        <div class="row">
                                            <select name="conversion_type" required><option value="applicant">Applicant</option><option value="student">Student</option><option value="enquiry">Enquiry</option></select>
                                            <input name="downstream_entity" type="text" placeholder="entity (applicant/student/enquiry)" required>
                                            <input name="downstream_id" type="text" placeholder="downstream id" required>
                                        </div>
                                        <button type="submit" class="btn small">Convert</button>
                                    </form>
                                @endif
                            </div>
                        </details>
                    </td>
                </tr>
            @endforeach
        </table>
    @endif
</div>
@endsection
