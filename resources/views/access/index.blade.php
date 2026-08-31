@extends('layouts.app')

@section('title', 'Access Administration')

@section('content')
<div class="card">
    <h1>Access Administration</h1>
    <p class="sub">Position assignments, the versioned policy catalog, named-scope grants, and dated delegations. Organization-wide grants are staged: a grantor session requests, two distinct approver sessions each sign, and the grant is executed only once approved.</p>
</div>

<div class="row">
    <div class="card" style="flex:1 1 340px">
        <h2>Propose a position assignment</h2>
        <form method="POST" action="{{ route('access.assignment.assign') }}">
            @csrf
            <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
            <label>Person</label>
            <select name="person_id" required>
                <option value="">Select a person…</option>
                @foreach ($people as $person)
                    <option value="{{ $person->id }}">{{ $person->legal_name }}</option>
                @endforeach
            </select>
            <label>Position</label>
            <select name="position_id" required>
                <option value="">Select a position…</option>
                @foreach ($positions as $position)
                    <option value="{{ $position->id }}">{{ $position->name }}</option>
                @endforeach
            </select>
            <label>Effective from</label>
            <input type="date" name="effective_from" required>
            <div class="actions"><button type="submit" class="btn">Propose assignment</button></div>
        </form>
    </div>

    <div class="card" style="flex:1 1 340px">
        <h2>Policy catalog</h2>
        <form method="POST" action="{{ route('access.policy.bind') }}">
            @csrf
            <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
            <label>Bind a position to a role</label>
            <select name="position_id" required>
                <option value="">Position…</option>
                @foreach ($positions as $position)
                    <option value="{{ $position->id }}">{{ $position->name }}</option>
                @endforeach
            </select>
            <select name="role_id" required>
                <option value="">Role…</option>
                @foreach ($roles as $role)
                    <option value="{{ $role->id }}">{{ $role->name }}</option>
                @endforeach
            </select>
            <label>Effective from</label>
            <input type="date" name="effective_from" required>
            <div class="actions"><button type="submit" class="btn">Bind position → role</button></div>
        </form>
        <form method="POST" action="{{ route('access.policy.permission') }}" style="margin-top:12px">
            @csrf
            <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
            <label>Grant a permission to a role</label>
            <select name="role_id" required>
                <option value="">Role…</option>
                @foreach ($roles as $role)
                    <option value="{{ $role->id }}">{{ $role->name }}</option>
                @endforeach
            </select>
            <input type="text" name="permission" required maxlength="120" placeholder="module.capability">
            <label>Effective from</label>
            <input type="date" name="effective_from" required>
            <div class="actions"><button type="submit" class="btn">Publish role permission</button></div>
        </form>
    </div>
</div>

<div class="row">
    <div class="card" style="flex:1 1 340px">
        <h2>Grant a named-scope permission</h2>
        <form method="POST" action="{{ route('access.grant.create') }}">
            @csrf
            <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
            <label>Person</label>
            <select name="person_id" required>
                <option value="">Select a person…</option>
                @foreach ($people as $person)
                    <option value="{{ $person->id }}">{{ $person->legal_name }}</option>
                @endforeach
            </select>
            <label>Permission</label>
            <input type="text" name="permission" required maxlength="120" placeholder="module.capability">
            <label>Scope type</label>
            <select name="scope_type" required>
                <option value="campus">campus</option>
                <option value="branch">branch</option>
                <option value="department">department</option>
            </select>
            <label>Scope id</label>
            <input type="text" name="scope_id" required maxlength="36">
            <label>Effective from</label>
            <input type="date" name="effective_from" required>
            <label>Effective to (optional)</label>
            <input type="date" name="effective_to">
            <label><input type="checkbox" name="emergency" value="1"> Emergency (requires expiry, ≤ 30 days, flagged for review)</label>
            <div class="actions"><button type="submit" class="btn">Grant permission</button></div>
        </form>
    </div>

    <div class="card" style="flex:1 1 340px">
        <h2>Request an organization-wide grant (staged)</h2>
        <form method="POST" action="{{ route('access.grant.request_org_wide') }}">
            @csrf
            <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
            <label>Person</label>
            <select name="person_id" required>
                <option value="">Select a person…</option>
                @foreach ($people as $person)
                    <option value="{{ $person->id }}">{{ $person->legal_name }}</option>
                @endforeach
            </select>
            <label>Permission</label>
            <input type="text" name="permission" required maxlength="120" placeholder="module.capability">
            <label>Organization</label>
            <select name="organization_id" required>
                <option value="">Select an organization…</option>
                @foreach ($organizations as $organization)
                    <option value="{{ $organization->id }}">{{ $organization->name }}</option>
                @endforeach
            </select>
            <label>Effective from</label>
            <input type="date" name="effective_from" required>
            <label>Effective to (optional)</label>
            <input type="date" name="effective_to">
            <label><input type="checkbox" name="emergency" value="1"> Emergency (requires expiry, ≤ 30 days, flagged for review)</label>
            <div class="actions"><button type="submit" class="btn">Request organization-wide grant</button></div>
        </form>
    </div>
