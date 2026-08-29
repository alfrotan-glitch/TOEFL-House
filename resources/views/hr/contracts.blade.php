@extends('layouts.app')

@section('title', 'Contract Versions')

@section('content')
<div class="card">
    <h1>Contract Versions</h1>
    <p class="sub">Compensation is defined per immutable contract version: prepare (draft) → add compensation rules → submit → approve. Rules use fixed monthly, per-scale, per-session, or per-hour methods and are resolved deterministically by payroll.</p>
</div>

<div class="card">
    <h2>Prepare a contract version</h2>
    <form method="POST" action="{{ route('hr.version.prepare') }}">
        @csrf
        <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
        <div class="row">
            <div>
                <label>Employment</label>
                <select name="employment_id" required>
                    <option value="">Select an employment…</option>
                    @foreach ($employments as $employment)
                        <option value="{{ $employment->id }}">{{ \Illuminate\Support\Str::limit($employment->person_id, 16) }} ({{ $employment->lifecycle_state }})</option>
                    @endforeach
                </select>
            </div>
            <div>
                <label>Terms reference</label>
                <input name="terms_ref" type="text" required>
            </div>
            <div>
                <label>Scale (optional)</label>
                <select name="scale_id">
                    <option value="">No scale</option>
                    @foreach ($scales as $scale)
                        <option value="{{ $scale->id }}">{{ $scale->name }}</option>
                    @endforeach
                </select>
            </div>
            <div>
                <label>Effective from</label>
                <input type="date" name="effective_from" required>
            </div>
            <div>
                <label>Effective to (optional)</label>
                <input type="date" name="effective_to">
            </div>
        </div>
        <div class="actions"><button type="submit" class="btn">Prepare version</button></div>
    </form>
</div>

<div class="card">
    <h2>Contracts</h2>
    <p class="sub">A hire requires an active signed contract: draft → sign (terms immutable) → close. Terminating the employment closes its active contract automatically.</p>
    <form method="POST" action="{{ route('hr.contract.draft') }}">
        @csrf
        <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
        <div class="row">
            <div>
                <label>Employment</label>
                <select name="employment_id" required>
                    <option value="">Select an employment…</option>
                    @foreach ($employments as $employment)
                        <option value="{{ $employment->id }}">{{ \Illuminate\Support\Str::limit($employment->person_id, 16) }} ({{ $employment->lifecycle_state }})</option>
                    @endforeach
                </select>
            </div>
            <div>
                <label>Terms summary</label>
                <input name="terms_summary" type="text" placeholder="e.g. S2 standard, 5 sessions/week" required>
            </div>
            <div>
                <label>Effective from</label>
                <input type="date" name="effective_from" required>
            </div>
        </div>
        <div class="actions"><button type="submit" class="btn">Draft contract</button></div>
    </form>
    @if ($contracts->isEmpty())
        <p class="empty">No contracts drafted yet.</p>
    @else
        <table class="grid" style="margin-top:8px">
            <tr><th>Contract</th><th>Employment</th><th>State</th><th>Effective</th><th>Signed ref</th><th>Actions</th></tr>
            @foreach ($contracts as $contract)
                <tr>
                    <td>{{ \Illuminate\Support\Str::limit($contract->id, 16) }}</td>
                    <td>{{ \Illuminate\Support\Str::limit($contract->employment_id, 16) }}</td>
                    <td><span class="pill {{ $contract->lifecycle_state === 'active' ? 'ok' : '' }}">{{ $contract->lifecycle_state }}</span></td>
                    <td>{{ $contract->effective_from }} @if ($contract->effective_to)→ {{ $contract->effective_to }} @endif</td>
                    <td>{{ $contract->signed_ref ? \Illuminate\Support\Str::limit($contract->signed_ref, 14) : '—' }}</td>
                    <td>
                        @if ($contract->lifecycle_state === 'draft')
                            <form method="POST" action="{{ route('hr.contract.sign', $contract->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <input name="signed_ref" type="text" placeholder="Signed evidence ref" required>
                                <button type="submit" class="btn small">Sign &amp; activate</button>
                            </form>
                        @endif
                        @if ($contract->lifecycle_state === 'active')
                            <form method="POST" action="{{ route('hr.contract.close', $contract->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <input type="date" name="effective_to" required>
                                <button type="submit" class="btn small secondary">Close</button>
                            </form>
                        @endif
                    </td>
                </tr>
            @endforeach
        </table>
    @endif
</div>

<div class="card">
    <h2>Versions (newest first)</h2>
    @if ($versions->isEmpty())
        <p class="empty">No contract versions prepared yet.</p>
    @else
        <table class="grid">
            <tr><th>Version</th><th>State</th><th>Scale</th><th>Effective</th><th>Approved by</th><th>Actions</th></tr>
            @foreach ($versions as $version)
                <tr>
                    <td>#{{ $version->version_no }}<br><span class="muted" style="font-size:12px">{{ \Illuminate\Support\Str::limit($version->id, 16) }}</span></td>
                    <td><span class="pill {{ in_array($version->lifecycle_state, ['approved', 'active'], true) ? 'ok' : ($version->lifecycle_state === 'draft' ? 'held' : '') }}">{{ $version->lifecycle_state }}</span></td>
                    <td>{{ $version->scale_id ? \Illuminate\Support\Str::limit($version->scale_id, 12) : '—' }}</td>
                    <td>{{ $version->effective_from }} @if ($version->effective_to)→ {{ $version->effective_to }} @endif</td>
                    <td>{{ $version->approved_by ? \Illuminate\Support\Str::limit($version->approved_by, 14) : '—' }}</td>
                    <td>
                        <details>
                            <summary class="btn small secondary" style="display:inline-block; cursor:pointer">Manage</summary>
                            @if ($version->lifecycle_state === 'draft')
                                <form method="POST" action="{{ route('hr.version.rule', $version->id) }}" style="margin-top:8px">
                                    @csrf
                                    <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                    <label>Method</label>
                                    <select name="method" required>
                                        <option value="fixed_monthly">Fixed monthly</option>
                                        <option value="session_rate">Per session</option>
                                        <option value="hourly_rate">Per hour</option>
                                        <option value="scale_rate">Per scale</option>
                                    </select>
                                    <label>Rate</label>
                                    <input name="rate" type="text" required>
                                    <div class="actions"><button type="submit" class="btn small">Add rule</button></div>
                                </form>
                            @endif
                            @if ($version->lifecycle_state === 'draft')
                                <form method="POST" action="{{ route('hr.version.submit', $version->id) }}" style="margin-top:8px">
                                    @csrf
                                    <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                    <button type="submit" class="btn small">Submit for approval</button>
                                </form>
                            @endif
                            @if ($version->lifecycle_state === 'submitted')
                                <form method="POST" action="{{ route('hr.version.approve', $version->id) }}" style="margin-top:8px">
                                    @csrf
                                    <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                    <button type="submit" class="btn small">Approve version</button>
                                </form>
                            @endif
                            @if ($version->lifecycle_state === 'draft')
                                <form method="POST" action="{{ route('hr.version.withdraw', $version->id) }}" style="margin-top:8px">
                                    @csrf
                                    <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                    <button type="submit" class="btn small secondary">Withdraw</button>
                                </form>
                            @endif
                        </details>
                    </td>
                </tr>
            @endforeach
        </table>
    @endif
</div>
@endsection
