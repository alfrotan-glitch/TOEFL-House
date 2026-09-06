<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="csrf-token" content="{{ csrf_token() }}">
    <title>@yield('title', 'Console') — The TOEFL House</title>
    <style>
        :root {
            --ink: #1a2233; --muted: #5b6577; --line: #e3e7ef; --bg: #f5f7fb;
            --brand: #123a6d; --brand-2: #1c5aa8; --accent: #f0b429; --danger: #b3261e; --ok: #1e7e34;
        }
        * { box-sizing: border-box; }
        body { margin: 0; font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--ink); background: var(--bg); font-size: 15px; line-height: 1.5; }
        a { color: var(--brand-2); text-decoration: none; }
        a:hover { text-decoration: underline; }
        header.top { background: var(--brand); color: #fff; }
        header.top .bar { max-width: 1200px; margin: 0 auto; padding: 14px 24px; display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
        header.top .brand { font-size: 19px; font-weight: 700; letter-spacing: .2px; }
        header.top .brand span { color: var(--accent); }
        nav.main { display: flex; gap: 4px; flex-wrap: wrap; }
        nav.main a { color: #dbe6f5; padding: 6px 10px; border-radius: 6px; font-size: 13.5px; }
        nav.main a:hover { background: rgba(255,255,255,.12); text-decoration: none; }
        header.top .who { margin-left: auto; display: flex; align-items: center; gap: 12px; font-size: 13px; color: #dbe6f5; }
        header.top .who button { background: transparent; border: 1px solid rgba(255,255,255,.4); color: #fff; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; }
        header.top .who button:hover { background: rgba(255,255,255,.12); }
        main { max-width: 1200px; margin: 24px auto; padding: 0 24px; }
        .card { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 20px 22px; margin-bottom: 18px; }
        .card h1 { font-size: 20px; margin: 0 0 4px; }
        .card h2 { font-size: 16px; margin: 0 0 12px; }
        .sub { color: var(--muted); font-size: 13.5px; margin: 0 0 16px; }
        table.grid { width: 100%; border-collapse: collapse; font-size: 14px; }
        table.grid th, table.grid td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
        table.grid th { font-size: 12px; text-transform: uppercase; letter-spacing: .4px; color: var(--muted); }
        table.grid tr:last-child td { border-bottom: none; }
        .pill { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; background: #eef2f8; color: var(--brand); }
        .pill.ok { background: #e6f4ea; color: var(--ok); }
        .pill.held { background: #fdecea; color: var(--danger); }
        .pill.warn { background: #fff4dd; color: #8a6100; }
        label { display: block; font-size: 13px; font-weight: 600; margin: 12px 0 4px; }
        input, select, textarea { width: 100%; padding: 9px 10px; border: 1px solid #c9d2e0; border-radius: 7px; font-size: 14px; font-family: inherit; background: #fff; }
        input:focus, select:focus, textarea:focus { outline: 2px solid rgba(28,90,168,.35); border-color: var(--brand-2); }
        .row { display: flex; gap: 14px; flex-wrap: wrap; }
        .row > div { flex: 1 1 200px; }
        .btn { display: inline-block; background: var(--brand-2); color: #fff; border: none; padding: 9px 16px; border-radius: 7px; font-size: 14px; font-weight: 600; cursor: pointer; }
        .btn:hover { background: var(--brand); }
        .btn.secondary { background: #eef2f8; color: var(--brand); }
        .btn.danger { background: var(--danger); }
        .btn.small { padding: 5px 10px; font-size: 12.5px; }
        .actions { margin-top: 16px; display: flex; gap: 10px; flex-wrap: wrap; }
        .alert { padding: 11px 14px; border-radius: 8px; font-size: 14px; margin-bottom: 14px; border: 1px solid; }
        .alert.error { background: #fdecea; color: var(--danger); border-color: #f5c6c2; }
        .alert.ok { background: #e6f4ea; color: var(--ok); border-color: #bfe3cb; }
        .field-error { color: var(--danger); font-size: 13px; margin-top: 3px; }
        .toolbar { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; align-items: end; }
        .toolbar > div { flex: 1 1 160px; }
        .muted { color: var(--muted); }
        .empty { text-align: center; color: var(--muted); padding: 30px 0; }
        footer { max-width: 1200px; margin: 20px auto 40px; padding: 0 24px; color: var(--muted); font-size: 12.5px; }
        @media (max-width: 720px) { main { padding: 0 14px; } header.top .bar { padding: 12px 14px; } }
    </style>
    @stack('head')
</head>
<body>
<header class="top">
    <div class="bar">
        <div class="brand">The <span>TOEFL</span> House</div>
        @auth
            <nav class="main">
                <a href="{{ route('home') }}">Home</a>
                <a href="{{ route('organization.index') }}">Organization</a>
                <a href="{{ route('identity.index') }}">Identity &amp; Access</a>
                <a href="{{ route('access.index') }}">Access</a>
                <a href="{{ route('students.index') }}">Students</a>
                <a href="{{ route('crm.index') }}">CRM</a>
                <a href="{{ route('placement.index') }}">Placement</a>
                <a href="{{ route('academic.index') }}">Academic</a>
                <a href="{{ route('hr.index') }}">Teachers &amp; HR</a>
                <a href="{{ route('library.index') }}">Library</a>
                <a href="{{ route('finance.index') }}">Finance</a>
                <a href="{{ route('documents.index') }}">Documents</a>
                <a href="{{ route('privacy.index') }}">Privacy</a>
                <a href="{{ route('communication.index') }}">Communication</a>
                <a href="{{ route('payroll.index') }}">Payroll</a>
                <a href="{{ route('reporting.index') }}">Reporting</a>
                <a href="{{ route('audit.index') }}">Audit</a>
            </nav>
            <div class="who">
                <span>{{ auth()->user()->person?->legal_name ?? auth()->user()->username }}</span>
                <form method="POST" action="{{ route('logout') }}" style="display:inline">
                    @csrf
                    <button type="submit">Sign out</button>
                </form>
            </div>
        @endauth
    </div>
</header>
<main>
    @if (session('error'))
        <div class="alert error">{{ session('error') }}</div>
    @endif
    @if (session('success'))
        <div class="alert ok">{{ session('success') }}</div>
    @endif
    @yield('content')
</main>
<footer>The TOEFL House — employee console. All operations are authorized, validated, and audited server-side.</footer>
</body>
</html>
