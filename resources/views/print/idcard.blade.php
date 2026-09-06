@extends('print.layout')

@section('docTitle', 'Student ID Card')
@section('docName', 'Student ID')

@section('body')
    <div style="max-width: 340px; margin: 30px auto; border: 2px solid var(--brand); border-radius: 14px; overflow: hidden;">
        <div style="background: var(--brand); color: #fff; padding: 14px 18px; display: flex; justify-content: space-between; align-items: center;">
            <div>
                <div style="font-size: 15px; font-weight: 700;">{{ $orgIdentity['name'] }}</div>
                @if (!empty($orgIdentity['branch']))
                    <div style="font-size: 11px; opacity: .85;">{{ $orgIdentity['branch'] }}</div>
                @endif
            </div>
            <div style="font-size: 11px; letter-spacing: 2px;">STUDENT</div>
        </div>
        <div style="padding: 18px;">
            <div style="font-size: 19px; font-weight: 700;">{{ $student->person?->legal_name ?? '—' }}</div>
            <div style="font-size: 12px; color: #5b6472; margin-top: 4px;">Student code</div>
            <div style="font-size: 15px; font-weight: 600; margin-bottom: 12px;"><code>{{ $student->student_code ?? '—' }}</code></div>
            <div style="display: flex; justify-content: space-between; font-size: 11px; color: #5b6472; border-top: 1px solid var(--line); padding-top: 10px;">
                <span>ID {{ \Illuminate\Support\Str::limit($student->id, 12) }}</span>
                <span>Issued {{ $issuedOn }}</span>
            </div>
        </div>
    </div>
@endsection
