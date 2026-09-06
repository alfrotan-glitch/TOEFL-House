@extends('layouts.app')

@section('title', 'Audit & Governance')

@section('content')
<div class="card">
    <h1>Audit &amp; Governance</h1>
    <p class="sub">The immutable, append-only audit trail. Every state-changing operation is recorded with the actor, target, before/after state, and a correlation id. This view is read-only.</p>
</div>

<div class="card">
    <form method="GET" action="{{ route('audit.index') }}" class="toolbar">
        <div>
            <label>Operation</label>
            <select name="operation">
                <option value="">All operations</option>
                @foreach ($operations as $op)
                    <option value="{{ $op }}" @selected($op === $operation)>{{ $op }}</option>
                @endforeach
            </select>
        </div>
        <div>
            <label>Actor (person id)</label>
            <input type="text" name="actor_id" value="{{ $actorId }}" placeholder="e.g. gm-1">
        </div>
        <div>
            <label>Target type</label>
            <input type="text" name="target_type" value="{{ $targetType }}" placeholder="e.g. payroll_calculation">
        </div>
        <div style="flex:0 0 auto">
            <button type="submit" class="btn">Filter</button>
        </div>
    </form>
</div>

<div class="card">
    <h2>Recent events (newest first)</h2>
    @if ($events->isEmpty())
        <p class="empty">No audit events match the current filter.</p>
    @else
        <table class="grid">
            <tr><th>When</th><th>Operation</th><th>Actor</th><th>Target</th><th>Correlation</th></tr>
            @foreach ($events as $event)
                <tr>
                    <td class="muted">{{ optional($event->occurred_at)->format('Y-m-d H:i:s') ?? '—' }}</td>
                    <td><code>{{ $event->operation }}</code></td>
                    <td>{{ $event->actor_id }}</td>
                    <td>{{ $event->target_type }}<br><span class="muted" style="font-size:12px">{{ \Illuminate\Support\Str::limit($event->target_id, 18) }}</span></td>
                    <td class="muted" style="font-size:12px">{{ \Illuminate\Support\Str::limit($event->correlation_id, 12) }}</td>
                </tr>
            @endforeach
        </table>
    @endif
</div>
@endsection
