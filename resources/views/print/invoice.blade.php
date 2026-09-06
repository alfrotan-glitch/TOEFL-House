@extends('print.layout')

@section('docTitle', 'Invoice')
@section('docName', 'Invoice')

@section('body')
    <table class="doc">
        <tr><th>Student</th><td>{{ $student->student_code ?? '—' }} — {{ $student->person?->legal_name ?? $obligation->student_id }}</td></tr>
        <tr><th>Obligation source</th><td>{{ $obligation->source }}</td></tr>
        <tr><th>Reason</th><td>{{ $obligation->reason }}</td></tr>
        <tr><th>Financial period</th><td>{{ \Illuminate\Support\Str::limit($obligation->period_id, 20) }}</td></tr>
        <tr><th>Posted by</th><td>{{ \Illuminate\Support\Str::limit($obligation->posted_by, 20) }}</td></tr>
    </table>
    <p>Charged amount (original)</p>
    <div class="doc-figure">{{ number_format((float) $obligation->original_amount, 2) }}</div>
@endsection

@push('signatures')
    <div class="sig">
        <div class="box">Prepared by (finance)</div>
        <div class="box">Authorized by</div>
    </div>
@endpush
