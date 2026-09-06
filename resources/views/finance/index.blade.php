@extends('layouts.app')

@section('title', 'Finance')

@section('content')
<div class="card">
    <h1>Finance</h1>
    <p class="sub">The money surface: obligations, payments, refunds, discounts, and funding. Every movement is balanced, source-linked, idempotent, and reconciliation-ready. Amounts are produced by commands — never edited by hand.</p>
</div>

<div class="card">
    <h2>Financial periods</h2>
    <p class="sub">Payments, obligations and refunds post only to an open period; closure is terminal (an overlapping open payroll period blocks it).</p>
    <form method="POST" action="{{ route('finance.period.open') }}">
        @csrf
        <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
        <div class="row">
            <div>
                <label>Period key</label>
                <input name="period_key" type="text" placeholder="e.g. SY2026-1" required>
            </div>
            <div>
                <label>From</label>
                <input type="date" name="date_from" required>
            </div>
            <div>
                <label>To</label>
                <input type="date" name="date_to" required>
            </div>
        </div>
        <div class="actions"><button type="submit" class="btn">Open period</button></div>
    </form>
    @if ($periods->isEmpty())
        <p class="empty">No financial periods.</p>
    @else
        <table class="grid" style="margin-top:8px">
            <tr><th>Period</th><th>Window</th><th>State</th><th></th></tr>
            @foreach ($periods as $period)
                <tr>
                    <td>{{ $period->period_key }}</td>
                    <td>{{ $period->date_from }} → {{ $period->date_to }}</td>
                    <td><span class="pill {{ $period->lifecycle_state === 'open' ? 'ok' : '' }}">{{ $period->lifecycle_state }}</span></td>
                    <td>
                        @if ($period->lifecycle_state === 'open')
                            <form method="POST" action="{{ route('finance.period.close', $period->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <button type="submit" class="btn small">Close</button>
                            </form>
                        @endif
                    </td>
                </tr>
            @endforeach
        </table>
    @endif
</div>

<div class="card">
    <h2>Record a payment</h2>
    <form method="POST" action="{{ route('finance.payment') }}">
        @csrf
        <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
        <div class="row">
            <div>
                <label>Financial period</label>
                <select name="period_id" required>
                    <option value="">Select a period…</option>
                    @foreach ($periods as $period)
                        <option value="{{ $period->id }}">{{ $period->period_key }} ({{ $period->date_from }} → {{ $period->date_to }})</option>
                    @endforeach
                </select>
            </div>
            <div>
                <label>Student</label>
                <select name="student_id" required>
                    <option value="">Select a student…</option>
                    @foreach ($students as $student)
                        <option value="{{ $student->id }}">{{ $student->student_code }}</option>
                    @endforeach
                </select>
            </div>
            <div>
                <label>Amount</label>
                <input name="amount" type="text" inputmode="decimal" required>
            </div>
            <div>
                <label>Method</label>
                <input name="method" type="text" placeholder="e.g. cash, bank" required>
            </div>
            <div>
                <label>Payer reference</label>
                <input name="payer_ref" type="text" required>
            </div>
            <div>
                <label>Received on</label>
                <input type="date" name="received_on" required>
            </div>
        </div>
        <div class="actions"><button type="submit" class="btn">Record payment</button></div>
    </form>
</div>

