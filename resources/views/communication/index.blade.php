@extends('layouts.app')

@section('title', 'Communication')

@section('content')
<div class="card">
    <h1>Communication</h1>
    <p class="sub">Outbound messages are queued post-commit only under an active consent for the subject and purpose, on the purpose's own channel. Delivery results (sent/failed) close the message with the provider's reference; history is retained.</p>
</div>

<div class="card">
    <h2>Queue a message</h2>
    <form method="POST" action="{{ route('communication.message.queue') }}">
        @csrf
        <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
        <div class="row">
            <div>
                <label>Subject</label>
                <select name="subject_person_id" required>
                    <option value="">Select a person…</option>
                    @foreach ($people as $person)
                        <option value="{{ $person->id }}">{{ $person->legal_name }}</option>
                    @endforeach
                </select>
            </div>
            <div>
                <label>Consent purpose</label>
                <select name="purpose_id" required>
                    <option value="">Select a purpose…</option>
                    @foreach ($purposes as $purpose)
                        <option value="{{ $purpose->id }}">{{ $purpose->name }} ({{ $purpose->channel }})</option>
                    @endforeach
                </select>
            </div>
        </div>
        <div class="row">
            <div>
                <label>Channel (must match the purpose's channel)</label>
                <input type="text" name="channel" required maxlength="64" placeholder="email">
            </div>
            <div>
                <label>Content reference</label>
                <input type="text" name="content_ref" required maxlength="255" placeholder="template/progress-update-3">
            </div>
        </div>
        <div class="actions"><button type="submit" class="btn">Queue message</button></div>
    </form>
</div>

<div class="card">
    <h2>Messages (newest first)</h2>
    @if ($messages->isEmpty())
        <p class="empty">No messages queued.</p>
    @else
        <table class="grid">
            <tr><th>Subject</th><th>Channel</th><th>Content</th><th>State</th><th>Delivery ref</th><th></th></tr>
            @foreach ($messages as $message)
                <tr>
                    <td class="muted">{{ \Illuminate\Support\Str::limit($message->subject_person_id, 16) }}</td>
                    <td>{{ $message->channel }}</td>
                    <td class="muted">{{ \Illuminate\Support\Str::limit($message->content_ref, 40) }}</td>
                    <td><span class="pill {{ $message->lifecycle_state === 'sent' ? 'ok' : ($message->lifecycle_state === 'failed' ? 'held' : '') }}">{{ $message->lifecycle_state }}</span></td>
                    <td class="muted">{{ $message->delivery_ref }}</td>
                    <td>
                        @if ($message->lifecycle_state === 'queued')
                            <form method="POST" action="{{ route('communication.message.delivered', $message->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <input name="delivery_ref" type="text" placeholder="provider delivery ref" required maxlength="255">
                                <button type="submit" class="btn small">Mark delivered</button>
                            </form>
                            <form method="POST" action="{{ route('communication.message.failed', $message->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <input name="delivery_ref" type="text" placeholder="provider failure ref" required maxlength="255">
                                <button type="submit" class="btn small secondary">Mark failed</button>
                            </form>
                        @endif
                    </td>
                </tr>
            @endforeach
        </table>
    @endif
</div>
@endsection
