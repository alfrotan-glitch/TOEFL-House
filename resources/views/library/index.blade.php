@extends('layouts.app')

@section('title', 'Library & Resources')

@section('content')
<div class="card">
    <h1>Library &amp; Resources</h1>
    <p class="sub">Assets with custody history, book copies, circulation (one open issuance per copy), and facilities work orders. Disposal is staged: a requester session requests, two distinct approver sessions each sign, and the requesting session executes. Losses and completions require evidence.</p>
</div>

<div class="row">
    <div class="card" style="flex:1 1 340px">
        <h2>Register an asset</h2>
        <form method="POST" action="{{ route('library.asset.register') }}">
            @csrf
            <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
            <label>Code</label>
            <input type="text" name="code" required maxlength="64">
            <label>Name</label>
            <input type="text" name="name" required maxlength="255">
            <label>Category</label>
            <input type="text" name="category" required maxlength="64">
            <label>Location</label>
            <input type="text" name="location" required maxlength="255">
            <label>Acquired on</label>
            <input type="date" name="acquired_on" required>
            <div class="actions"><button type="submit" class="btn">Register asset</button></div>
        </form>
    </div>

    <div class="card" style="flex:1 1 340px">
        <h2>Request facilities work</h2>
        <form method="POST" action="{{ route('library.work.request') }}">
            @csrf
            <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
            <label>Facility</label>
            <input type="text" name="facility_note" required maxlength="255" placeholder="Campus A / Room 4">
            <label>Description</label>
            <input type="text" name="description" required maxlength="1000">
            <div class="actions"><button type="submit" class="btn">Request work</button></div>
        </form>
    </div>
</div>

<div class="card">
    <h2>Assets</h2>
    @if ($assets->isEmpty())
        <p class="empty">No assets recorded.</p>
    @else
        <table class="grid">
            <tr><th>Code</th><th>State</th><th>Custody</th><th></th></tr>
            @foreach ($assets as $asset)
                @php($openCustody = $openCustodies->firstWhere('asset_id', $asset->id))
                <tr>
                    <td>{{ $asset->code }}</td>
                    <td><span class="pill {{ $asset->lifecycle_state === 'in_service' ? 'ok' : '' }}">{{ $asset->lifecycle_state }}</span></td>
                    <td>
                        @if ($openCustody)
                            {{ \Illuminate\Support\Str::limit($openCustody->custodian_person_id, 18) }}
                        @else
                            <span class="muted">none</span>
                        @endif
                    </td>
                    <td>
                        @if ($asset->lifecycle_state === 'in_service')
                            <details>
                                <summary class="btn small secondary" style="display:inline-block; cursor:pointer">Assign custody</summary>
                                <form method="POST" action="{{ route('library.custody.assign', $asset->id) }}" style="margin-top:8px">
                                    @csrf
                                    <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                    <label>Custodian</label>
                                    <select name="custodian_id" required>
                                        @foreach ($borrowers as $borrower)
                                            <option value="{{ $borrower->id }}">{{ $borrower->legal_name }}</option>
                                        @endforeach
                                    </select>
                                    <label>Assigned on</label>
                                    <input type="date" name="assigned_on" required>
                                    <div class="actions"><button type="submit" class="btn small">Assign</button></div>
                                </form>
                            </details>
                            @if ($openCustody)
                                <form method="POST" action="{{ route('library.custody.release', $asset->id) }}" style="display:inline">
                                    @csrf
                                    <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                    <input type="date" name="released_on" required>
                                    <button type="submit" class="btn small secondary">Release custody</button>
                                </form>
                            @endif
                            <details>
                                <summary class="btn small" style="display:inline-block; cursor:pointer">Request disposal</summary>
                                <form method="POST" action="{{ route('library.disposal.request', $asset->id) }}" style="margin-top:8px">
                                    @csrf
                                    <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                    <label>Method</label>
                                    <select name="method" required>
                                        <option value="sale">sale</option>
                                        <option value="scrap">scrap</option>
                                        <option value="donation">donation</option>
                                    </select>
                                    <label>Reason</label>
                                    <input type="text" name="reason" required maxlength="255">
                                    <div class="actions"><button type="submit" class="btn small">Request disposal</button></div>
                                </form>
                            </details>
                        @endif
                    </td>
                </tr>
            @endforeach
        </table>
    @endif
</div>

