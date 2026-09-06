@extends('layouts.app')

@section('title', 'Identity & Access')

@section('content')
<div class="card">
    <h1>Identity &amp; Access</h1>
    <p class="sub">Intake people, verify them, issue employee accounts, and set credentials. Authority for these actions is resolved server-side from your access model.</p>
</div>

<div class="card">
    <h2>Register a new person</h2>
    <p class="sub">Opens an <strong>unverified</strong> person record — the starting point for an admission applicant, a teacher, or any employee. Verification is a separate, evidenced step below.</p>
    <form method="POST" action="{{ route('identity.person.register') }}">
        @csrf
        <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
        <div class="row">
            <div>
                <label>Legal name</label>
                <input name="legal_name" type="text" maxlength="160" required>
            </div>
            <div>
                <label>Date of birth</label>
                <input name="date_of_birth" type="date" required>
            </div>
        </div>
        <div class="actions"><button type="submit" class="btn">Register person</button></div>
    </form>
</div>

<div class="row">
    <div class="card" style="flex:1 1 320px">
        <h2>People</h2>
        @if ($people->isEmpty()) <p class="empty">No people recorded.</p> @else
        <table class="grid">
            <tr><th>Name</th><th>Verification</th><th></th></tr>
            @foreach ($people as $person)
                <tr>
                    <td>{{ $person->legal_name }}<br><span class="muted" style="font-size:12px">{{ \Illuminate\Support\Str::limit($person->id, 14) }}</span></td>
                    <td><span class="pill {{ $person->verification_state === 'verified' ? 'ok' : '' }}">{{ $person->verification_state }}</span></td>
                    <td>
                        @if ($person->verification_state !== 'verified')
                            <details>
                                <summary class="btn small secondary" style="display:inline-block; cursor:pointer">Verify</summary>
                                <form method="POST" action="{{ route('identity.verify', $person->id) }}" style="margin-top:8px">
                                    @csrf
                                    <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                    <label>Identity key</label>
                                    <input name="identity_key" type="text" required>
                                    <label>Evidence reference</label>
                                    <input name="evidence_ref" type="text" required>
                                    <div class="actions"><button type="submit" class="btn small">Verify person</button></div>
                                </form>
                            </details>
                        @else
                            <span class="muted">—</span>
                        @endif
                    </td>
                </tr>
            @endforeach
        </table>
        @endif
    </div>

    <div class="card" style="flex:1 1 320px">
        <h2>User accounts</h2>
        @if ($accounts->isEmpty()) <p class="empty">No user accounts issued.</p> @else
        <table class="grid">
            <tr><th>Username</th><th>State</th><th>Has password</th><th></th></tr>
            @foreach ($accounts as $account)
                <tr>
                    <td>{{ $account->username }}</td>
                    <td><span class="pill {{ $account->account_state === 'active' ? 'ok' : '' }}">{{ $account->account_state }}</span></td>
                    <td>{{ $account->password_hash ? 'yes' : 'no' }}</td>
                    <td>
                        @if ($account->isActive())
                            <details>
                                <summary class="btn small secondary" style="display:inline-block; cursor:pointer">Set password</summary>
                                <form method="POST" action="{{ route('identity.password', $account->id) }}" style="margin-top:8px">
                                    @csrf
                                    <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                    <label>New password</label>
                                    <input name="password" type="password" minlength="10" required>
                                    <div class="actions"><button type="submit" class="btn small">Set credential</button></div>
                                </form>
                            </details>
                            <details>
                                <summary class="btn small secondary" style="display:inline-block; cursor:pointer">Deactivate</summary>
                                <form method="POST" action="{{ route('identity.deactivate', $account->id) }}" style="margin-top:8px">
                                    @csrf
                                    <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                    <label>Reason</label>
                                    <input name="reason" type="text" required>
                                    <div class="actions"><button type="submit" class="btn small">Deactivate account</button></div>
                                </form>
                            </details>
                        @endif
                    </td>
                </tr>
            @endforeach
        </table>
        @endif
    </div>
</div>

<div class="card">
    <h2>Issue a user account</h2>
    <form method="POST" action="{{ route('identity.link') }}">
        @csrf
        <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
        <div class="row">
            <div>
                <label>Verified person</label>
                <select name="person_id" required>
                    <option value="">Select a person…</option>
                    @foreach ($people as $person)
                        <option value="{{ $person->id }}" @selected(false)>{{ $person->legal_name }} ({{ $person->verification_state }})</option>
                    @endforeach
                </select>
            </div>
            <div>
                <label>Username</label>
                <input name="username" type="text" required>
            </div>
        </div>
        <div class="actions"><button type="submit" class="btn">Issue account</button></div>
    </form>
</div>
@endsection
