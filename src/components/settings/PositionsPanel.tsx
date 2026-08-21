/**
 * Positions & Access — position lifecycle (owner-only).
 * Data-driven positions: list, create, rename, describe, activate/deactivate
 * and edit the permission set (per-permission scope). Deactivating a position
 * immediately stops it from contributing permissions to every assigned user
 * (enforced server-side at request time).
 */
import { control, text } from '../../design-system/styles';
import React, { useEffect, useState, useCallback } from 'react';
import { Plus, Pencil, Power, X, Check, ShieldCheck, ChevronDown, ChevronRight } from 'lucide-react';

export interface PositionRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  isActive: boolean;
  permissions: { permissionId: string; code: string; resource: string; action: string; description: string; scope: string }[];
}
export interface PermissionDef {
  id: string;
  code: string;
  resource: string;
  action: string;
  description: string;
  category: string;
}

interface Props {
  positions: PositionRow[];
  permissionCatalog: PermissionDef[];
  load: () => Promise<void>;
  createPosition: (params: { name: string; description?: string; permissions?: { permissionId: string; scope?: string }[] }) => Promise<unknown>;
  updatePosition: (roleId: string, updates: { name?: string; description?: string; isActive?: boolean }) => Promise<void>;
  updatePositionPermissions: (roleId: string, permissions: { permissionId: string; scope?: string }[]) => Promise<void>;
  canEdit: boolean;
}

const SCOPE_OPTIONS = ['organization', 'campus', 'branch', 'department', 'program', 'class', 'own'];

