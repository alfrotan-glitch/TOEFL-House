/**
 * Course Offering Engine UI
 * One source of truth for delivery identity: program version + level + branch + term.
 * Fee is inherited from the selected level/branch; capacity is derived from generated rooms/classes.
 */
import { text } from '../../design-system/styles';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {Layers, Plus, RefreshCw, Link2, Archive, Check, Loader2, Users, DollarSign, X, AlertCircle} from 'lucide-react';
import {api} from '../../api/client';
import { useInvalidate } from '../../state/serverStateFreshness';
import {formatAFN} from '../../utils/format';

interface Offering { id: string; name: string; code?: string | null; status: string; programId?: string | null; programName?: string | null; programVersionId?: string | null; versionLabel?: string | null; levelId?: string | null; levelName?: string | null; academicTermId?: string | null; termName?: string | null; branchId: string; capacityTotal: number; feeSnapshot: number; classCount: number; enrolledCount: number; }
interface Program { id: string; name: string; }
interface ProgramVersion { id: string; programId: string; programName?: string; versionLabel: string; versionNumber: number; status: string; }
interface Level { id: string; name: string; programId?: string; programVersionId?: string | null; defaultFee?: number; }
interface Term { id: string; name: string; }
interface FeeRow { levelId: string; branchId?: string | null; fee: number; }
interface ClassRef { id: string; name: string; offeringId?: string | null; }

const inputCls = 'w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 transition-all';
const labelCls = 'block text-[10px] font-extrabold text-slate-500 uppercase tracking-wider mb-1.5';