</div>

<div class="card">
    <h2>Organization-wide grant requests (staged)</h2>
    @if ($grantRequests->isEmpty())
        <p class="empty">No organization-wide grant requests recorded.</p>
    @else
        <table class="grid">
            <tr><th>Person</th><th>Permission</th><th>Emergency</th><th>State</th><th>Approver 1</th><th>Approver 2</th><th></th></tr>
            @foreach ($grantRequests as $grantRequest)
                <tr>
                    <td class="muted">{{ \Illuminate\Support\Str::limit($grantRequest->person_id, 16) }}</td>
                    <td>{{ $grantRequest->permission }}</td>
                    <td>{{ $grantRequest->is_emergency ? 'yes' : 'no' }}</td>
                    <td><span class="pill {{ $grantRequest->lifecycle_state === 'granted' ? 'ok' : '' }}">{{ $grantRequest->lifecycle_state }}</span></td>
                    <td class="muted">{{ $grantRequest->approver_one_id ? \Illuminate\Support\Str::limit($grantRequest->approver_one_id, 14) : '—' }}</td>
                    <td class="muted">{{ $grantRequest->approver_two_id ? \Illuminate\Support\Str::limit($grantRequest->approver_two_id, 14) : '—' }}</td>
                    <td>
                        @if ($grantRequest->lifecycle_state === 'requested')
                            <form method="POST" action="{{ route('access.grant.approve_org_wide', $grantRequest->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <button type="submit" class="btn small">Sign approval</button>
                            </form>
                        @endif
                        @if ($grantRequest->lifecycle_state === 'approved')
                            <form method="POST" action="{{ route('access.grant.execute_org_wide', $grantRequest->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <button type="submit" class="btn small">Execute grant</button>
                            </form>
                        @endif
                    </td>
                </tr>
            @endforeach
        </table>
    @endif
</div>

<div class="card">
    <h2>Position assignments</h2>
    @if ($assignments->isEmpty())
        <p class="empty">No assignments recorded.</p>
    @else
        <table class="grid">
            <tr><th>Person</th><th>Position</th><th>State</th><th>From</th><th>To</th><th></th></tr>
            @foreach ($assignments as $assignment)
                @php($assignmentPosition = $positions->firstWhere('id', $assignment->position_id))
                <tr>
                    <td class="muted">{{ \Illuminate\Support\Str::limit($assignment->person_id, 16) }}</td>
                    <td>{{ $assignmentPosition?->name ?? \Illuminate\Support\Str::limit($assignment->position_id, 12) }}</td>
                    <td><span class="pill {{ $assignment->lifecycle_state === 'active' ? 'ok' : '' }}">{{ $assignment->lifecycle_state }}</span></td>
                    <td>{{ $assignment->effective_from }}</td>
                    <td class="muted">{{ $assignment->effective_to }}</td>
                    <td>
                        @if ($assignment->lifecycle_state === 'proposed')
                            <form method="POST" action="{{ route('access.assignment.activate', $assignment->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <button type="submit" class="btn small">Activate</button>
                            </form>
                            <form method="POST" action="{{ route('access.assignment.revoke', $assignment->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <button type="submit" class="btn small secondary">Revoke</button>
                            </form>
                        @elseif ($assignment->lifecycle_state === 'active')
                            <form method="POST" action="{{ route('access.assignment.revoke', $assignment->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <button type="submit" class="btn small secondary">Revoke</button>
                            </form>
                        @endif
                    </td>
                </tr>
            @endforeach
        </table>
    @endif
</div>

<div class="card">
    <h2>Policy versions (newest first)</h2>
    @if ($policies->isEmpty())
        <p class="empty">No policy versions published.</p>
    @else
        <table class="grid">
            <tr><th>Binding</th><th>Grants</th><th>From</th><th>To</th></tr>
            @foreach ($policies as $policy)
                @php($policyPosition = $policy->binding_type === 'position' ? $positions->firstWhere('id', $policy->binding_id) : null)
                @php($policyRole = ($policy->binding_type === 'role' ? $roles->firstWhere('id', $policy->binding_id) : null) ?? ($policy->grants_type === 'role' ? $roles->firstWhere('id', $policy->grants_id) : null))
                <tr>
                    <td>{{ $policy->binding_type === 'position' ? ($policyPosition?->name ?? \Illuminate\Support\Str::limit($policy->binding_id, 12)) : ($policyRole?->name ?? \Illuminate\Support\Str::limit($policy->binding_id, 12)) }}</td>
                    <td>{{ $policy->grants_type === 'role' ? ($policyRole?->name ?? \Illuminate\Support\Str::limit((string) $policy->grants_id, 12)) : $policy->permission }}</td>
                    <td>{{ $policy->effective_from }}</td>
                    <td class="muted">{{ $policy->effective_to }}</td>
                </tr>
            @endforeach
        </table>
    @endif