<div class="card">
    <h2>Post an obligation</h2>
    <p class="sub">Obligations post only to an open financial period; the line total becomes the obligation amount.</p>
    <form method="POST" action="{{ route('finance.obligation.post') }}">
        @csrf
        <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
        <div class="row">
            <div>
                <label>Financial period</label>
                <select name="period_id" required>
                    <option value="">Select an open period…</option>
                    @foreach ($periods as $period)
                        <option value="{{ $period->id }}">{{ $period->period_key }} ({{ $period->lifecycle_state }})</option>
                    @endforeach
                </select>
            </div>
            <div>
                <label>Student</label>
                <select name="student_id" required>
                    <option value="">Select a student…</option>
                    @foreach ($students as $student)
                        <option value="{{ $student->id }}">{{ $student->student_code }}</option>
                    @endforeach
                </select>
            </div>
            <div>
                <label>Source</label>
                <input name="source" type="text" placeholder="e.g. tuition" required>
            </div>
            <div>
                <label>Line category</label>
                <input name="category" type="text" required>
            </div>
            <div>
                <label>Line amount</label>
                <input name="amount" type="text" inputmode="decimal" required>
            </div>
            <div>
                <label>Line source reference</label>
                <input name="source_ref" type="text" required>
            </div>
        </div>
        <div class="fields">
            <input name="reason" type="text" placeholder="Reason" required>
        </div>
        <div class="actions"><button type="submit" class="btn">Post obligation</button></div>
    </form>
</div>

<div class="row">
    <div class="card" style="flex:1 1 320px">
        <h2>Obligations (newest first)</h2>
        @if ($obligations->isEmpty())
            <p class="empty">No obligations posted.</p>
        @else
            <table class="grid">
                <tr><th>Student</th><th>Source</th><th></th></tr>
                @foreach ($obligations as $obligation)
                    <tr>
                        <td>{{ \Illuminate\Support\Str::limit($obligation->student_id, 16) }}</td>
                        <td>{{ \Illuminate\Support\Str::limit($obligation->source, 16) }}</td>
                        <td>
                            <details>
                                <summary class="btn small secondary" style="display:inline-block; cursor:pointer">Allocate</summary>
                                <form method="POST" action="{{ route('finance.allocate', $obligation->id) }}" style="margin-top:8px">
                                    @csrf
                                    <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                    <label>Payment</label>
                                    <select name="payment_id" required>
                                        @foreach ($payments as $payment)
                                            <option value="{{ $payment->id }}">{{ \Illuminate\Support\Str::limit($payment->id, 14) }} ({{ $payment->amount }})</option>
                                        @endforeach
                                    </select>
                                    <label>Amount</label>
                                    <input name="amount" type="text" inputmode="decimal" required>
                                    <div class="actions"><button type="submit" class="btn small">Allocate</button></div>
                                </form>
                            </details>
                        </td>
                    </tr>
                @endforeach
            </table>
        @endif
    </div>

    <div class="card" style="flex:1 1 320px">
        <h2>Payments (newest first)</h2>
        @if ($payments->isEmpty())
            <p class="empty">No payments recorded.</p>
        @else
            <table class="grid">
                <tr><th>Student</th><th>Reference</th><th>Amount</th><th>Method</th><th>Received</th><th></th></tr>
                @foreach ($payments as $payment)
                    <tr>
                        <td>{{ \Illuminate\Support\Str::limit($payment->student_id, 16) }}</td>
                        <td><code>{{ $payment->payer_ref }}</code></td>
                        <td>{{ $payment->amount }}</td>
                        <td>{{ $payment->method }}</td>
                        <td>{{ $payment->received_on }}</td>
                        <td>
                            <details>
                                <summary class="btn small secondary" style="display:inline-block; cursor:pointer">Refund</summary>
                                <form method="POST" action="{{ route('finance.refund', $payment->id) }}" style="margin-top:8px">
                                    @csrf
                                    <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                    <label>Period</label>
                                    <select name="period_id" required>
                                        @foreach ($periods as $period)
                                            <option value="{{ $period->id }}">{{ $period->period_key }}</option>
                                        @endforeach
                                    </select>
                                    <label>Amount</label>
                                    <input name="amount" type="text" inputmode="decimal" required>
                                    <label>Reason</label>
                                    <input name="reason" type="text" required>
                                    <p class="muted" style="font-size:12px">You are proposing this refund. A different employee holding the refund-approval authority records it from their own session.</p>
                                    <div class="actions"><button type="submit" class="btn small">Propose refund</button></div>
                                </form>
                            </details>
                        </td>
                    </tr>
                @endforeach
            </table>
        @endif
    </div>
