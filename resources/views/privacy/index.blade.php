@extends('layouts.app')

@section('title', 'Privacy')

@section('content')
<div class="card">
    <h1>Privacy</h1>
    <p class="sub">Consent purposes and the consent lifecycle with its evidence, disclosures as immutable release evidence, and subject-data exports. Direct exports cover one subject under one scope; organization-wide exports are staged — an exporter requests, two distinct approvers sign in their own sessions, and an exporter executes.</p>
</div>

<div class="row">
    <div class="card" style="flex:1 1 320px">
        <h2>Consent purposes</h2>
        <form method="POST" action="{{ route('privacy.purpose.define') }}">
            @csrf
            <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
            <div class="row">
                <div>
                    <label>Name</label>
                    <input name="name" type="text" required>
                </div>
                <div>
                    <label>Channel</label>
                    <input name="channel" type="text" required>
                </div>
                <div>
                    <label>Category</label>
                    <input name="category" type="text" required>
                </div>
            </div>
            <div class="actions"><button type="submit" class="btn">Define purpose</button></div>
        </form>
        @if ($purposes->isEmpty())
            <p class="empty">No consent purposes defined.</p>
        @else
            <table class="grid" style="margin-top:8px">
                <tr><th>Name</th><th>Channel</th><th>Category</th></tr>
                @foreach ($purposes as $purpose)
                    <tr>
                        <td>{{ $purpose->name }}</td>
                        <td>{{ $purpose->channel }}</td>
                        <td><span class="pill">{{ $purpose->category }}</span></td>
                    </tr>
                @endforeach
            </table>
        @endif
    </div>

    <div class="card" style="flex:1 1 320px">
        <h2>Record a consent</h2>
        <p class="sub">A consent requires a verified subject, a defined purpose, and its evidence; it is a draft until verified and activated.</p>
        <form method="POST" action="{{ route('privacy.consent.record') }}">
            @csrf
            <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
            <div class="row">
                <div>
                    <label>Subject</label>
                    <select name="subject_person_id" required>
                        <option value="">Select a subject…</option>
                        @foreach ($people as $person)
                            <option value="{{ $person->id }}">{{ $person->legal_name }}</option>
                        @endforeach
                    </select>
                </div>
                <div>
                    <label>Purpose</label>
                    <select name="purpose_id" required>
                        <option value="">Select a purpose…</option>
                        @foreach ($purposes as $purpose)
                            <option value="{{ $purpose->id }}">{{ $purpose->name }}</option>
                        @endforeach
                    </select>
                </div>
                <div>
                    <label>Evidence reference</label>
                    <input name="evidence_ref" type="text" required>
                </div>
                <div>
                    <label>Effective from</label>
                    <input name="effective_from" type="date" required>
                </div>
                <div>
                    <label>Effective to (optional)</label>
                    <input name="effective_to" type="date">
                </div>
            </div>
            <div class="actions"><button type="submit" class="btn">Record consent</button></div>
        </form>
    </div>
</div>

