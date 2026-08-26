@extends('print.layout')

@section('docTitle', 'Payroll Slip')
@section('docName', 'Payroll Slip')

@section('body')
    <table class="doc">
        <tr><th>Employment</th><td>{{ \Illuminate\Support\Str::limit($result->employment_id, 20) }}</td></tr>
        <tr><th>Pay period</th><td>{{ $period->period_key ?? '—' }} ({{ $period->date_from ?? '—' }} → {{ $period->date_to ?? '—' }})</td></tr>
        <tr><th>Result reference</th><td><code>{{ \Illuminate\Support\Str::limit($result->id, 20) }}</code></td></tr>
    </table>
    <p>Gross pay for the period (as calculated and approved)</p>
    <div class="doc-figure">{{ number_format((float) $result->amount, 2) }}</div>
    <p class="doc-meta" style="border:none; margin-top:14px; padding:0;">
        This amount is produced by the deterministic payroll engine from the in-force contract version and was approved per the separation of duties. It is not manually edited.
    </p>
@endsection

@push('signatures')
    <div class="sig">
        <div class="box">Prepared by (payroll)</div>
        <div class="box">Approved by (not preparer)</div>
    </div>
@endpush