</div>

<div class="row">
    <div class="card" style="flex:1 1 320px">
        <h2>Proposed refunds (awaiting approval)</h2>
        @if ($proposedRefunds->isEmpty())
            <p class="empty">No refunds awaiting approval.</p>
        @else
            <table class="grid">
                <tr><th>Payment</th><th>Amount</th><th>Reason</th><th></th></tr>
                @foreach ($proposedRefunds as $refund)
                    <tr>
                        <td>{{ \Illuminate\Support\Str::limit($refund->payment_id, 16) }}</td>
                        <td>{{ $refund->amount }}</td>
                        <td class="muted">{{ \Illuminate\Support\Str::limit($refund->reason, 24) }}</td>
                        <td>
                            <form method="POST" action="{{ route('finance.refund.approve', $refund->id) }}">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <button type="submit" class="btn small" title="Records this refund under your authority (must differ from the requester)">Approve</button>
                            </form>
                        </td>
                    </tr>
                @endforeach
            </table>
        @endif
        <h2 style="margin-top:16px">Refunds (recorded)</h2>
        @if ($refunds->isEmpty())
            <p class="empty">No refunds recorded.</p>
        @else
            <table class="grid">
                <tr><th>Payment</th><th>Amount</th><th>Reason</th></tr>
                @foreach ($refunds as $refund)
                    <tr>
                        <td>{{ \Illuminate\Support\Str::limit($refund->payment_id, 16) }}</td>
                        <td>{{ $refund->amount }}</td>
                        <td class="muted">{{ \Illuminate\Support\Str::limit($refund->reason, 24) }}</td>
                    </tr>
                @endforeach
            </table>
        @endif
    </div>

    <div class="card" style="flex:1 1 320px">
        <h2>Chart of accounts</h2>
        <p class="sub">Unique codes, five canonical types, immutable once defined — a changed definition is a new account.</p>
        <form method="POST" action="{{ route('finance.account.define') }}">
            @csrf
            <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
            <div class="row">
                <div>
                    <label>Code</label>
                    <input name="code" type="text" required>
                </div>
                <div>
                    <label>Name</label>
                    <input name="name" type="text" required>
                </div>
                <div>
                    <label>Type</label>
                    <select name="type" required>
                        <option value="asset">Asset</option>
                        <option value="liability">Liability</option>
                        <option value="equity">Equity</option>
                        <option value="revenue">Revenue</option>
                        <option value="expense">Expense</option>
                    </select>
                </div>
            </div>
            <div class="actions"><button type="submit" class="btn">Define account</button></div>
        </form>
        @if ($accounts->isEmpty())
            <p class="empty">No accounts defined.</p>
        @else
            <table class="grid" style="margin-top:8px">
                <tr><th>Code</th><th>Name</th><th>Type</th></tr>
                @foreach ($accounts as $account)
                    <tr>
                        <td><code>{{ $account->code }}</code></td>
                        <td>{{ $account->name }}</td>
                        <td><span class="pill">{{ $account->type }}</span></td>
                    </tr>
                @endforeach
            </table>
        @endif
    </div>
</div>

