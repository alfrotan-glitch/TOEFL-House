/**
 * Class Generation Wizard
 * Delivery is generated from a Course Offering, not from a second copy of
 * curriculum/finance settings. Room capacity is the authoritative class-seat
 * capacity; the offering fee is the authoritative enrollment fee snapshot.
 */
import { text } from '../../design-system/styles';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Wand2, RefreshCw, Check, AlertCircle, Layers, Play, Loader2, X, Info, DoorOpen, Clock, Users, DollarSign } from 'lucide-react';
import { api } from '../../api/client';
import { useInvalidate } from '../../state/serverStateFreshness';
import { formatAFN } from '../../utils/format';

interface Offering {
  id: string;
  name: string;
  code?: string | null;
  status: string;
  programName?: string | null;
  versionLabel?: string | null;
  levelName?: string | null;
  academicTermId?: string | null;
  termName?: string | null;
  branchId: string;
  capacityTotal: number;
  feeSnapshot: number;
  classCount: number;
  enrolledCount: number;
}
interface PreviewItem {
  levelId: string;
  levelName: string;
  timeSlotId: string | null;
  timeSlotLabel?: string | null;
  roomId: string | null;
  roomName?: string | null;
  roomCapacity?: number | null;
  capacity: number;
  minViableSize: number;
  fee: number;
  proposedName: string;
  genderPolicy?: 'female' | 'male' | 'mixed';
}
interface GenerationRun { id: string; status: string; branch_id: string; academic_term_id?: string | null; program_version_id: string; created_at: string; published_at?: string | null; }
interface RunItem { id: string; level_name: string; proposed_name: string; capacity: number; fee: number; status: string; class_id?: string | null; error_message?: string | null; room_id?: string | null; time_slot_id?: string | null; gender_policy?: string; }
interface RunResponse { run: GenerationRun; items: RunItem[]; }

const inputCls = 'w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 transition-all';
const labelCls = 'block text-[10px] font-extrabold text-slate-500 uppercase tracking-wider mb-1.5';

