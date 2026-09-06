@extends('print.layout')

@section('docTitle', 'Certificate')
@section('docName', 'Certificate')

@section('body')
    <div style="text-align:center; padding: 26px 0 10px 0;">
        <div style="font-size: 15px; letter-spacing: 3px; text-transform: uppercase; color:#5b6472;">This certifies that</div>
        <div style="font-size: 30px; font-weight: 700; margin: 18px 0 6px 0;">{{ $student->person?->legal_name ?? '—' }}</div>
        <div style="font-size: 14px; color:#5b6472;">Student code {{ $student->student_code ?? '—' }}</div>
        <div style="font-size: 16px; margin: 18px 0;">has satisfactorily completed the required program of study and is hereby awarded this certificate.</div>
    </div>
    <table class="doc">
        <tr><th>Certificate serial</th><td><code>{{ $certificate->serial }}</code></td></tr>
        <tr><th>Graduation decision</th><td>{{ \Illuminate\Support\Str::limit($certificate->graduation_decision_id, 20) }}</td></tr>
    </table>
@endsection

@push('signatures')
    <div class="sig">
        <div class="box">Issuing authority (director)</div>
        <div class="box">Registrar / academic office</div>
    </div>
@endpush
