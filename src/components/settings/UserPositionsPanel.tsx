/**
 * User positions & effective access (owner-only).
 * Assign/remove positions (with campus/branch scope) per user and inspect the
 * server-computed effective permission list. Effective permissions are always
 * calculated by the backend from the user's active positions and scopes.
 */
import React, { useEffect, useState, useCallback } from 'react';
import { UserPlus, X, Eye, ShieldCheck } from 'lucide-react';

export interface PositionLite { id: string; code: string; name: string; isActive: boolean; }
export interface UserPositionRow {
  id: string;
  roleId: string;
  roleCode: string;
  roleName: string;
  scopeType: string;
  scopeId: string | null;
  isPrimary: boolean;
}
export interface EffectivePerm {
  code: string;
  scope: string;
  source: string;
  scopeId: string | null;
}
export interface UserLite { id: string; username: string; fullName: string; role: string; isActive: boolean; }

interface Props {
  users: UserLite[];
  positions: PositionLite[];
  branches: { id: string; name: string }[];
  campuses: { id: string; name: string }[];
  loadUsers: () => Promise<void>;
  listUserPositions: (userId: string) => Promise<UserPositionRow[]>;
  assignUserPosition: (userId: string, params: { roleId: string; scopeType?: string; scopeId?: string | null }) => Promise<unknown>;
  removeUserPosition: (userId: string, assignmentId: string) => Promise<unknown>;
  viewEffectivePermissions: (userId: string) => Promise<EffectivePerm[]>;
}