export default function ClassGenerationWizard({ branchId }: { branchId?: string }) {
  const invalidate = useInvalidate();
  const [offerings, setOfferings] = useState<Offering[]>([]);
  const [offeringId, setOfferingId] = useState('');
  const [genderPolicy, setGenderPolicy] = useState<'female' | 'male' | 'mixed'>('mixed');
  const [splitByGender, setSplitByGender] = useState(false);
  const [preview, setPreview] = useState<{ items: PreviewItem[]; levelCount: number; slotCount: number } | null>(null);
  const [run, setRun] = useState<RunResponse | null>(null);
  const [loadingInit, setLoadingInit] = useState(true);
  const [busy, setBusy] = useState<'preview' | 'draft' | 'publish' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [showPublishModal, setShowPublishModal] = useState(false);

  const loadInitialData = useCallback(async () => {
    if (!branchId) return;
    setLoadingInit(true);
    setError(null);
    try {
      const data = await api.get<Offering[]>(`/offerings?branchId=${encodeURIComponent(branchId)}`);
      const list = Array.isArray(data) ? data : [];
      const eligible = list.filter((o) => ['draft', 'open'].includes(o.status));
      setOfferings(eligible);
      setOfferingId((current) => eligible.some((o) => o.id === current) ? current : (eligible[0]?.id || ''));
    } catch (err: unknown) {
      setOfferings([]);
      setError(err instanceof Error ? err.message : 'Failed to load course offerings');
    } finally {
      setLoadingInit(false);
    }
  }, [branchId]);

  useEffect(() => { void (async () => { await loadInitialData(); })(); }, [loadInitialData]);

  const selectedOffering = useMemo(() => offerings.find((o) => o.id === offeringId) ?? null, [offerings, offeringId]);

  const doPreview = async () => {
    if (!branchId || !selectedOffering) {
      setError('Create or select a Course Offering first. Class generation uses the offering as the single source of truth.');
      return;
    }
    setBusy('preview'); setError(null); setMsg(null); setRun(null);
    try {
      const res = await api.post<{ items?: PreviewItem[]; levelCount?: number; slotCount?: number }>('/catalog/class-generation/preview', {
        branchId,
        offeringId: selectedOffering.id,
        genderPolicy,
        splitByGender,
      });
      const normalized = {
        items: Array.isArray(res?.items) ? res.items : [],
        levelCount: Number(res?.levelCount ?? 0),
        slotCount: Number(res?.slotCount ?? 0),
      };
      setPreview(normalized);
      if (!normalized.items.length) throw new Error('No classes can be generated from this offering. Check active time slots and rooms.');
      setMsg(`Preview ready: ${normalized.items.length} class section${normalized.items.length === 1 ? '' : 's'} using ${normalized.slotCount} time slot${normalized.slotCount === 1 ? '' : 's'} and room capacity.`);
    } catch (err: unknown) {
      setPreview(null);
      setError(err instanceof Error ? err.message : 'Preview failed');
    } finally { setBusy(null); }
  };

  const doDraft = async () => {
    if (!branchId || !selectedOffering) return setError('Select a Course Offering first.');
    setBusy('draft'); setError(null);
    try {
      const res = await api.post<RunResponse>('/catalog/class-generation/drafts', {
        branchId,
        offeringId: selectedOffering.id,
        genderPolicy,
        splitByGender,
      });
      const normalized: RunResponse = { run: res?.run, items: Array.isArray(res?.items) ? res.items : [] };
      setRun(normalized);
      setPreview(null);
      // A draft run persists class-generation rows server-side.
      invalidate('classes');
      setMsg(`Draft saved successfully: ${normalized.items.length} class section${normalized.items.length === 1 ? '' : 's'}. Review the room/slot allocation before publishing.`);
    } catch (err: unknown) { setError(err instanceof Error ? err.message : 'Draft creation failed'); }
    finally { setBusy(null); }
  };

  const doPublish = async () => {
    if (!run?.run?.id) return;
    setShowPublishModal(false); setBusy('publish'); setError(null);
    try {
      const res = await api.post<RunResponse>(`/catalog/class-generation/${run.run.id}/publish`, {});
      const items = Array.isArray(res?.items) ? res.items : [];
      setRun({ run: res?.run, items });
      const createdCount = items.filter((i) => i.status === 'created').length;
      // Publishing creates live classes, which the classes/sessions/attendance
      // views all render.
      invalidate('classes');
      setMsg(`Published successfully: ${createdCount} live class section${createdCount === 1 ? '' : 's'} created.`);
      await loadInitialData();
    } catch (err: unknown) { setError(err instanceof Error ? err.message : 'Publish failed'); }
    finally { setBusy(null); }
  };

  if (!branchId) return <div className="text-center py-14 bg-slate-50 rounded-2xl border border-dashed border-slate-200"><Layers className="w-8 h-8 text-slate-300 mx-auto mb-2" /><p className="text-sm text-slate-500 font-semibold">Select a branch before generating classes.</p></div>;
  if (loadingInit) return <div className="flex flex-col items-center justify-center py-20 text-slate-400 gap-3"><Loader2 className="w-8 h-8 animate-spin text-indigo-500" /><span className="text-xs font-semibold uppercase tracking-wide">Loading Course Offerings…</span></div>;

  return (
    <div className="space-y-5">
      <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex items-start gap-4">
        <div className="p-3 rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 text-white shadow-lg shadow-violet-200"><Wand2 className="w-6 h-6" /></div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2"><h3 className="text-base font-extrabold text-slate-900">Generate Class Sections</h3><span className="text-[10px] px-2 py-1 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-100 font-bold">Phase 4</span></div>
          <p className={text.hint}>A class section inherits its fee from the Course Offering and its seat capacity from the assigned physical room. No duplicate financial or capacity entry is required here.</p>
        </div>
      </div>

      {error && <div className="flex items-start gap-2 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3"><AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /><span className="flex-1">{error}</span><button type="button" onClick={() => setError(null)} className="font-bold underline">Dismiss</button></div>}
      {msg && <div className="flex items-start gap-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3"><Check className="w-4 h-4 shrink-0 mt-0.5" /><span>{msg}</span></div>}

      <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
        <div className="flex items-center gap-2 mb-4"><Info className="w-4 h-4 text-indigo-500" /><h4 className="text-xs font-extrabold text-slate-700 uppercase tracking-wider">1. Select the Course Offering</h4></div>
        {offerings.length === 0 ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-800"><p className="font-bold">No eligible Course Offering exists yet.</p><p className="text-xs mt-1">Create the offering in Phase 3 first. Its fee is inherited from the selected curriculum level.</p></div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2"><label className={labelCls}>Course Offering *</label><select value={offeringId} onChange={(e) => { setOfferingId(e.target.value); setPreview(null); setRun(null); setMsg(null); }} className={inputCls}><option value="">Select offering…</option>{offerings.map((o) => <option key={o.id} value={o.id}>{o.name} — {o.levelName || 'Level'} — {o.termName || 'Term'}</option>)}</select></div>
            <div><label className={labelCls}>Status</label><div className="h-[42px] rounded-xl bg-slate-50 border border-slate-200 px-3 flex items-center text-sm font-bold text-slate-700">{selectedOffering?.status || '—'}</div></div>
          </div>
        )}

        {selectedOffering && <div className="mt-5 grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="rounded-xl border border-indigo-100 bg-indigo-50/60 px-3 py-3"><div className="text-[10px] font-bold uppercase text-indigo-500">Program</div><div className="text-sm font-extrabold text-slate-800 break-words mt-1">{selectedOffering.programName || '—'}</div></div>
          <div className="rounded-xl border border-sky-100 bg-sky-50/60 px-3 py-3"><div className="text-[10px] font-bold uppercase text-sky-500">Level</div><div className="text-sm font-extrabold text-slate-800 break-words mt-1">{selectedOffering.levelName || '—'}</div></div>
          <div className="rounded-xl border border-amber-100 bg-amber-50/60 px-3 py-3"><div className="text-[10px] font-bold uppercase text-amber-600 flex items-center gap-1"><DollarSign className="w-3 h-3" /> Fee Snapshot</div><div className="text-sm font-extrabold text-slate-800 mt-1">{formatAFN(selectedOffering.feeSnapshot)}</div></div>
          <div className="rounded-xl border border-emerald-100 bg-emerald-50/60 px-3 py-3"><div className="text-[10px] font-bold uppercase text-emerald-600 flex items-center gap-1"><Users className="w-3 h-3" /> Planned Capacity</div><div className="text-sm font-extrabold text-slate-800 mt-1">{selectedOffering.capacityTotal || 0} seats <span className="text-[10px] font-semibold text-slate-400">(derived)</span></div></div>
        </div>}
      </div>

      <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
        <div className="flex items-center gap-2 mb-4"><Layers className="w-4 h-4 text-indigo-500" /><h4 className="text-xs font-extrabold text-slate-700 uppercase tracking-wider">2. Delivery Policy</h4></div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div><label className={labelCls}>Gender Policy</label><select value={genderPolicy} disabled={splitByGender} onChange={(e) => setGenderPolicy(e.target.value as any)} className={`${inputCls} disabled:bg-slate-50`}><option value="mixed">Mixed</option><option value="female">Female only</option><option value="male">Male only</option></select></div>
          <div className="md:col-span-2 flex items-center gap-3 bg-slate-50 rounded-xl border border-slate-200 px-4 py-3"><input type="checkbox" id="splitGender" checked={splitByGender} onChange={(e) => setSplitByGender(e.target.checked)} className="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500" /><label htmlFor="splitGender" className="text-xs font-bold text-slate-700 cursor-pointer">Generate separate Female + Male sections for each level/time slot</label></div>
        </div>
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3 text-xs text-slate-500">
          <div className="flex items-center gap-2 rounded-xl bg-slate-50 border border-slate-100 p-3"><DoorOpen className="w-4 h-4 text-slate-400" /><span>Room capacity is authoritative; each generated class cannot exceed its assigned room.</span></div>
          <div className="flex items-center gap-2 rounded-xl bg-slate-50 border border-slate-100 p-3"><Clock className="w-4 h-4 text-slate-400" /><span>Active time slots and rooms configured in Phase 1 are used automatically.</span></div>
        </div>
      </div>

      <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200">
        <div className="flex flex-wrap gap-3">
          <button type="button" disabled={busy !== null || !selectedOffering} onClick={doPreview} className="flex-1 min-w-[190px] flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-xs font-bold bg-white border border-slate-300 text-slate-700 disabled:opacity-40 hover:bg-slate-100"><RefreshCw className={`w-4 h-4 ${busy === 'preview' ? 'animate-spin' : ''}`} /> 1. Preview Plan</button>
          <button type="button" disabled={busy !== null || !selectedOffering || !preview?.items?.length} onClick={doDraft} className="flex-1 min-w-[190px] flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-xs font-bold bg-indigo-600 text-white disabled:opacity-40 hover:bg-indigo-700"><Layers className="w-4 h-4" /> 2. Save Draft</button>
          <button type="button" disabled={busy !== null || !run?.run?.id || run.run.status === 'published'} onClick={() => setShowPublishModal(true)} className="flex-1 min-w-[190px] flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-xs font-bold bg-emerald-600 text-white disabled:opacity-40 hover:bg-emerald-700"><Play className="w-4 h-4" /> 3. Publish Classes</button>
        </div>
      </div>

      {preview && <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden"><div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between"><div><h4 className={text.value}>Preview Allocation</h4><p className="text-xs text-slate-500 mt-0.5">{preview.items.length} section(s) · {preview.slotCount} active slot(s)</p></div></div><div className="divide-y divide-slate-100">{preview.items.map((item, idx) => <div key={`${item.levelId}-${item.timeSlotId}-${item.genderPolicy}-${idx}`} className="px-5 py-4 grid grid-cols-1 md:grid-cols-5 gap-3 items-center"><div><div className="text-xs font-extrabold text-slate-800">{item.proposedName}</div><div className={text.meta}>{item.levelName}</div></div><div className="flex items-center gap-2 text-xs text-slate-600"><Clock className="w-3.5 h-3.5 text-slate-400" />{item.timeSlotLabel || 'Time slot'}</div><div className="flex items-center gap-2 text-xs text-slate-600"><DoorOpen className="w-3.5 h-3.5 text-slate-400" />{item.roomName || 'Room'}</div><div><div className="text-[10px] uppercase font-bold text-slate-400">Seats</div><div className="text-sm font-extrabold text-slate-800">{item.capacity}</div></div><div><div className="text-[10px] uppercase font-bold text-slate-400">Fee</div><div className="text-sm font-extrabold text-slate-800">{formatAFN(item.fee)}</div></div></div>)}</div></div>}

      {run && <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden"><div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between"><div><h4 className={text.value}>Draft Review</h4><p className="text-xs text-slate-500 mt-0.5">Publishing creates live class sections; failed rows are retained with their error.</p></div><span className="text-[10px] font-bold px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-100">{run.run?.status}</span></div><div className="divide-y divide-slate-100">{(run.items || []).map((item) => <div key={item.id} className="px-5 py-4 flex flex-wrap items-center gap-3"><div className="flex-1 min-w-[220px]"><div className="text-xs font-extrabold text-slate-800">{item.proposed_name}</div><div className="text-[10px] text-slate-500">{item.level_name}</div></div><div className="text-xs text-slate-600">{item.capacity} seats</div><div className="text-xs text-slate-600">{formatAFN(item.fee)}</div><span className={`text-[10px] font-bold px-2 py-1 rounded-full ${item.status === 'created' ? 'bg-emerald-50 text-emerald-700' : item.status === 'error' ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-700'}`}>{item.status}</span>{item.error_message && <span className="text-[10px] text-rose-600 max-w-md">{item.error_message}</span>}</div>)}</div></div>}

      {showPublishModal && <div className="fixed inset-0 z-[100] bg-slate-950/40 backdrop-blur-sm flex items-center justify-center p-4"><div className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-slate-200 p-6"><div className="flex items-start justify-between gap-3"><div><h4 className="text-lg font-extrabold text-slate-900">Publish Class Sections?</h4><p className={text.hint}>This will create live class records and update the offering's derived capacity.</p></div><button type="button" onClick={() => setShowPublishModal(false)} className="p-2 rounded-lg hover:bg-slate-100"><X className="w-4 h-4" /></button></div><div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setShowPublishModal(false)} className="px-4 py-2 rounded-xl bg-slate-100 text-slate-700 text-xs font-bold">Cancel</button><button type="button" onClick={doPublish} className="px-4 py-2 rounded-xl bg-emerald-600 text-white text-xs font-bold">Publish</button></div></div></div>}
    </div>
  );
}