</div>

<div class="card">
    <h2>Scope grants (newest first)</h2>
    @if ($grants->isEmpty())
        <p class="empty">No scope grants recorded.</p>
    @else
        <table class="grid">
            <tr><th>Person</th><th>Permission</th><th>Scope</th><th>State</th><th>Emergency</th><th>From</th><th>To</th><th></th></tr>
            @foreach ($grants as $grant)
                <tr>
                    <td class="muted">{{ \Illuminate\Support\Str::limit($grant->person_id, 16) }}</td>
                    <td>{{ $grant->permission }}</td>
                    <td class="muted">{{ $grant->scope_type }}:{{ \Illuminate\Support\Str::limit($grant->scope_id, 12) }}</td>
                    <td><span class="pill {{ $grant->lifecycle_state === 'active' ? 'ok' : '' }}">{{ $grant->lifecycle_state }}</span></td>
                    <td>{{ $grant->is_emergency ? 'yes' : 'no' }}{{ $grant->review_required && $grant->lifecycle_state === 'active' ? ' (review due)' : '' }}</td>
                    <td>{{ $grant->effective_from }}</td>
                    <td class="muted">{{ $grant->effective_to }}</td>
                    <td>
                        @if ($grant->lifecycle_state === 'active')
                            <form method="POST" action="{{ route('access.grant.revoke', $grant->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <button type="submit" class="btn small secondary">Revoke</button>
                            </form>
                        @endif
                    </td>
                </tr>
            @endforeach
        </table>
    @endif
</div>

<div class="row">
    <div class="card" style="flex:1 1 340px">
        <h2>Delegate authority (temporary, reasoned)</h2>
        <form method="POST" action="{{ route('access.delegation.create') }}">
            @csrf
            <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
            <label>Delegator</label>
            <select name="delegator_person_id" required>
                <option value="">Select a person…</option>
                @foreach ($people as $person)
                    <option value="{{ $person->id }}">{{ $person->legal_name }}</option>
                @endforeach
            </select>
            <label>Delegate</label>
            <select name="delegate_person_id" required>
                <option value="">Select a person…</option>
                @foreach ($people as $person)
                    <option value="{{ $person->id }}">{{ $person->legal_name }}</option>
                @endforeach
            </select>
            <label>Permission (optional — all authority when empty)</label>
            <input type="text" name="permission" maxlength="120" placeholder="module.capability">
            <label>Scope type (optional)</label>
            <select name="scope_type">
                <option value="">all scopes</option>
                <option value="campus">campus</option>
                <option value="branch">branch</option>
                <option value="department">department</option>
                <option value="organization">organization</option>
            </select>
            <label>Scope id (when scoped)</label>
            <input type="text" name="scope_id" maxlength="36">
            <label>Effective from</label>
            <input type="date" name="effective_from" required>
            <label>Effective to</label>
            <input type="date" name="effective_to" required>
            <label>Reason</label>
            <input type="text" name="reason" required maxlength="1000">
            <div class="actions"><button type="submit" class="btn">Record delegation</button></div>
        </form>
    </div>

    <div class="card" style="flex:1 1 340px">
        <h2>Delegations (newest first)</h2>
        @if ($delegations->isEmpty())
            <p class="empty">No delegations recorded.</p>
        @else
            <table class="grid">
                <tr><th>From</th><th>To</th><th>State</th><th>Period</th><th></th></tr>
                @foreach ($delegations as $delegation)
                    <tr>
                        <td class="muted">{{ \Illuminate\Support\Str::limit($delegation->delegator_person_id, 14) }} → {{ \Illuminate\Support\Str::limit($delegation->delegate_person_id, 14) }}</td>
                        <td class="muted">{{ $delegation->permission ?? 'all' }}</td>
                        <td><span class="pill {{ $delegation->lifecycle_state === 'active' ? 'ok' : '' }}">{{ $delegation->lifecycle_state }}</span></td>
                        <td class="muted">{{ $delegation->effective_from }} → {{ $delegation->effective_to }}</td>
                        <td>
                            @if ($delegation->lifecycle_state === 'active')
                                <form method="POST" action="{{ route('access.delegation.revoke', $delegation->id) }}" style="display:inline">
                                    @csrf
                                    <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                    <button type="submit" class="btn small secondary">Revoke</button>
                                </form>
                            @endif
                        </td>
                    </tr>
                @endforeach
            </table>
        @endif
    </div>
</div>
@endsection