<div class="card">
    <h2>Journals</h2>
    <p class="sub">Balanced accounting records: debits must equal credits exactly, journals post only to an open period, and they are immutable once posted — corrections append a reversal linked to the original.</p>
    <form method="POST" action="{{ route('finance.journal.post') }}">
        @csrf
        <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
        <div class="row">
            <div>
                <label>Open financial period</label>
                <select name="period_id" required>
                    <option value="">Select an open period…</option>
                    @foreach ($periods as $period)
                        @if ($period->lifecycle_state === 'open')
                            <option value="{{ $period->id }}">{{ $period->period_key }}</option>
                        @endif
                    @endforeach
                </select>
            </div>
            <div>
                <label>Source</label>
                <select name="source_type" required>
                    <option value="other">Other</option>
                    <option value="obligation">Obligation</option>
                    <option value="payroll_result">Payroll result</option>
                    <option value="journal">Journal (reversal)</option>
                </select>
            </div>
            <div>
                <label>Source reference</label>
                <input name="source_id" type="text" placeholder="optional">
            </div>
        </div>
        <div class="fields">
            <input name="reason" type="text" placeholder="Reason" required>
        </div>
        <table class="grid" style="margin-top:8px">
            <tr><th>Account</th><th>Direction</th><th>Amount</th></tr>
            @for ($i = 0; $i < 4; $i++)
                <tr>
                    <td>
                        <select name="lines[{{ $i }}][account_id]">
                            <option value="">—</option>
                            @foreach ($accounts as $account)
                                <option value="{{ $account->id }}">{{ $account->code }} ({{ $account->name }})</option>
                            @endforeach
                        </select>
                    </td>
                    <td>
                        <select name="lines[{{ $i }}][direction]">
                            <option value="">—</option>
                            <option value="debit">Debit</option>
                            <option value="credit">Credit</option>
                        </select>
                    </td>
                    <td>
                        <input name="lines[{{ $i }}][amount]" type="text" inputmode="decimal" placeholder="0.00">
                    </td>
                </tr>
            @endfor
        </table>
        <div class="actions"><button type="submit" class="btn">Post journal (must balance)</button></div>
    </form>
    @if ($journals->isEmpty())
        <p class="empty">No journals posted.</p>
    @else
        <h2 style="margin-top:16px">Journals (newest first)</h2>
        <table class="grid">
            <tr><th>Period</th><th>Source</th><th>Reason</th><th>Posted by</th><th></th></tr>
            @foreach ($journals as $journal)
                <tr>
                    <td>{{ \Illuminate\Support\Str::limit($journal->period_id, 16) }}</td>
                    <td>{{ $journal->source_type }}{{ $journal->source_id !== null ? ': '.\Illuminate\Support\Str::limit($journal->source_id, 12) : '' }}</td>
                    <td class="muted">{{ \Illuminate\Support\Str::limit($journal->reason, 30) }}</td>
                    <td>{{ \Illuminate\Support\Str::limit($journal->posted_by, 16) }}</td>
                    <td>
                        <form method="POST" action="{{ route('finance.journal.reverse', $journal->id) }}" style="display:inline">
                            @csrf
                            <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                            <input name="reason" type="text" placeholder="Reversal reason" required>
                            <button type="submit" class="btn small secondary">Reverse</button>
                        </form>
                    </td>
                </tr>
            @endforeach
        </table>
        @if ($journalLines->isNotEmpty())
            <h2 style="margin-top:16px">Journal lines (newest first)</h2>
            <table class="grid">
                <tr><th>Journal</th><th>Account</th><th>Direction</th><th>Amount</th></tr>
                @foreach ($journalLines as $line)
                    <tr>
                        <td>{{ \Illuminate\Support\Str::limit($line->journal_id, 16) }}</td>
                        <td>{{ \Illuminate\Support\Str::limit($line->account_id, 16) }}</td>
                        <td>{{ $line->direction }}</td>
                        <td>{{ $line->amount }}</td>
                    </tr>
                @endforeach
            </table>
        @endif
    @endif
</div>