export default function PositionsPanel(props: Props) {
  const { positions, permissionCatalog, load, createPosition, updatePosition, updatePositionPermissions, canEdit } = props;
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<PositionRow | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [selectedPerms, setSelectedPerms] = useState<Map<string, string>>(new Map()); // permissionId -> scope
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => { void load(); }, [load]);

  const byCategory = useCallback(() => {
    const map = new Map<string, PermissionDef[]>();
    for (const p of permissionCatalog) {
      if (!map.has(p.category)) map.set(p.category, []);
      map.get(p.category)!.push(p);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [permissionCatalog]);

  const openCreate = () => { setCreating(true); setName(''); setDescription(''); setSelectedPerms(new Map()); setError(null); };
  const openEdit = (p: PositionRow) => {
    setEditing(p);
    setEditName(p.name);
    setEditDescription(p.description || '');
    setSelectedPerms(new Map(p.permissions.map((permission) => [permission.permissionId, permission.scope])));
    setError(null);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError('Position name is required.'); return; }
    setBusy(true); setError(null);
    try {
      await createPosition({
        name: name.trim(),
        description: description.trim() || undefined,
        permissions: Array.from(selectedPerms.entries()).map(([permissionId, scope]) => ({ permissionId, scope })),
      });
      setCreating(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the position.');
    } finally { setBusy(false); }
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setBusy(true); setError(null);
    try {
      if (editName.trim() && editName.trim() !== editing.name) await updatePosition(editing.id, { name: editName.trim() });
      await updatePositionPermissions(editing.id, Array.from(selectedPerms.entries()).map(([permissionId, scope]) => ({ permissionId, scope })));
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the position.');
    } finally { setBusy(false); }
  };

  const toggleActive = async (p: PositionRow) => {
    setBusy(true); setError(null);
    try {
      await updatePosition(p.id, { isActive: !p.isActive });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the position.');
    } finally { setBusy(false); }
  };

  const togglePerm = (perm: PermissionDef) => {
    setSelectedPerms((prev) => {
      const next = new Map(prev);
      if (next.has(perm.id)) next.delete(perm.id);
      else next.set(perm.id, 'branch');
      return next;
    });
  };
  const setPermScope = (permId: string, scope: string) => {
    setSelectedPerms((prev) => { const next = new Map(prev); next.set(permId, scope); return next; });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-extrabold text-slate-900 flex items-center gap-1.5"><ShieldCheck className="w-5 h-5 text-indigo-600" /> Positions</h3>
          <p className="text-[10px] text-slate-400 mt-0.5">Data-driven positions with permission sets and scopes. Deactivating a position removes its permissions immediately.</p>
        </div>
        {canEdit && <button onClick={openCreate} className="flex items-center gap-1 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs px-3.5 py-2 rounded-xl cursor-pointer shadow-sm">
          <Plus className="w-4 h-4" /> New position
        </button>}
      </div>

      {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-[11px] font-semibold text-rose-700" role="alert">{error}</div>}

      {creating && (
        <form onSubmit={handleCreate} className="bg-slate-50/60 border border-slate-200 rounded-2xl p-4 space-y-3 text-xs">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="block text-slate-600 font-bold">Position name:</label>
              <input value={name} onChange={(e) => setName(e.target.value)} className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2" placeholder="e.g. Book Officer, Female Receptionist" required />
            </div>
            <div className="space-y-1">
              <label className="block text-slate-600 font-bold">Description:</label>
              <input value={description} onChange={(e) => setDescription(e.target.value)} className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2" placeholder="What this position is responsible for" />
            </div>
          </div>
          <div className="pt-2 border-t border-slate-100">
            <div className="flex items-center justify-between mb-2">
              <span className="text-slate-600 font-bold">Permissions</span>
              <span className={text.meta}>{selectedPerms.size} selected</span>
            </div>
            <div className="max-h-64 overflow-y-auto space-y-2 pe-1">
              {byCategory().map(([cat, perms]) => (
                <div key={cat} className="border border-slate-100 rounded-xl bg-white">
                  <button type="button" onClick={() => setExpanded((s) => ({ ...s, [`new:${cat}`]: !s[`new:${cat}`] }))} className="w-full flex items-center justify-between px-3 py-2 text-[10px] font-black text-slate-500 uppercase tracking-wide cursor-pointer">
                    <span>{cat}</span>
                    {expanded[`new:${cat}`] ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  </button>
                  {expanded[`new:${cat}`] && (
                    <div className="px-3 pb-2 space-y-1">
                      {perms.map((perm) => (
                        <div key={perm.id} className="flex items-center justify-between gap-2">
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input type="checkbox" checked={selectedPerms.has(perm.id)} onChange={() => togglePerm(perm)} className="accent-indigo-600" />
                            <span className="font-mono text-[10px] text-slate-700">{perm.code}</span>
                          </label>
                          {selectedPerms.has(perm.id) && (
                            <select value={selectedPerms.get(perm.id)} onChange={(e) => setPermScope(perm.id, e.target.value)} className="bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5 text-[10px]">
                              {SCOPE_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                            </select>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className="flex gap-2 justify-end pt-2 border-t border-slate-100">
            <button type="button" onClick={() => setCreating(false)} className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg font-bold">Cancel</button>
            <button type="submit" disabled={busy} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-bold disabled:opacity-50">{busy ? 'Creating…' : 'Create position'}</button>
          </div>
        </form>
      )}

      <div className="space-y-2">
        {positions.map((p) => (
          <div key={p.id} className="bg-white border border-slate-200 rounded-2xl p-4 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <span className={`w-2 h-2 rounded-full ${p.isActive ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                <span className="font-extrabold text-slate-800">{p.name}</span>
                <span className="font-mono text-[9px] text-slate-400">{p.code}</span>
                {p.isSystem ? <span className="text-[9px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded font-bold">system</span> : <span className="text-[9px] bg-indigo-50 text-indigo-600 px-1.5 py-0.5 rounded font-bold">custom</span>}
                {!p.isActive && <span className="text-[9px] bg-rose-100 text-rose-600 px-1.5 py-0.5 rounded font-bold">Inactive</span>}
              </div>
              <div className="flex items-center gap-1.5">
                <span className={text.meta}>{p.permissions.length} permissions</span>
                {canEdit && <button onClick={() => openEdit(p)} className="text-indigo-600 hover:text-indigo-800 cursor-pointer p-1.5" title="Edit position & permissions"><Pencil className="w-3.5 h-3.5" /></button>}
                {canEdit && <button onClick={() => void toggleActive(p)} disabled={busy} className={`p-1.5 rounded-lg cursor-pointer disabled:opacity-40 ${p.isActive ? 'text-rose-500 hover:bg-rose-50' : 'text-emerald-600 hover:bg-emerald-50'}`} title={p.isActive ? 'Deactivate' : 'Activate'}>
                  <Power className="w-3.5 h-3.5" />
                </button>}
              </div>
            </div>
            {p.description && <p className="text-[10px] text-slate-400 mt-1">{p.description}</p>}
          </div>
        ))}
      </div>

      {editing && (
        <form onSubmit={handleSaveEdit} className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xl w-full max-w-2xl text-xs space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-start border-b border-slate-100 pb-2.5">
              <div>
                <h3 className="font-extrabold text-slate-900 text-sm">Edit position — {editing.name}</h3>
                <p className="text-[10px] text-slate-400 mt-0.5">Permissions are enforced server-side at request time.</p>
              </div>
              <button type="button" onClick={() => setEditing(null)} className="text-slate-400 hover:text-slate-600 cursor-pointer"><X className="w-4 h-4" /></button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="block text-slate-600 font-bold">Name:</label>
                <input value={editName} onChange={(e) => setEditName(e.target.value)} className={control.input} required />
              </div>
              <div className="space-y-1">
                <label className="block text-slate-600 font-bold">Description:</label>
                <input value={editDescription} onChange={(e) => setEditDescription(e.target.value)} className={control.input} />
              </div>
            </div>
            <div className="border-t border-slate-100 pt-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-slate-600 font-bold">Permissions</span>
                <span className={text.meta}>{selectedPerms.size} selected</span>
              </div>
              <div className="max-h-64 overflow-y-auto space-y-2 pe-1">
                {byCategory().map(([cat, perms]) => (
                  <div key={cat} className="border border-slate-100 rounded-xl bg-white">
                    <button type="button" onClick={() => setExpanded((s) => ({ ...s, [`edit:${cat}`]: !s[`edit:${cat}`] }))} className="w-full flex items-center justify-between px-3 py-2 text-[10px] font-black text-slate-500 uppercase tracking-wide cursor-pointer">
                      <span>{cat}</span>
                      {expanded[`edit:${cat}`] ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                    </button>
                    {expanded[`edit:${cat}`] && (
                      <div className="px-3 pb-2 space-y-1">
                        {perms.map((perm) => (
                          <div key={perm.id} className="flex items-center justify-between gap-2">
                            <label className="flex items-center gap-2 cursor-pointer">
                              <input type="checkbox" checked={selectedPerms.has(perm.id)} onChange={() => togglePerm(perm)} className="accent-indigo-600" />
                              <span className="font-mono text-[10px] text-slate-700">{perm.code}</span>
                            </label>
                            {selectedPerms.has(perm.id) && (
                              <select value={selectedPerms.get(perm.id)} onChange={(e) => setPermScope(perm.id, e.target.value)} className="bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5 text-[10px]">
                                {SCOPE_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                              </select>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <div className="flex gap-2 justify-end pt-2 border-t border-slate-100">
              <button type="button" onClick={() => setEditing(null)} className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg font-bold">Cancel</button>
              <button type="submit" disabled={busy} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-bold flex items-center gap-1 disabled:opacity-50"><Check className="w-3.5 h-3.5" /> {busy ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}
