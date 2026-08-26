@extends('layouts.app')

@section('title', 'Reporting & Dashboards')

@section('content')
<div class="card">
    <h1>Reporting &amp; Dashboards</h1>
    <p class="sub">Each metric resolves to a single authoritative source with deterministic period semantics. Runs are reproducible (hash-stamped). Dashboards pin existing metric definitions — they never hold a second truth.</p>
</div>

<div class="row">
    <div class="card" style="flex:1 1 320px">
        <h2>Run a report</h2>
        @if ($metrics->isEmpty())
            <p class="empty">No metrics defined yet. Define a metric in the reporting catalog first.</p>
        @else
            <form method="POST" action="{{ route('reporting.run') }}">
                @csrf
                <label>Metric</label>
                <select name="metric_key" required>
                    @foreach ($metrics as $metric)
                        <option value="{{ $metric->key }}">{{ $metric->name }} ({{ $metric->key }})</option>
                    @endforeach
                </select>
                <label>Period key</label>
                <input name="period_key" type="text" placeholder="e.g. 2026-09" required>
                <div class="row">
                    <div>
                        <label>Scope type</label>
                        <select name="scope_type" required>
                            <option value="all">All</option>
                            <option value="branch">Branch</option>
                            <option value="campus">Campus</option>
                            <option value="program">Program</option>
                        </select>
                    </div>
                    <div>
                        <label>Scope id (optional)</label>
                        <input name="scope_id" type="text">
                    </div>
                </div>
                <div class="actions"><button type="submit" class="btn">Run report</button></div>
            </form>
        @endif
    </div>

    <div class="card" style="flex:1 1 320px">
        <h2>Metric catalog</h2>
        @if ($metrics->isEmpty())
            <p class="empty">No metrics defined.</p>
        @else
            <table class="grid">
                <tr><th>Metric</th><th>Key</th><th>Version</th></tr>
                @foreach ($metrics as $metric)
                    <tr><td>{{ $metric->name }}</td><td><code>{{ $metric->key }}</code></td><td>v{{ $metric->current_version }}</td></tr>
                @endforeach
            </table>
        @endif
    </div>
</div>

<div class="card">
    <h2>Report runs (newest first)</h2>
    @if ($runs->isEmpty())
        <p class="empty">No report runs yet.</p>
    @else
        <table class="grid">
            <tr><th>Metric</th><th>Period</th><th>Scope</th><th>Result</th><th>Reproducibility hash</th></tr>
            @foreach ($runs as $run)
                <tr>
                    <td>{{ $run->metric_name ?? '—' }} <span class="muted">({{ $run->metric_key ?? '—' }})</span></td>
                    <td>{{ $run->period_key }}</td>
                    <td>{{ $run->scope_type }}@if ($run->scope_id) / {{ \Illuminate\Support\Str::limit($run->scope_id, 12) }} @endif</td>
                    <td>{{ $run->result }}</td>
                    <td class="muted" style="font-size:12px">{{ \Illuminate\Support\Str::limit($run->reproducibility_hash, 16) }}</td>
                </tr>
            @endforeach
        </table>
    @endif
</div>

<div class="card">
    <h2>Dashboards</h2>
    <form method="POST" action="{{ route('reporting.dashboard.create') }}">
        @csrf
        <div class="row">
            <div>
                <label>Name</label>
                <input name="name" type="text" required>
            </div>
            <div style="flex:0 0 auto">
                <button type="submit" class="btn">Create dashboard</button>
            </div>
        </div>
    </form>
    @if ($dashboards->isEmpty())
        <p class="empty">No dashboards created.</p>
    @else
        <table class="grid" style="margin-top:16px">
            <tr><th>Dashboard</th><th></th></tr>
            @foreach ($dashboards as $dashboard)
                <tr>
                    <td>{{ $dashboard->name }}</td>
                    <td>
                        <details>
                            <summary class="btn small secondary" style="display:inline-block; cursor:pointer">Pin a metric</summary>
                            @if ($metrics->isEmpty())
                                <p class="empty">Define a metric first.</p>
                            @else
                                <form method="POST" action="{{ route('reporting.dashboard.pin', $dashboard->id) }}" style="margin-top:8px">
                                    @csrf
                                    <label>Metric</label>
                                    <select name="metric_key" required>
                                        @foreach ($metrics as $metric)
                                            <option value="{{ $metric->key }}">{{ $metric->name }}</option>
                                        @endforeach
                                    </select>
                                    <label>Period key</label>
                                    <input name="period_key" type="text" required>
                                    <label>Scope type</label>
                                    <select name="scope_type" required>
                                        <option value="all">All</option>
                                        <option value="branch">Branch</option>
                                    </select>
                                    <div class="actions"><button type="submit" class="btn small">Pin</button></div>
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