export default function UserPositionsPanel(props: Props) {
  const { users, positions, branches, campuses, loadUsers, listUserPositions, assignUserPosition, removeUserPosition, viewEffectivePermissions } = props;
  const [assigning, setAssigning] = useState<string | null>(null); // userId
  const [roleId, setRoleId] = useState('');
  const [scopeType, setScopeType] = useState('branch');
  const [scopeId, setScopeId] = useState('');
  const [positionsByUser, setPositionsByUser] = useState<Record<string, UserPositionRow[]>>({});
  const [effective, setEffective] = useState<Record<string, EffectivePerm[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshUser = useCallback(async (userId: string) => {
    try {
      const [pos, perms] = await Promise.all([listUserPositions(userId), viewEffectivePermissions(userId)]);
      setPositionsByUser((prev) => ({ ...prev, [userId]: pos }));
      setEffective((prev) => ({ ...prev, [userId]: perms }));
    } catch { /* keep previous */ }
  }, [listUserPositions, viewEffectivePermissions]);

  useEffect(() => {
    // Fetch position/effective-permission data for every listed user without
    // synchronous state updates inside the effect (React 19 lint rule).
    void (async () => {
      for (const u of users) await refreshUser(u.id);
    })();
  }, [users, refreshUser]);

  const handleAssign = async (e: React.FormEvent, userId: string) => {
    e.preventDefault();
    if (!roleId) { setError('Choose a position.'); return; }
    setBusy(true); setError(null);
    try {
      await assignUserPosition(userId, {
        roleId,
        scopeType,
        scopeId: scopeType === 'branch' ? (scopeId || null) : scopeType === 'campus' ? (scopeId || null) : null,
      });
      setAssigning(null); setRoleId(''); setScopeId('');
      await refreshUser(userId);
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not assign the position.');
    } finally { setBusy(false); }
  };

  const handleRemove = async (userId: string, assignmentId: string) => {
    setBusy(true); setError(null);
    try {
      await removeUserPosition(userId, assignmentId);
      await refreshUser(userId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove the position.');
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-extrabold text-slate-900 flex items-center gap-1.5"><ShieldCheck className="w-5 h-5 text-indigo-600" /> User positions &amp; effective access</h3>
          <p className="text-[10px] text-slate-400 mt-0.5">A user may hold several positions; permissions combine and scope never expands beyond the assigned campus/branch.</p>
        </div>
      </div>

      {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-[11px] font-semibold text-rose-700" role="alert">{error}</div>}

      <div className="space-y-2">
        {users.map((u) => {
          const pos = positionsByUser[u.id] || [];
          const perms = effective[u.id] || [];
          return (
            <div key={u.id} className="bg-white border border-slate-200 rounded-2xl p-4 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-extrabold text-slate-800">{u.fullName}</span>
                  <span className="font-mono text-[9px] text-slate-400 ml-2">{u.username}</span>
                  {!u.isActive && <span className="text-[9px] bg-rose-100 text-rose-600 px-1.5 py-0.5 rounded font-bold ml-1">Inactive</span>}
                </div>
                <button onClick={() => setAssigning(assigning === u.id ? null : u.id)} className="text-[11px] font-bold text-indigo-600 hover:text-indigo-800 cursor-pointer bg-indigo-50 px-3 py-1.5 rounded-lg flex items-center gap-1">
                  <UserPlus className="w-3.5 h-3.5" /> {assigning === u.id ? 'Cancel' : 'Assign position'}
                </button>
              </div>

              <div className="mt-2 flex flex-wrap gap-1.5">
                {pos.length === 0 && <span className="text-[10px] text-slate-400 italic">No positions assigned.</span>}
                {pos.map((p) => (
                  <span key={p.id} className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-bold ${p.isPrimary ? 'bg-slate-900 text-white' : 'bg-indigo-50 text-indigo-700'}`}>
                    {p.roleName}
                    {!p.isPrimary && p.scopeType !== 'branch' && <span className="opacity-70">{p.scopeType}</span>}
                    {!p.isPrimary && (
                      <button onClick={() => void handleRemove(u.id, p.id)} disabled={busy} className="hover:text-rose-500 cursor-pointer disabled:opacity-40" title="Remove position">
                        <X className="w-3 h-3" />
                      </button>
                    )}
                  </span>
                ))}
              </div>

              {perms.length > 0 && (
                <details className="mt-2">
                  <summary className="text-[10px] font-bold text-slate-500 cursor-pointer hover:text-indigo-600 inline-flex items-center gap-1">
                    <Eye className="w-3 h-3" /> Effective permissions ({perms.length})
                  </summary>
                  <div className="mt-1.5 max-h-40 overflow-y-auto border border-slate-100 rounded-xl p-2 flex flex-wrap gap-1">
                    {perms.map((p) => (
                      <span key={p.code} className="font-mono text-[9px] bg-slate-50 border border-slate-100 px-1.5 py-0.5 rounded text-slate-600">{p.code}<span className="text-slate-400">:{p.scope}</span></span>
                    ))}
                  </div>
                </details>
              )}

              {assigning === u.id && (
                <form onSubmit={(e) => void handleAssign(e, u.id)} className="mt-3 bg-slate-50/60 border border-slate-200 rounded-xl p-3 grid grid-cols-1 sm:grid-cols-4 gap-2">
                  <div className="space-y-1">
                    <label className="text-[9px] font-bold text-slate-400 uppercase">Position</label>
                    <select value={roleId} onChange={(e) => setRoleId(e.target.value)} className="w-full bg-white border border-slate-200 rounded-lg px-2 py-1.5">
                      <option value="">Choose…</option>
                      {positions.filter((p) => p.isActive).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[9px] font-bold text-slate-400 uppercase">Scope</label>
                    <select value={scopeType} onChange={(e) => { setScopeType(e.target.value); setScopeId(''); }} className="w-full bg-white border border-slate-200 rounded-lg px-2 py-1.5">
                      <option value="branch">Branch</option>
                      <option value="campus">Campus</option>
                      <option value="organization">Organization</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[9px] font-bold text-slate-400 uppercase">{scopeType === 'campus' ? 'Campus' : scopeType === 'branch' ? 'Branch' : '—'}</label>
                    {scopeType === 'campus' ? (
                      <select value={scopeId} onChange={(e) => setScopeId(e.target.value)} className="w-full bg-white border border-slate-200 rounded-lg px-2 py-1.5">
                        <option value="">Choose…</option>
                        {campuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    ) : scopeType === 'branch' ? (
                      <select value={scopeId} onChange={(e) => setScopeId(e.target.value)} className="w-full bg-white border border-slate-200 rounded-lg px-2 py-1.5">
                        <option value="">Choose…</option>
                        {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                      </select>
                    ) : <div className="text-[9px] text-slate-400 pt-2">Whole organization</div>}
                  </div>
                  <div className="flex items-end">
                    <button type="submit" disabled={busy} className="w-full px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-bold text-[11px] disabled:opacity-50">Assign</button>
                  </div>
                </form>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
