<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Modules\Identity\Models\UserAccount;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Hash;
use Illuminate\View\View;

/**
 * Employee sign-in and sign-out for The TOEFL House console. Authentication
 * is the identity module's user account (username + hashed credential);
 * authority is then resolved per operation from the canonical access model.
 */
final class AuthenticationController extends Controller
{
    public function show(): View
    {
        return view('auth.login');
    }

    public function login(Request $request): RedirectResponse
    {
        $credentials = $request->validate([
            'username' => ['required', 'string', 'max:120'],
            'password' => ['required', 'string'],
        ]);

        $account = UserAccount::query()->where('username', $credentials['username'])->first();

        if ($account === null || ! $account->isActive() || ! Hash::check($credentials['password'], (string) $account->password_hash)) {
            return back()->withErrors(['username' => 'Sign in details do not match an active employee account.'])->onlyInput('username');
        }

        Auth::login($account, $request->boolean('remember'));
        $request->session()->regenerate();

        return redirect()->intended(route('home'));
    }

    public function logout(Request $request): RedirectResponse
    {
        Auth::logout();
        $request->session()->invalidate();
        $request->session()->regenerateToken();

        return redirect()->route('login');
    }
}
