@extends('print.layout')

@section('docTitle', 'Enrollment Record')
@section('docName', 'Enrollment Record')

@section('body')
    <table class="doc">
        <tr><th>Student</th><td>{{ $student->student_code ?? '—' }} — {{ $student->person?->legal_name ?? $enrollment->student_id }}</td></tr>
        <tr><th>Class</th><td>{{ \Illuminate\Support\Str::limit($enrollment->class_id, 20) }}</td></tr>
        <tr><th>Enrollment reference</th><td><code>{{ \Illuminate\Support\Str::limit($enrollment->id, 20) }}</code></td></tr>
        <tr><th>State</th><td>{{ $enrollment->lifecycle_state }}</td></tr>
        <tr><th>Created</th><td>{{ optional($enrollment->created_at)->format('Y-m-d H:i') ?? '—' }}</td></tr>
    </table>
    <p>This record confirms the student's enrollment into the class as held by the academic module.</p>
@endsection

@push('signatures')
    <div class="sig">
        <div class="box">Admissions / academic office</div>
        <div class="box">Student guardian</div>
    </div>
@endpush