<div class="card">
    <h2>Consents (newest first)</h2>
    <p class="sub">draft → submitted → verified → active → expired / revoked / archived. A revocation records its scope and effect.</p>
    @if ($consents->isEmpty())
        <p class="empty">No consents recorded.</p>
    @else
        <table class="grid">
            <tr><th>Subject</th><th>Purpose</th><th>Window</th><th>Evidence</th><th>State</th><th>Actions</th></tr>
            @foreach ($consents as $consent)
                <tr>
                    <td>{{ \Illuminate\Support\Str::limit($consent->subject_person_id, 16) }}</td>
                    <td>{{ \Illuminate\Support\Str::limit($consent->purpose_id, 16) }}</td>
                    <td>{{ $consent->effective_from }} → {{ $consent->effective_to ?? '—' }}</td>
                    <td><code>{{ \Illuminate\Support\Str::limit($consent->evidence_ref, 20) }}</code></td>
                    <td><span class="pill {{ $consent->lifecycle_state === 'active' ? 'ok' : '' }}">{{ $consent->lifecycle_state }}</span></td>
                    <td>
                        @if ($consent->lifecycle_state === 'draft')
                            <form method="POST" action="{{ route('privacy.consent.submit', $consent->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <button type="submit" class="btn small">Submit</button>
                            </form>
                        @endif
                        @if ($consent->lifecycle_state === 'submitted')
                            <form method="POST" action="{{ route('privacy.consent.verify', $consent->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <button type="submit" class="btn small">Verify</button>
                            </form>
                        @endif
                        @if ($consent->lifecycle_state === 'verified')
                            <form method="POST" action="{{ route('privacy.consent.activate', $consent->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <button type="submit" class="btn small">Activate</button>
                            </form>
                        @endif
                        @if ($consent->lifecycle_state === 'active')
                            <form method="POST" action="{{ route('privacy.consent.revoke', $consent->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <input name="scope" type="text" placeholder="Scope" required>
                                <input name="effect" type="text" placeholder="Effect" required>
                                <button type="submit" class="btn small secondary">Revoke</button>
                            </form>
                        @endif
                        @if ($consent->lifecycle_state === 'expired' || $consent->lifecycle_state === 'revoked')
                            <form method="POST" action="{{ route('privacy.consent.archive', $consent->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
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
    <h2>Record a disclosure</h2>
    <p class="sub">The immutable evidence of a data release: who received it, why, under which authority and scope.</p>
    <form method="POST" action="{{ route('privacy.disclosure.record') }}">
        @csrf
        <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
        <div class="row">
            <div>
                <label>Subject</label>
                <select name="subject_person_id" required>
                    <option value="">Select a subject…</option>
                    @foreach ($people as $person)
                        <option value="{{ $person->id }}">{{ $person->legal_name }}</option>
                    @endforeach
                </select>
            </div>
            <div>
                <label>Recipient</label>
                <input name="recipient" type="text" required>
            </div>
            <div>
                <label>Purpose</label>
                <input name="purpose" type="text" required>
            </div>
            <div>
                <label>Authority</label>
                <input name="authority" type="text" required>
            </div>
            <div>
                <label>Scope</label>
                <select name="scope_type" required>
                    <option value="subject">Subject</option>
                    <option value="department">Department</option>
                    <option value="branch">Branch</option>
                    <option value="campus">Campus</option>
                    <option value="organization">Organization</option>
                </select>
            </div>
            <div>
                <label>Scope id</label>
                <input name="scope_id" type="text" required>
            </div>
            <div>
                <label>Disclosed category</label>
                <input name="disclosed_category" type="text" required>
            </div>
        </div>
        <div class="actions"><button type="submit" class="btn">Record disclosure</button></div>
    </form>
</div>

