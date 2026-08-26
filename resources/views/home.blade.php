@extends('layouts.app')

@section('title', 'Home')

@section('content')
<div class="card">
    <h1>Welcome to The TOEFL House</h1>
    <p class="sub">Today is {{ $today }}. Choose a work area below. Every operation you perform is authorized, validated, and recorded in the audit trail.</p>
</div>

<div class="row">
    <div class="card" style="flex:1 1 220px">
        <h2>Students &amp; Admissions</h2>
        <p style="font-size:26px; font-weight:700; margin:4px 0;">{{ $activeStudents }}</p>
        <p class="muted" style="margin:0 0 10px">active students</p>
        <p style="font-size:26px; font-weight:700; margin:4px 0;">{{ $pendingApplicants }}</p>
        <p class="muted" style="margin:0 0 14px">applicants awaiting a decision</p>
        <a class="btn small secondary" href="{{ route('students.index') }}">Open Students &rarr;</a>
    </div>
    <div class="card" style="flex:1 1 220px">
        <h2>Academic Delivery</h2>
        <p style="font-size:26px; font-weight:700; margin:4px 0;">{{ $sessionsThisWeek }}</p>
        <p class="muted" style="margin:0 0 14px">sessions scheduled this week</p>
        <a class="btn small secondary" href="{{ route('academic.index') }}">Open Academic &rarr;</a>
    </div>
    <div class="card" style="flex:1 1 220px">
        <h2>Teachers &amp; Payroll</h2>
        <p style="font-size:26px; font-weight:700; margin:4px 0;">{{ $activeTeachers }}</p>
        <p class="muted" style="margin:0 0 4px">active teachers</p>
        <p style="font-size:26px; font-weight:700; margin:4px 0;">{{ $heldCalculations }}</p>
        <p class="muted" style="margin:0 0 14px">payroll calculations held</p>
        <a class="btn small secondary" href="{{ route('payroll.index') }}">Open Payroll &rarr;</a>
    </div>
</div>

<div class="card">
    <h2>Work areas</h2>
    <table class="grid">
        <tr><th>Area</th><th>What you can do</th><th></th></tr>
        <tr><td><a href="{{ route('organization.index') }}">Organization &amp; Configuration</a></td><td>Structure, branches, positions, and access policy</td><td><a class="btn small secondary" href="{{ route('organization.index') }}">Open</a></td></tr>
        <tr><td><a href="{{ route('identity.index') }}">Identity &amp; Access</a></td><td>Verify people, issue accounts, grant and delegate authority</td><td><a class="btn small secondary" href="{{ route('identity.index') }}">Open</a></td></tr>
        <tr><td><a href="{{ route('students.index') }}">Students &amp; Admissions</a></td><td>Register applicants, admit, enroll, and track the student lifecycle</td><td><a class="btn small secondary" href="{{ route('students.index') }}">Open</a></td></tr>
        <tr><td><a href="{{ route('academic.index') }}">Academic</a></td><td>Programs, classes, teacher assignments, sessions, and attendance</td><td><a class="btn small secondary" href="{{ route('academic.index') }}">Open</a></td></tr>
        <tr><td><a href="{{ route('hr.index') }}">Teachers &amp; HR</a></td><td>Employment, contract versions, scales, and leave</td><td><a class="btn small secondary" href="{{ route('hr.index') }}">Open</a></td></tr>
        <tr><td><a href="{{ route('library.index') }}">Library &amp; Resources</a></td><td>Assets, book circulation, and work orders</td><td><a class="btn small secondary" href="{{ route('library.index') }}">Open</a></td></tr>
        <tr><td><a href="{{ route('finance.index') }}">Finance</a></td><td>Obligations, payments, refunds, discounts, and journals</td><td><a class="btn small secondary" href="{{ route('finance.index') }}">Open</a></td></tr>
        <tr><td><a href="{{ route('payroll.index') }}">Payroll</a></td><td>Periods, calculations, approval, and settlement</td><td><a class="btn small secondary" href="{{ route('payroll.index') }}">Open</a></td></tr>
        <tr><td><a href="{{ route('reporting.index') }}">Reporting &amp; Dashboards</a></td><td>Authoritative metrics, report runs, and dashboards</td><td><a class="btn small secondary" href="{{ route('reporting.index') }}">Open</a></td></tr>
        <tr><td><a href="{{ route('audit.index') }}">Audit &amp; Governance</a></td><td>Immutable audit trail, privacy, and documents</td><td><a class="btn small secondary" href="{{ route('audit.index') }}">Open</a></td></tr>
    </table>
</div>
@endsection
