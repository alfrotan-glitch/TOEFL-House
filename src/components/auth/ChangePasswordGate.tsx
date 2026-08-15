import React, { useState } from 'react';
import { KeyRound, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { useAuth } from '../../contexts/useAuth';
import { ApiError } from '../../api/client';

export default function ChangePasswordGate() {
  const { changePassword, logout, user } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (newPassword.length < 12) {
      setError('New password must be at least 12 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('New password and confirmation do not match.');
      return;
    }
    setIsSubmitting(true);
    try {
      await changePassword(currentPassword, newPassword);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change password. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-slate-900 font-sans select-none" dir="ltr">
      <div className="w-full max-w-sm mx-4">
        <form
          onSubmit={handleSubmit}
          className="bg-slate-800/60 border border-slate-700 rounded-2xl p-6 shadow-2xl backdrop-blur-sm space-y-4"
        >
          <div className="flex flex-col items-center text-center mb-2">
            <div className="w-11 h-11 rounded-full bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center mb-3">
              <KeyRound className="w-5 h-5 text-indigo-400" />
            </div>
            <h1 className="text-white font-bold text-sm">Change temporary password</h1>
            <p className="text-slate-400 text-[11px] mt-1 leading-relaxed">
              {user?.fullName}, to continue, replace your temporary password with a personal one.
            </p>
          </div>

          {error && (
            <div className="flex items-start gap-2 bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs rounded-xl px-3 py-2.5">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <div>
            <label className="text-slate-400 text-[11px] font-semibold block mb-1.5">Current temporary password</label>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 text-white text-sm rounded-xl py-2.5 px-3 focus:outline-none focus:border-indigo-500 transition-colors"
              autoComplete="current-password"
            />
          </div>
          <div>
            <label className="text-slate-400 text-[11px] font-semibold block mb-1.5">New password</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 text-white text-sm rounded-xl py-2.5 px-3 focus:outline-none focus:border-indigo-500 transition-colors"
              autoComplete="new-password"
              placeholder="At least 12 characters"
            />
          </div>
          <div>
            <label className="text-slate-400 text-[11px] font-semibold block mb-1.5">Confirm new password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 text-white text-sm rounded-xl py-2.5 px-3 focus:outline-none focus:border-indigo-500 transition-colors"
              autoComplete="new-password"
            />
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-sm font-bold rounded-xl py-2.5 flex items-center justify-center gap-2 transition-colors cursor-pointer mt-2"
          >
            {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
            {isSubmitting ? 'Saving…' : 'Save and continue'}
          </button>

          <button
            type="button"
            onClick={logout}
            className="w-full text-slate-500 hover:text-slate-300 text-[11px] text-center transition-colors cursor-pointer"
          >
            Sign out and use another account
          </button>
        </form>
      </div>
    </div>
  );
}
