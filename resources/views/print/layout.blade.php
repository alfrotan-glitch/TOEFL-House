<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>@yield('docTitle', 'Document') — {{ \Illuminate\Support\Str::of($orgIdentity['name'])->limit(40) }}</title>
    <style>
        :root {
            --ink: #1c2330;
            --line: #d8dee8;
            --brand: #16324f;
        }
        * { box-sizing: border-box; }
        body { font-family: Georgia, 'Times New Roman', serif; color: var(--ink); margin: 0; background: #eef1f5; }
        .sheet {
            background: #fff;
            width: 210mm;
            min-height: 297mm;
            margin: 16px auto;
            padding: 18mm 16mm;
            box-shadow: 0 2px 12px rgba(20, 30, 50, .15);
        }
        @page { size: A4; margin: 14mm 14mm 16mm 14mm; }
        @media print {
            body { background: #fff; }
            .sheet { margin: 0; box-shadow: none; width: auto; min-height: auto; padding: 0; }
            .no-print { display: none !important; }
        }
        .doc-header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid var(--brand); padding-bottom: 10px; margin-bottom: 18px; }
        .doc-org { font-size: 20px; font-weight: 700; color: var(--brand); letter-spacing: .3px; }
        .doc-branch { font-size: 12px; color: #5b6472; margin-top: 2px; }
        .doc-title { text-align: right; }
        .doc-title .name { font-size: 16px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: var(--ink); }
        .doc-title .no { font-size: 12px; color: #5b6472; margin-top: 2px; }
        table.doc { width: 100%; border-collapse: collapse; margin: 14px 0; }
        table.doc th, table.doc td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); font-size: 13px; }
        table.doc th { background: #f4f6f9; text-transform: uppercase; font-size: 11px; letter-spacing: .5px; color: #5b6472; }
        .doc-figure { font-size: 30px; font-weight: 700; color: var(--brand); }
        .doc-meta { font-size: 11px; color: #5b6472; margin-top: 22px; border-top: 1px solid var(--line); padding-top: 8px; display: flex; justify-content: space-between; }
        .sig { display: flex; gap: 40px; margin-top: 46px; }
        .sig .box { flex: 1; border-top: 1px solid var(--ink); padding-top: 6px; font-size: 12px; color: #5b6472; }
        .no-print-bar { max-width: 210mm; margin: 12px auto; display: flex; gap: 10px; justify-content: flex-end; }
        .no-print-bar button { font: 600 13px/1 system-ui, sans-serif; padding: 9px 16px; border-radius: 8px; border: 1px solid var(--brand); background: var(--brand); color: #fff; cursor: pointer; }
    </style>
</head>
<body>
    <div class="no-print-bar no-print">
        <button type="button" onclick="window.print()">Print / Save as PDF</button>
    </div>
    <div class="sheet">
        <div class="doc-header">
            <div>
                <div class="doc-org">{{ $orgIdentity['name'] }}</div>
                @if (!empty($orgIdentity['branch']))
                    <div class="doc-branch">{{ $orgIdentity['branch'] }}</div>
                @endif
            </div>
            <div class="doc-title">
                <div class="name">@yield('docName', 'Document')</div>
                <div class="no">No. {{ $documentNo ?? '—' }}</div>
            </div>
        </div>

        @yield('body')

        <div class="doc-meta">
            <span>Issued {{ $issuedOn ?? '—' }} by {{ auth()->user()?->person?->legal_name ?? auth()->user()?->username ?? 'system' }}</span>
            <span>{{ $orgIdentity['name'] }} — official record</span>
        </div>
        @yield('signatures')
    </div>
</body>
</html>
