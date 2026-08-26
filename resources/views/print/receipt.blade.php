@extends('print.layout')

@section('docTitle', 'Payment Receipt')
@section('docName', 'Payment Receipt')

@section('body')
    <table class="doc">
        <tr><th>Student</th><td>{{ $student->student_code ?? '—' }} — {{ $student->person?->legal_name ?? $payment->student_id }}</td></tr>
        <tr><th>Payment reference</th><td><code>{{ $payment->payer_ref }}</code></td></tr>
        <tr><th>Payment method</th><td>{{ $payment->method }}</td></tr>
        <tr><th>Received on</th><td>{{ $payment->received_on }}</td></tr>
        <tr><th>Financial period</th><td>{{ \Illuminate\Support\Str::limit($payment->period_id, 20) }}</td></tr>
    </table>
    <p>Amount received</p>
    <div class="doc-figure">{{ number_format((float) $payment->amount, 2) }}</div>
@endsection

@push('signatures')
    <div class="sig">
        <div class="box">Received by (cashier)</div>
        <div class="box">Student / payer</div>
    </div>
@endpush