<div class="card">
    <h2>Disposal requests (staged)</h2>
    @if ($disposalRequests->isEmpty())
        <p class="empty">No disposal requests recorded.</p>
    @else
        <table class="grid">
            <tr><th>Asset</th><th>Method</th><th>Reason</th><th>State</th><th>Approver 1</th><th>Approver 2</th><th></th></tr>
            @foreach ($disposalRequests as $disposalRequest)
                @php($disposalAsset = $assets->firstWhere('id', $disposalRequest->asset_id))
                <tr>
                    <td>{{ $disposalAsset?->code ?? \Illuminate\Support\Str::limit($disposalRequest->asset_id, 12) }}</td>
                    <td>{{ $disposalRequest->method }}</td>
                    <td class="muted">{{ $disposalRequest->reason }}</td>
                    <td><span class="pill {{ $disposalRequest->lifecycle_state === 'completed' ? 'ok' : '' }}">{{ $disposalRequest->lifecycle_state }}</span></td>
                    <td class="muted">{{ $disposalRequest->approver_one_id ? \Illuminate\Support\Str::limit($disposalRequest->approver_one_id, 14) : '—' }}</td>
                    <td class="muted">{{ $disposalRequest->approver_two_id ? \Illuminate\Support\Str::limit($disposalRequest->approver_two_id, 14) : '—' }}</td>
                    <td>
                        @if ($disposalRequest->lifecycle_state === 'requested')
                            <form method="POST" action="{{ route('library.disposal.approve', $disposalRequest->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <button type="submit" class="btn small">Sign approval</button>
                            </form>
                        @endif
                        @if ($disposalRequest->lifecycle_state === 'approved')
                            <form method="POST" action="{{ route('library.disposal.execute', $disposalRequest->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <input type="date" name="disposed_on" required>
                                <button type="submit" class="btn small">Execute disposal</button>
                            </form>
                        @endif
                    </td>
                </tr>
            @endforeach
        </table>
    @endif
</div>

<div class="card">
    <h2>Disposal records (immutable)</h2>
    @if ($disposals->isEmpty())
        <p class="empty">No disposals executed.</p>
    @else
        <table class="grid">
            <tr><th>Asset</th><th>Method</th><th>Reason</th><th>Disposed on</th><th>Requested by</th><th>Approvers</th></tr>
            @foreach ($disposals as $disposal)
                @php($disposalAsset = $assets->firstWhere('id', $disposal->asset_id))
                <tr>
                    <td>{{ $disposalAsset?->code ?? \Illuminate\Support\Str::limit($disposal->asset_id, 12) }}</td>
                    <td>{{ $disposal->method }}</td>
                    <td class="muted">{{ $disposal->reason }}</td>
                    <td>{{ $disposal->disposed_on }}</td>
                    <td class="muted">{{ \Illuminate\Support\Str::limit($disposal->requested_by, 14) }}</td>
                    <td class="muted">{{ \Illuminate\Support\Str::limit($disposal->approver_one, 14) }} + {{ \Illuminate\Support\Str::limit($disposal->approver_two, 14) }}</td>
                </tr>
            @endforeach
        </table>
    @endif
</div>

<div class="row">
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
                                    <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
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
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <input type="date" name="returned_on" required>
                                <button type="submit" class="btn small">Return</button>
                            </form>
                            <form method="POST" action="{{ route('library.loss', $issuance->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
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
            <tr><th>Facility</th><th>Description</th><th>State</th><th>Evidence</th><th></th></tr>
            @foreach ($workOrders as $workOrder)
                <tr>
                    <td>{{ $workOrder->facility_note }}</td>
                    <td class="muted">{{ \Illuminate\Support\Str::limit($workOrder->description, 60) }}</td>
                    <td><span class="pill {{ $workOrder->lifecycle_state === 'completed' ? 'ok' : ($workOrder->lifecycle_state === 'cancelled' ? 'held' : '') }}">{{ $workOrder->lifecycle_state }}</span></td>
                    <td class="muted">{{ $workOrder->evidence_ref }}</td>
                    <td>
                        @if ($workOrder->lifecycle_state === 'requested')
                            <form method="POST" action="{{ route('library.work.approve', $workOrder->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <button type="submit" class="btn small">Approve</button>
                            </form>
                            <form method="POST" action="{{ route('library.work.cancel', $workOrder->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <button type="submit" class="btn small secondary">Cancel</button>
                            </form>
                        @elseif ($workOrder->lifecycle_state === 'approved')
                            <form method="POST" action="{{ route('library.work.start', $workOrder->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <button type="submit" class="btn small">Start</button>
                            </form>
                            <form method="POST" action="{{ route('library.work.cancel', $workOrder->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <button type="submit" class="btn small secondary">Cancel</button>
                            </form>
                        @elseif ($workOrder->lifecycle_state === 'in_progress')
                            <form method="POST" action="{{ route('library.work.complete', $workOrder->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <input name="evidence_ref" type="text" placeholder="work evidence ref" required>
                                <button type="submit" class="btn small">Complete</button>
                            </form>
                            <form method="POST" action="{{ route('library.work.cancel', $workOrder->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <button type="submit" class="btn small secondary">Cancel</button>
                            </form>
                        @endif
                    </td>
                </tr>
            @endforeach
        </table>
    @endif
</div>
@endsection
