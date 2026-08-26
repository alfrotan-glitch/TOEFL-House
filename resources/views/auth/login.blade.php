@extends('layouts.app')

@section('title', 'Sign in')

@section('content')
<div style="max-width: 420px; margin: 60px auto;">
    <div class="card">
        <h1>Sign in to The TOEFL House</h1>
        <p class="sub">Employee console. Sign in with the account issued by the identity administrator.</p>

        @if ($errors->any())
            <div class="alert error">{{ $errors->first() }}</div>
        @endif

        <form method="POST" action="{{ route('login.submit') }}" novalidate>
            @csrf
            <label for="username">Username</label>
            <input id="username" name="username" type="text" value="{{ old('username') }}" autocomplete="username" autofocus required>
            @error('username')<div class="field-error">{{ $message }}</div>@enderror

            <label for="password">Password</label>
            <input id="password" name="password" type="password" autocomplete="current-password" required>
            @error('password')<div class="field-error">{{ $message }}</div>@enderror

            <div class="row" style="margin-top: 14px; align-items: center;">
                <div style="flex: 0 0 auto; display: flex; gap: 8px; align-items: center;">
                    <input id="remember" name="remember" type="checkbox" style="width: auto;">
                    <label for="remember" style="margin: 0;">Keep me signed in</label>
                </div>
            </div>

            <div class="actions">
                <button type="submit" class="btn">Sign in</button>
            </div>
        </form>
    </div>
</div>
@endsection
