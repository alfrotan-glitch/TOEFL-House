/**
 * @license SPDX-License-Identifier: Apache-2.0
 *
 * TOEFL House ERP — Sign In (Design System v3.0)
 * ============================================================
 * A focused operational entrance with product capabilities on the left
 * and a precise sign-in form on the right.
 *
 * Built entirely on the product design tokens.
 * LTR / English, per the product's UI language decision.
 */
import React, { useState, useCallback, useMemo } from 'react';
import {
  Lock, User, ArrowRight, Activity, Wallet, ShieldCheck, Eye, EyeOff, AlertCircle, Sparkles,
} from 'lucide-react';
import { useAuth } from '../../contexts/useAuth';
import { api } from '../../api/client';

export default function LoginView() {
  const auth = useAuth() as { login?: (u: string, p: string) => Promise<void> | void; isLoading?: boolean; refreshUser?: () => Promise<void> };
  const login = auth.login;
  const refreshUser = useMemo(() => auth.refreshUser || (async () => undefined), [auth.refreshUser]);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Student portal mode: student code + full name, no password.
  const [studentMode, setStudentMode] = useState(false);
  const [studentName, setStudentName] = useState('');


  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      if (studentMode) {
        if (!username.trim() || !studentName.trim()) {
          setError('Enter both your student code and full name.');
          return;
        }
        setBusy(true);
        try {
          // The AuthContext is cookie-based; the server sets the session
          // cookie, so just refresh the current session.
          await api.post('/auth/student-login', {
            studentCode: username.trim(), fullName: studentName.trim(),
          });
          await refreshUser();
        } catch (err: any) {
          setError(err?.message || 'Student sign-in failed. Check your code and name.');
        } finally {
          setBusy(false);
        }
        return;
      }
      if (!username.trim() || !password) {
        setError('Enter both your username and password.');
        return;
      }
      setBusy(true);
      try {
        await login?.(username.trim(), password);
      } catch (err: any) {
        setError(err?.message || 'Sign-in failed. Check your credentials and try again.');
      } finally {
        setBusy(false);
      }
    },
    [username, password, studentName, studentMode, login, refreshUser],
  );

  return (
    <div dir="ltr" lang="en" className="min-h-screen w-full flex font-sans bg-slate-50 text-slate-900">
      {/* ═══════════════ LEFT — living brand surface ═══════════════ */}
      <div className="relative hidden lg:flex lg:w-[54%] xl:w-[58%] flex-col justify-between overflow-hidden bg-gradient-to-br from-[#2a0410] via-[#4c0519] to-[#3d0714] p-10 xl:p-14">
        {/* ambient glows */}
        <div className="pointer-events-none absolute -top-24 -left-24 w-[28rem] h-[28rem] rounded-full bg-rose-500/20 blur-[120px]" />
        <div className="pointer-events-none absolute bottom-[-10rem] right-[-6rem] w-[26rem] h-[26rem] rounded-full bg-red-700/20 blur-[120px]" />
        {/* faint ledger texture */}
        <div className="pointer-events-none absolute inset-0 bg-ledger opacity-[0.5]" />

        {/* brand mark */}
        <div className="relative flex items-center gap-3 fade-up">
          <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-rose-400 via-rose-500 to-red-600 grid place-items-center shadow-lg shadow-rose-900/50 ring-1 ring-white/20">
            <span className="text-white font-black text-lg font-display tracking-tight">TH</span>
          </div>
          <div>
            <h1 className="text-white font-display font-bold text-lg leading-none tracking-tight">The TOEFL House</h1>
            <p className="overline text-rose-200/45 mt-1">Enterprise ERP</p>
          </div>
        </div>

        {/* statement + living panel */}
        <div className="relative flex-1 flex flex-col justify-center gap-9 py-12">
          <div className="max-w-md fade-up" style={{ animationDelay: '80ms' }}>
            <p className="overline text-rose-300/70 mb-4 flex items-center gap-2">
              <Sparkles className="w-3.5 h-3.5" /> The operating system for your institute
            </p>
            <h2 className="font-display text-white font-bold tracking-[-0.03em] leading-[1.04] text-[2.6rem] xl:text-[3.1rem]">
              Run it like a system,<br />not a spreadsheet.
            </h2>
            <p className="text-rose-100/55 text-sm leading-relaxed mt-5 max-w-sm">
              Fifteen bounded contexts, one source of truth. Every fee, session,
              scholarship and salary — reconciled the instant it happens.
            </p>
          </div>

          <div className="max-w-md rounded-2xl ring-1 ring-white/10 bg-white/[0.04] backdrop-blur-sm p-5 shadow-float fade-up" style={{ animationDelay: '180ms' }}>
            <div className="flex items-center justify-between mb-4">
              <span className="overline text-rose-200/45">Platform capabilities</span>
              <span className="text-[10px] font-bold text-emerald-300">SECURE SESSION</span>
            </div>
            <div className="space-y-3">
              {[
                [ShieldCheck, 'Branch-aware RBAC', 'Permissions follow role, organization and branch scope.'],
                [Activity, 'Operational visibility', 'CRM, academic operations and finance share the same source data.'],
                [Wallet, 'Financial controls', 'Invoices, payments, payroll and ledger activity remain traceable.'],
              ].map(([Icon, title, description]) => {
                const IconComponent = Icon as React.ComponentType<{ className?: string }>;
                return (
                  <div key={String(title)} className="flex items-start gap-3 rounded-xl bg-white/[0.035] border border-white/10 p-3">
                    <span className="w-8 h-8 rounded-lg bg-rose-400/10 text-rose-200 grid place-items-center shrink-0"><IconComponent className="w-4 h-4" /></span>
                    <div><p className="text-xs font-extrabold text-white">{String(title)}</p><p className="text-[10.5px] leading-relaxed text-rose-100/50 mt-0.5">{String(description)}</p></div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* footer chips */}
        <div className="relative flex flex-wrap gap-2 fade-up" style={{ animationDelay: '260ms' }}>
          {['Domain-oriented ERP', 'Operational workflows', 'Event-Driven', 'Rule Engine'].map((c) => (
            <span key={c} className="text-[10px] font-bold uppercase tracking-wider text-rose-100/55 px-2.5 py-1 rounded-full ring-1 ring-white/10 bg-white/[0.03]">
              {c}
            </span>
          ))}
        </div>
      </div>

      {/* ═══════════════ RIGHT — sign-in form ═══════════════ */}
      <div className="flex-1 flex items-center justify-center p-6 sm:p-10 bg-ambient">
        <div className="w-full max-w-sm">
          {/* mobile-only brand mark */}
          <div className="lg:hidden flex items-center gap-2.5 mb-10 fade-up">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-rose-500 to-red-600 grid place-items-center shadow-md">
              <span className="text-white font-black font-display">TH</span>
            </div>
            <span className="font-display font-bold text-slate-900 tracking-tight">The TOEFL House</span>
          </div>

          <div className="fade-up" style={{ animationDelay: '60ms' }}>
            <p className="overline text-rose-600 mb-3 flex items-center gap-2">
              <ShieldCheck className="w-3.5 h-3.5" /> Secure access
            </p>
            <h2 className="h1 text-slate-950">Sign in</h2>
            <p className="text-sm text-slate-500 mt-2">
              Welcome back. Enter your credentials to open your workspace.
            </p>
          </div>

          <div className="flex gap-1 bg-slate-100 p-1 rounded-xl border border-slate-200 fade-up" style={{ animationDelay: '110ms' }}>
            <button type="button" onClick={() => setStudentMode(false)} className={`flex-1 py-2 text-xs font-bold rounded-lg cursor-pointer ${!studentMode ? 'bg-white text-rose-600 shadow-sm' : 'text-slate-500'}`}>Staff login</button>
            <button type="button" onClick={() => setStudentMode(true)} className={`flex-1 py-2 text-xs font-bold rounded-lg cursor-pointer ${studentMode ? 'bg-white text-rose-600 shadow-sm' : 'text-slate-500'}`}>Student portal</button>
          </div>

          <form onSubmit={onSubmit} className="mt-5 space-y-5 fade-up" style={{ animationDelay: '140ms' }}>
            <div>
              <label className="label" htmlFor="username">{studentMode ? 'Student Code' : 'Username'}</label>
              <div className="relative">
                <User className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="username"
                  className="input pl-10"
                  style={{ paddingLeft: '2.5rem' }}
                  autoComplete="username"
                  placeholder={studentMode ? 'e.g. TH-001001' : 'ahmad.frotan'}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </div>
            </div>

            {studentMode && (
              <div>
                <label className="label" htmlFor="studentName">Full Name</label>
                <div className="relative">
                  <User className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    id="studentName"
                    className="input pl-10"
                    style={{ paddingLeft: '2.5rem' }}
                    autoComplete="name"
                    placeholder="Your full name as registered"
                    value={studentName}
                    onChange={(e) => setStudentName(e.target.value)}
                  />
                </div>
              </div>
            )}

            {!studentMode && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="label !mb-0" htmlFor="password">Password</label>
                <button type="button" className="text-[11px] font-semibold text-rose-600 hover:text-rose-700 transition-colors cursor-pointer">
                  Forgot?
                </button>
              </div>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="password"
                  type={showPw ? 'text' : 'password'}
                  className="input"
                  style={{ paddingLeft: '2.5rem', paddingRight: '2.5rem' }}
                  autoComplete="current-password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => setShowPw((s) => !s)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors cursor-pointer"
                  aria-label={showPw ? 'Hide password' : 'Show password'}
                >
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            )}

            {error && (
              <div className="flex items-start gap-2 text-[12.5px] text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-3.5 py-2.5 fade-up">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              className="btn btn-primary w-full !py-3 group"
            >
              {busy ? (
                <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
              ) : (
                <>
                  {studentMode ? 'Open my student portal' : 'Sign in to workspace'}
                  <ArrowRight className="w-4 h-4 transition-transform duration-200 group-hover:translate-x-1" />
                </>
              )}
            </button>
          </form>

          <div className="mt-8 pt-6 border-t border-slate-200 flex items-center justify-between text-[11px] text-slate-400 fade-up" style={{ animationDelay: '220ms' }}>
            <span className="font-mono">1.0.0 · build 1405</span>
            <span className="flex items-center gap-1.5">
              <span className="live-dot w-1.5 h-1.5 rounded-full bg-emerald-500" />
              All systems operational
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}