<div class="card">
    <h2>Discounts</h2>
    <p class="sub">Proposed with its eligibility basis and effective window against an obligation in an open period; approved by a distinct employee. The original charge is never rewritten and an approved discount is immutable history.</p>
    <form method="POST" action="{{ route('finance.discount.propose') }}">
        @csrf
        <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
        <div class="row">
            <div>
                <label>Obligation</label>
                <select name="obligation_id" required>
                    <option value="">Select an obligation…</option>
                    @foreach ($obligations as $obligation)
                        <option value="{{ $obligation->id }}">{{ \Illuminate\Support\Str::limit($obligation->student_id, 14) }} / {{ \Illuminate\Support\Str::limit($obligation->source, 14) }}</option>
                    @endforeach
                </select>
            </div>
            <div>
                <label>Open financial period</label>
                <select name="period_id" required>
                    <option value="">Select an open period…</option>
                    @foreach ($periods as $period)
                        @if ($period->lifecycle_state === 'open')
                            <option value="{{ $period->id }}">{{ $period->period_key }}</option>
                        @endif
                    @endforeach
                </select>
            </div>
            <div>
                <label>Amount</label>
                <input name="amount" type="text" inputmode="decimal" required>
            </div>
            <div>
                <label>Eligibility basis</label>
                <input name="eligibility" type="text" required>
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
        <div class="fields">
            <input name="reason" type="text" placeholder="Reason" required>
        </div>
        <div class="actions"><button type="submit" class="btn">Propose discount</button></div>
    </form>
    @if ($discounts->isEmpty())
        <p class="empty">No discounts recorded.</p>
    @else
        <table class="grid" style="margin-top:8px">
            <tr><th>Obligation</th><th>Amount</th><th>Eligibility</th><th>Window</th><th>State</th><th></th></tr>
            @foreach ($discounts as $discount)
                <tr>
                    <td>{{ \Illuminate\Support\Str::limit($discount->obligation_id, 16) }}</td>
                    <td>{{ $discount->amount }}</td>
                    <td class="muted">{{ \Illuminate\Support\Str::limit($discount->eligibility, 24) }}</td>
                    <td>{{ $discount->effective_from }} → {{ $discount->effective_to ?? '—' }}</td>
                    <td><span class="pill {{ $discount->lifecycle_state === 'approved' ? 'ok' : '' }}">{{ $discount->lifecycle_state }}</span></td>
                    <td>
                        @if ($discount->lifecycle_state === 'proposed')
                            <form method="POST" action="{{ route('finance.discount.approve', $discount->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <button type="submit" class="btn small" title="Approves this discount under your authority (must differ from the proposer)">Approve</button>
                            </form>
                        @endif
                    </td>
                </tr>
            @endforeach
        </table>
    @endif
</div>

<div class="card">
    <h2>Reconciliations</h2>
    <p class="sub">One observation per period and subject: expected vs observed, with a variance that requires its explanation. Approved by a distinct employee — reconciliation owns the comparison evidence, never an alternate cash truth.</p>
    <form method="POST" action="{{ route('finance.reconciliation.observe') }}">
        @csrf
        <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
        <div class="row">
            <div>
                <label>Financial period</label>
                <select name="period_id" required>
                    <option value="">Select a period…</option>
                    @foreach ($periods as $period)
                        <option value="{{ $period->id }}">{{ $period->period_key }}</option>
                    @endforeach
                </select>
            </div>
            <div>
                <label>Subject</label>
                <input name="subject" type="text" placeholder="e.g. bank-cash" required>
            </div>
            <div>
                <label>Expected</label>
                <input name="expected" type="text" inputmode="decimal" required>
            </div>
            <div>
                <label>Observed</label>
                <input name="observed" type="text" inputmode="decimal" required>
            </div>
            <div>
                <label>Explanation (required when observed ≠ expected)</label>
                <input name="explanation" type="text">
            </div>
        </div>
        <div class="actions"><button type="submit" class="btn">Record observation</button></div>
    </form>
    @if ($reconciliations->isEmpty())
        <p class="empty">No reconciliations recorded.</p>
    @else
        <table class="grid" style="margin-top:8px">
            <tr><th>Period</th><th>Subject</th><th>Expected</th><th>Observed</th><th>Variance</th><th>State</th><th></th></tr>
            @foreach ($reconciliations as $reconciliation)
                <tr>
                    <td>{{ \Illuminate\Support\Str::limit($reconciliation->period_id, 16) }}</td>
                    <td>{{ $reconciliation->subject }}</td>
                    <td>{{ $reconciliation->expected }}</td>
                    <td>{{ $reconciliation->observed }}</td>
                    <td>{{ $reconciliation->variance }}</td>
                    <td><span class="pill {{ $reconciliation->lifecycle_state === 'approved' ? 'ok' : '' }}">{{ $reconciliation->lifecycle_state }}</span></td>
                    <td>
                        @if ($reconciliation->lifecycle_state === 'draft')
                            <form method="POST" action="{{ route('finance.reconciliation.approve', $reconciliation->id) }}" style="display:inline">
                                @csrf
                                <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <button type="submit" class="btn small" title="Approves this observation under your authority (must differ from the observer)">Approve</button>
                            </form>
                        @endif
                    </td>
                </tr>
            @endforeach
        </table>
    @endif
