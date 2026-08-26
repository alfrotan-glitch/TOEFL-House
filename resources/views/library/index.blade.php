@extends('layouts.app')

@section('title', 'Library & Resources')

@section('content')
<div class="card">
    <h1>Library &amp; Resources</h1>
    <p class="sub">Assets, book copies, circulation (one open issuance per copy), and facilities work orders. Losses require evidence and are recorded against the issuance.</p>
</div>

<div class="row">
    <div class="card" style="flex:1 1 320px">
        <h2>Assets</h2>
        @if ($assets->isEmpty())
            <p class="empty">No assets recorded.</p>
        @else
            <table class="grid">
                <tr><th>Code</th><th>State</th></tr>
                @foreach ($assets as $asset)
                    <tr><td>{{ $asset->code }}</td><td><span class="pill {{ $asset->lifecycle_state === 'active' ? 'ok' : '' }}">{{ $asset->lifecycle_state }}</span></td></tr>
                @endforeach
            </table>
        @endif
    </div>

    <div class="card" style="flex:1 1 320px">
        <h2>Book copies</h2>
        @if ($copies->isEmpty())
            <p class="empty">No book copies recorded.</p>
        @else
            <table class="grid">
                <tr><th>Code</th><th>Title</th><th></th></tr>
                @foreach ($copies as $copy)
                    <tr>
                        <td>{{ $copy->code }}</td>
                        <td>{{ $copy->title }}</td>
                        <td>
                            <details>
                                <summary class="btn small secondary" style="display:inline-block; cursor:pointer">Issue</summary>
                                <form method="POST" action="{{ route('library.issue', $copy->id) }}" style="margin-top:8px">
                                    @csrf
                                    <label>Borrower</label>
                                    <select name="borrower_id" required>
                                        @foreach ($borrowers as $borrower)
                                            <option value="{{ $borrower->id }}">{{ $borrower->legal_name }}</option>
                                        @endforeach
                                    </select>
                                    <label>Issued on</label>
                                    <input type="date" name="issued_on" required>
                                    <label>Due on</label>
                                    <input type="date" name="due_on" required>
                                    <div class="actions"><button type="submit" class="btn small">Issue</button></div>
                                </form>
                            </details>
                        </td>
                    </tr>
                @endforeach
            </table>
        @endif
    </div>
</div>

<div class="card">
    <h2>Circulation (newest first)</h2>
    @if ($issuances->isEmpty())
        <p class="empty">No issuances recorded.</p>
    @else
        <table class="grid">
            <tr><th>Copy</th><th>Borrower</th><th>Issued</th><th>Due</th><th>State</th><th></th></tr>
            @foreach ($issuances as $issuance)
                <tr>
                    <td>{{ \Illuminate\Support\Str::limit($issuance->copy_id, 16) }}</td>
                    <td>{{ \Illuminate\Support\Str::limit($issuance->borrower_person_id, 16) }}</td>
                    <td>{{ $issuance->issued_on }}</td>
                    <td>{{ $issuance->due_on }}</td>
                    <td><span class="pill {{ $issuance->lifecycle_state === 'returned' ? 'ok' : ($issuance->lifecycle_state === 'lost' ? 'held' : '') }}">{{ $issuance->lifecycle_state }}</span></td>
                    <td>
                        @if ($issuance->lifecycle_state === 'issued')
                            <form method="POST" action="{{ route('library.return', $issuance->id) }}" style="display:inline">
                                @csrf
                                <input type="date" name="returned_on" required>
                                <button type="submit" class="btn small">Return</button>
                            </form>
                            <form method="POST" action="{{ route('library.loss', $issuance->id) }}" style="display:inline">
                                @csrf
                                <input name="loss_evidence" type="text" placeholder="loss evidence ref" required>
                                <button type="submit" class="btn small secondary">Report loss</button>
                            </form>
                        @endif
                    </td>
                </tr>
            @endforeach
        </table>
    @endif
</div>

<div class="card">
    <h2>Facilities work orders</h2>
    @if ($workOrders->isEmpty())
        <p class="empty">No work orders recorded.</p>
    @else
        <table class="grid">
            <tr><th>Work order</th><th>State</th><th>Evidence</th></tr>
            @foreach ($workOrders as $workOrder)
                <tr>
                    <td>{{ \Illuminate\Support\Str::limit($workOrder->id, 18) }}</td>
                    <td><span class="pill">{{ $workOrder->lifecycle_state }}</span></td>
                    <td class="muted">{{ $workOrder->evidence_ref }}</td>
                </tr>
            @endforeach
        </table>
    @endif
</div>
@endsection