export default function OfferingsPanel({ branchId, onChange }: { branchId?: string; onChange?: () => void }) {
  const invalidate = useInvalidate();
  const [items, setItems] = useState<Offering[]>([]);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [versions, setVersions] = useState<ProgramVersion[]>([]);
  const [levels, setLevels] = useState<Level[]>([]);
  const [terms, setTerms] = useState<Term[]>([]);
  const [fees, setFees] = useState<FeeRow[]>([]);
  const [classes, setClasses] = useState<ClassRef[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [linkOfferingId, setLinkOfferingId] = useState<string | null>(null);
  const [linkClassId, setLinkClassId] = useState('');
  const [form, setForm] = useState({ name: '', code: '', programId: '', programVersionId: '', levelId: '', academicTermId: '', status: 'draft' });

  const load = useCallback(async () => {
    if (!branchId) return;
    setLoading(true); setError('');
    const query = { branchId };
    try {
      const [offs, progs, vers, lvls, trms, feeRows, cls] = await Promise.all([
        api.get<Offering[]>('/offerings', query),
        api.get<Program[]>('/academic/programs', query),
        api.get<ProgramVersion[]>('/catalog/program-versions', query),
        api.get<Level[]>('/academic/levels', query),
        api.get<Term[]>('/academic/terms', query),
        api.get<FeeRow[]>('/academic/level-fees', query),
        api.get<ClassRef[]>('/classes', query),
      ]);
      setItems(Array.isArray(offs) ? offs : []);
      setPrograms(Array.isArray(progs) ? progs : []);
      setVersions(Array.isArray(vers) ? vers : []);
      setLevels(Array.isArray(lvls) ? lvls : []);
      setTerms(Array.isArray(trms) ? trms : []);
      setFees(Array.isArray(feeRows) ? feeRows : []);
      setClasses(Array.isArray(cls) ? cls : []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load offerings');
    } finally { setLoading(false); }
  }, [branchId]);
  useEffect(() => { void (async () => { await load(); })(); }, [load]);

  const filteredVersions = useMemo(() => versions.filter(v => !form.programId || v.programId === form.programId).filter(v => v.status !== 'archived'), [versions, form.programId]);
  const filteredLevels = useMemo(() => levels.filter(l =>
    (!form.programId || l.programId === form.programId) &&
    (!form.programVersionId || l.programVersionId === form.programVersionId),
  ), [levels, form.programId, form.programVersionId]);
  const selectedLevel = levels.find(l => l.id === form.levelId);
  const feeSnapshot = selectedLevel ? (fees.find(f => f.levelId === selectedLevel.id && (!f.branchId || f.branchId === branchId))?.fee ?? selectedLevel.defaultFee ?? 0) : 0;

  // Clear selections that point at no longer available options, by adjusting
  // state during render (no setState-in-effect). The key includes the
  // available option ids so invalid selections are cleared once the data
  // arrives, exactly like the previous effect.
  const [prevSelectionKey, setPrevSelectionKey] = useState('');
  const selectionKey = `${form.programVersionId ?? ''}|${form.levelId ?? ''}|${filteredVersions.map((v) => v.id).join(',')}|${filteredLevels.map((l) => l.id).join(',')}`;
  if (prevSelectionKey !== selectionKey) {
    setPrevSelectionKey(selectionKey);
    if (form.programVersionId && !filteredVersions.some(v => v.id === form.programVersionId)) setForm(f => ({ ...f, programVersionId: '', levelId: '' }));
    if (form.levelId && !filteredLevels.some(l => l.id === form.levelId)) setForm(f => ({ ...f, levelId: '' }));
  }

  const createOffering = async () => {
    if (!branchId || !form.name.trim() || !form.programId || !form.programVersionId || !form.levelId || !form.academicTermId) {
      setError('Program, version, level, term and offering name are required.'); return;
    }
    setActionLoading('create'); setError('');
    try {
      await api.post('/offerings', { ...form, branchId, code: form.code || null, status: form.status });
      // Offerings feed class creation and the academic catalog; see the dataset
      // dependency graph in apiStore.
      invalidate('offerings');
      onChange?.();
      setShowForm(false);
      setForm({ name: '', code: '', programId: '', programVersionId: '', levelId: '', academicTermId: '', status: 'draft' });
      await load();
    } catch (err: unknown) { setError(err instanceof Error ? err.message : 'Create failed'); }
    finally { setActionLoading(null); }
  };

  const setStatus = async (id: string, status: string) => { setActionLoading(`status-${id}`); try { await api.patch(`/offerings/${id}`, { status }); invalidate('offerings'); await load(); } catch (err: unknown) { setError(err instanceof Error ? err.message : 'Update failed'); } finally { setActionLoading(null); } };
  const linkClass = async () => { if (!linkOfferingId || !linkClassId) return; setActionLoading(`link-${linkOfferingId}`); try { await api.post(`/offerings/${linkOfferingId}/link-class`, { classId: linkClassId }); invalidate('offerings', 'classes'); setLinkOfferingId(null); setLinkClassId(''); await load(); } catch (err: unknown) { setError(err instanceof Error ? err.message : 'Link failed'); } finally { setActionLoading(null); } };

  if (!branchId) return <div className="text-center py-12 bg-slate-50 rounded-2xl border border-dashed border-slate-200"><Layers className="w-8 h-8 text-slate-300 mx-auto mb-2" /><p className="text-xs text-slate-400">Select a branch to manage course offerings.</p></div>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
        <div className="flex items-center gap-3"><div className="p-2 bg-indigo-50 rounded-xl"><Layers className="w-5 h-5 text-indigo-600" /></div><div><div className="flex items-center gap-2"><h3 className="text-base font-extrabold text-slate-900">Course Offerings</h3><span className="text-[10px] font-bold px-2 py-1 rounded-full bg-indigo-50 text-indigo-700">Phase 3</span></div><p className="text-[11px] text-slate-500 mt-1">Create the delivery instance first. Fee comes from the selected curriculum level; seat capacity is calculated later from physical rooms.</p></div></div>
        <div className="flex gap-2"><button type="button" onClick={load} className="inline-flex items-center gap-1 rounded-xl border border-slate-200 px-3 py-2 text-[11px] font-bold text-slate-600 hover:bg-slate-50">{loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Refresh</button><button type="button" onClick={() => setShowForm(true)} className="inline-flex items-center gap-1 rounded-xl bg-indigo-600 px-3 py-2 text-[11px] font-bold text-white hover:bg-indigo-700 shadow-sm"><Plus className="w-3.5 h-3.5" /> New Offering</button></div>
      </div>

      {error && <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-[11px] text-rose-700"><AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /><span className="flex-1">{error}</span><button onClick={() => setError('')} className="font-bold underline">Dismiss</button></div>}

      {loading ? <div className="flex flex-col items-center justify-center py-16 text-slate-400 bg-slate-50 rounded-2xl border border-dashed border-slate-200"><Loader2 className="w-8 h-8 animate-spin text-indigo-500 mb-3" /><p className="text-xs font-semibold uppercase tracking-wide">Loading Offerings…</p></div> : items.length === 0 ? <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 py-16 text-center"><Layers className="w-10 h-10 text-slate-300 mx-auto mb-3" /><p className="text-sm font-bold text-slate-600">No course offerings yet</p><p className="text-xs text-slate-400 mt-1">Complete the curriculum first, then create the delivery instance here.</p></div> : <div className="grid grid-cols-1 md:grid-cols-2 gap-5">{items.map(o => <div key={o.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm hover:shadow-md hover:border-indigo-200 transition-all flex flex-col">
        <div className="flex items-start justify-between gap-2 mb-4"><div className="min-w-0"><p className="text-sm font-extrabold text-slate-900 break-words">{o.name}</p><p className="text-[10px] font-mono text-slate-400 mt-0.5">{o.code || o.id}</p></div><span className={`shrink-0 text-[10px] font-bold px-2.5 py-1 rounded-full capitalize border ${o.status === 'open' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : o.status === 'draft' ? 'bg-slate-100 text-slate-600 border-slate-200' : 'bg-amber-50 text-amber-800 border-amber-200'}`}>{o.status}</span></div>
        <div className="grid grid-cols-2 gap-2 mb-4">{[['Program',o.programName],['Version',o.versionLabel],['Level',o.levelName],['Term',o.termName]].map(([label,value]) => <div key={label} className="rounded-lg bg-slate-50 border border-slate-100 px-3 py-2 min-w-0"><div className="text-[9px] uppercase font-bold text-slate-400">{label}</div><div className="text-[11px] font-bold text-slate-700 break-words mt-0.5">{value || '—'}</div></div>)}</div>
        <div className="grid grid-cols-3 gap-2 mb-5"><div className="flex flex-col bg-indigo-50/50 p-2.5 rounded-lg"><Layers className="w-3.5 h-3.5 text-indigo-500 mb-1" /><span className="text-[10px] font-bold text-slate-800">{o.classCount} Classes</span></div><div className="flex flex-col bg-emerald-50/50 p-2.5 rounded-lg"><Users className="w-3.5 h-3.5 text-emerald-500 mb-1" /><span className="text-[10px] font-bold text-slate-800">{o.capacityTotal || 0} Seats</span><span className="text-[8px] text-slate-400">derived from rooms</span></div><div className="flex flex-col bg-amber-50/50 p-2.5 rounded-lg"><DollarSign className="w-3.5 h-3.5 text-amber-500 mb-1" /><span className="text-[10px] font-bold text-slate-800">{formatAFN(o.feeSnapshot)}</span><span className="text-[8px] text-slate-400">curriculum snapshot</span></div></div>
        <div className="flex flex-wrap gap-2 mt-auto">{o.status !== 'open' && <button type="button" onClick={() => setStatus(o.id,'open')} disabled={actionLoading === `status-${o.id}`} className="inline-flex items-center gap-1 text-[10px] font-bold px-2.5 py-1.5 rounded-lg bg-emerald-50 text-emerald-700 hover:bg-emerald-100 disabled:opacity-50">{actionLoading === `status-${o.id}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Open</button>}{o.status === 'open' && <button type="button" onClick={() => setStatus(o.id,'closed')} disabled={actionLoading === `status-${o.id}`} className="text-[10px] font-bold px-2.5 py-1.5 rounded-lg bg-slate-100 text-slate-600 disabled:opacity-50">{actionLoading === `status-${o.id}` ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Close'}</button>}<button type="button" onClick={() => setStatus(o.id,'archived')} disabled={actionLoading === `status-${o.id}`} className="inline-flex items-center gap-1 text-[10px] font-bold px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-500 disabled:opacity-50"><Archive className="w-3 h-3" /> Archive</button><button type="button" onClick={() => { setLinkOfferingId(o.id); setLinkClassId(''); }} className="inline-flex items-center gap-1 text-[10px] font-bold px-2.5 py-1.5 rounded-lg bg-sky-50 text-sky-800"><Link2 className="w-3 h-3" /> Link Class</button></div>
        {linkOfferingId === o.id && <div className="mt-4 pt-4 border-t border-slate-100 flex gap-2 items-end"><div className="flex-1"><label className={labelCls}>Link Class Section</label><select value={linkClassId} onChange={e => setLinkClassId(e.target.value)} className={inputCls}><option value="">Select class…</option>{classes.filter(c => !c.offeringId || c.offeringId === o.id).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div><button type="button" onClick={linkClass} disabled={!linkClassId || actionLoading === `link-${o.id}`} className="rounded-xl bg-indigo-600 px-4 py-2.5 text-[11px] font-bold text-white disabled:opacity-50">Link</button><button type="button" onClick={() => setLinkOfferingId(null)} className="rounded-xl bg-slate-100 px-3 py-2.5 text-[11px] font-bold text-slate-600">Cancel</button></div>}
      </div>)}</div>}

      {showForm && <div className="fixed inset-0 z-[100] bg-slate-950/45 backdrop-blur-sm flex items-center justify-center p-4"><div className="w-full max-w-2xl bg-white rounded-3xl shadow-2xl border border-slate-200 overflow-hidden"><div className="px-6 py-5 border-b border-slate-100 flex items-start justify-between"><div><div className="flex items-center gap-2"><h3 className="text-lg font-extrabold text-slate-900">Create Course Offering</h3><span className="text-[10px] font-bold px-2 py-1 rounded-full bg-indigo-50 text-indigo-700">Phase 3</span></div><p className={text.hint}>Select the curriculum and term. Fee is inherited automatically; class capacity will come from physical rooms.</p></div><button type="button" onClick={() => setShowForm(false)} className="p-2 rounded-lg hover:bg-slate-100"><X className="w-5 h-5 text-slate-500" /></button></div><div className="p-6 space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4"><div><label className={labelCls}>Program *</label><select value={form.programId} onChange={e => setForm(f => ({ ...f, programId: e.target.value, programVersionId: '', levelId: '' }))} className={inputCls}><option value="">Select program…</option>{programs.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div><div><label className={labelCls}>Program Version *</label><select value={form.programVersionId} onChange={e => setForm(f => ({ ...f, programVersionId: e.target.value, levelId: '' }))} className={inputCls} disabled={!form.programId}><option value="">Select version…</option>{filteredVersions.map(v => <option key={v.id} value={v.id}>{v.versionLabel} · {v.status}</option>)}</select></div><div><label className={labelCls}>Level *</label><select value={form.levelId} onChange={e => setForm(f => ({ ...f, levelId: e.target.value }))} className={inputCls} disabled={!form.programVersionId}><option value="">Select level…</option>{filteredLevels.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div><div><label className={labelCls}>Academic Term *</label><select value={form.academicTermId} onChange={e => setForm(f => ({ ...f, academicTermId: e.target.value }))} className={inputCls}><option value="">Select term…</option>{terms.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div></div>
        {form.programVersionId && filteredLevels.length === 0 && <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">No level is assigned to this program version. Create a versioned level or explicitly attach an unversioned level in Programs &amp; Levels first.</div>}
        <div><label className={labelCls}>Offering Name *</label><input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className={inputCls} placeholder="e.g. General English — Fall 2026" /></div>
        <div><label className={labelCls}>Code</label><input value={form.code} onChange={e => setForm(f => ({ ...f, code: e.target.value }))} className={`${inputCls} font-mono`} placeholder="Optional" /></div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3"><div className="rounded-xl bg-amber-50 border border-amber-100 p-4"><div className="flex items-center gap-2 text-[10px] font-extrabold uppercase text-amber-700"><DollarSign className="w-3.5 h-3.5" /> Fee Snapshot</div><div className="text-lg font-extrabold text-slate-900 mt-1">{formatAFN(feeSnapshot)}</div><p className="text-[10px] text-slate-500 mt-1">Inherited from the selected level/branch. It is not manually duplicated here.</p></div><div className="rounded-xl bg-sky-50 border border-sky-100 p-4"><div className="flex items-center gap-2 text-[10px] font-extrabold uppercase text-sky-700"><Users className="w-3.5 h-3.5" /> Seat Capacity</div><div className="text-lg font-extrabold text-slate-900 mt-1">Calculated later</div><p className="text-[10px] text-slate-500 mt-1">Each generated section uses its physical room capacity; offering capacity is the sum of live sections.</p></div></div>
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100"><button type="button" onClick={() => setShowForm(false)} className="px-4 py-2.5 rounded-xl bg-slate-100 text-slate-700 text-xs font-bold">Cancel</button><button type="button" onClick={createOffering} disabled={actionLoading === 'create'} className="px-5 py-2.5 rounded-xl bg-indigo-600 text-white text-xs font-bold disabled:opacity-50">{actionLoading === 'create' ? 'Creating…' : 'Create Offering'}</button></div>
      </div></div></div>}
    </div>
  );
}