</div>

<div class="card">
    <h2>Funding sources</h2>
    <p class="sub">An immutable funding agreement establishes a pool and its restriction; allocations apply fund money to student obligation lines of the permitted use only and never exceed the committed pool.</p>
    <form method="POST" action="{{ route('finance.fund.establish') }}">
        @csrf
        <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
        <div class="row">
            <div>
                <label>Name</label>
                <input name="name" type="text" required>
            </div>
            <div>
                <label>Agreement reference</label>
                <input name="agreement_ref" type="text" required>
            </div>
            <div>
                <label>Committed amount</label>
                <input name="committed_amount" type="text" inputmode="decimal" required>
            </div>
            <div>
                <label>Restricted category (optional)</label>
                <input name="restricted_category" type="text">
            </div>
            <div>
                <label>Restriction note (required when restricted)</label>
                <input name="restriction_note" type="text">
            </div>
        </div>
        <div class="actions"><button type="submit" class="btn">Establish funding source</button></div>
    </form>
    @if ($fundingSources->isEmpty())
        <p class="empty">No funding sources recorded.</p>
    @else
        <table class="grid" style="margin-top:8px">
            <tr><th>Name</th><th>Committed</th><th>Restriction</th><th>Allocate</th></tr>
            @foreach ($fundingSources as $fundingSource)
                <tr>
                    <td>{{ $fundingSource->name }}</td>
                    <td>{{ $fundingSource->committed_amount }}</td>
                    <td class="muted">{{ $fundingSource->restricted_category ?? '—' }}</td>
                    <td>
                        <form method="POST" action="{{ route('finance.fund.allocate', $fundingSource->id) }}" style="display:inline">
                            @csrf
                            <input type="hidden" name="idempotency_key" value="{{ \Illuminate\Support\Str::uuid() }}">
                            <select name="obligation_line_id" required>
                                <option value="">Obligation line…</option>
                                @foreach ($obligationLines as $line)
                                    <option value="{{ $line->id }}">{{ \Illuminate\Support\Str::limit($line->obligation_id, 12) }} / {{ $line->category }} ({{ $line->amount }})</option>
                                @endforeach
                            </select>
                            <input name="amount" type="text" inputmode="decimal" placeholder="Amount" required>
                            <input name="reason" type="text" placeholder="Reason" required>
                            <button type="submit" class="btn small">Allocate</button>
                        </form>
                    </td>
                </tr>
            @endforeach
        </table>
    @endif
    @if ($fundAllocations->isNotEmpty())
        <h2 style="margin-top:16px">Fund allocations (newest first)</h2>
        <table class="grid">
            <tr><th>Fund</th><th>Obligation line</th><th>Amount</th><th>Reason</th><th>Allocated by</th></tr>
            @foreach ($fundAllocations as $allocation)
                <tr>
                    <td>{{ \Illuminate\Support\Str::limit($allocation->fund_id, 16) }}</td>
                    <td>{{ \Illuminate\Support\Str::limit($allocation->obligation_line_id, 16) }}</td>
                    <td>{{ $allocation->amount }}</td>
                    <td class="muted">{{ \Illuminate\Support\Str::limit($allocation->reason, 24) }}</td>
                    <td>{{ \Illuminate\Support\Str::limit($allocation->allocated_by, 16) }}</td>
                </tr>
            @endforeach
        </table>
    @endif
</div>
@endsection