<div class="row">
    <div class="card" style="flex:1 1 320px">
        <h2>Export subject data</h2>
        <p class="sub">A direct export covers one subject under one non-organization scope. Organization-wide exports go through the staged approval chain.</p>
        <form method="POST" action="{{ route('privacy.export.direct') }}">
            @csrf
            <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
            <div class="row">
                <div>
                    <label>Subject</label>
                    <select name="subject_person_id" required>
                        <option value="">Select a subject…</option>
                        @foreach ($people as $person)
                            <option value="{{ $person->id }}">{{ $person->legal_name }}</option>
                        @endforeach
                    </select>
                </div>
                <div>
                    <label>Purpose</label>
                    <input name="purpose" type="text" required>
                </div>
                <div>
                    <label>Scope</label>
                    <select name="scope_type" required>
                        <option value="subject">Subject</option>
                        <option value="department">Department</option>
                        <option value="branch">Branch</option>
                        <option value="campus">Campus</option>
                    </select>
                </div>
                <div>
                    <label>Scope id</label>
                    <input name="scope_id" type="text" required>
                </div>
            </div>
            <div class="actions"><button type="submit" class="btn">Export subject data</button></div>
        </form>
        <h2 style="margin-top:16px">Request an organization-wide export</h2>
        <p class="sub">Executes only after two distinct approvers sign in their own sessions.</p>
        <form method="POST" action="{{ route('privacy.export.request') }}">
            @csrf
            <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
            <div class="row">
                <div>
                    <label>Subject</label>
                    <select name="subject_person_id" required>
                        <option value="">Select a subject…</option>
                        @foreach ($people as $person)
                            <option value="{{ $person->id }}">{{ $person->legal_name }}</option>
                        @endforeach
                    </select>
                </div>
                <div>
                    <label>Purpose</label>
                    <input name="purpose" type="text" required>
                </div>
                <div>
                    <label>Organization</label>
                    <select name="organization_id" required>
                        <option value="">Select an organization…</option>
                        @foreach ($organizations as $organization)
                            <option value="{{ $organization->id }}">{{ $organization->name }}</option>
                        @endforeach
                    </select>
                </div>
            </div>
            <div class="actions"><button type="submit" class="btn">Request export</button></div>
        </form>
    </div>

    <div class="card" style="flex:1 1 320px">
        <h2>Bulk export requests (newest first)</h2>
        @if ($exportRequests->isEmpty())
            <p class="empty">No bulk export requests.</p>
        @else
            <table class="grid">
                <tr><th>Subject</th><th>Purpose</th><th>Approvers</th><th>State</th><th>Actions</th></tr>
                @foreach ($exportRequests as $exportRequest)
                    <tr>
                        <td>{{ \Illuminate\Support\Str::limit($exportRequest->subject_person_id, 16) }}</td>
                        <td class="muted">{{ \Illuminate\Support\Str::limit($exportRequest->purpose, 24) }}</td>
                        <td>{{ \Illuminate\Support\Str::limit($exportRequest->approver_one_id, 12) }} / {{ $exportRequest->approver_two_id !== null ? \Illuminate\Support\Str::limit($exportRequest->approver_two_id, 12) : '—' }}</td>
                        <td><span class="pill {{ $exportRequest->lifecycle_state === 'exported' ? 'ok' : '' }}">{{ $exportRequest->lifecycle_state }}</span></td>
                        <td>
                            @if ($exportRequest->lifecycle_state === 'requested')
                                <form method="POST" action="{{ route('privacy.export.approve', $exportRequest->id) }}" style="display:inline">
                                    @csrf
                                    <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                    <button type="submit" class="btn small" title="Signs this request under your authority (a distinct second approver is required)">Approve</button>
                                </form>
                            @endif
                            @if ($exportRequest->lifecycle_state === 'approved')
                                <form method="POST" action="{{ route('privacy.export.execute', $exportRequest->id) }}" style="display:inline">
                                    @csrf
                                    <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                    <button type="submit" class="btn small">Execute</button>
                                </form>
                            @endif
                        </td>
                    </tr>
                @endforeach
            </table>
        @endif
    </div>
</div>

<div class="row">
    <div class="card" style="flex:1 1 320px">
        <h2>Disclosures (newest first)</h2>
        @if ($disclosures->isEmpty())
            <p class="empty">No disclosures recorded.</p>
        @else
            <table class="grid">
                <tr><th>Subject</th><th>Recipient</th><th>Purpose</th><th>Category</th><th>Scope</th></tr>
                @foreach ($disclosures as $disclosure)
                    <tr>
                        <td>{{ \Illuminate\Support\Str::limit($disclosure->subject_person_id, 16) }}</td>
                        <td>{{ \Illuminate\Support\Str::limit($disclosure->recipient, 24) }}</td>
                        <td class="muted">{{ \Illuminate\Support\Str::limit($disclosure->purpose, 24) }}</td>
                        <td>{{ $disclosure->disclosed_category }}</td>
                        <td>{{ $disclosure->scope_type }}</td>
                    </tr>
                @endforeach
            </table>
        @endif
    </div>

    <div class="card" style="flex:1 1 320px">
        <h2>Consent revocations (newest first)</h2>
        @if ($revocations->isEmpty())
            <p class="empty">No consent revocations recorded.</p>
        @else
            <table class="grid">
                <tr><th>Consent</th><th>Scope</th><th>Effect</th><th>Revoked by</th></tr>
                @foreach ($revocations as $revocation)
                    <tr>
                        <td>{{ \Illuminate\Support\Str::limit($revocation->consent_id, 16) }}</td>
                        <td>{{ $revocation->scope }}</td>
                        <td class="muted">{{ \Illuminate\Support\Str::limit($revocation->effect, 24) }}</td>
                        <td>{{ \Illuminate\Support\Str::limit($revocation->revoked_by, 16) }}</td>
                    </tr>
                @endforeach
            </table>
        @endif
    </div>
</div>
@endsection
