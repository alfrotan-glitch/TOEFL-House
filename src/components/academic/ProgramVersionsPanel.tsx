import React, { useCallback, useEffect, useState } from 'react';
import {GitBranch, Plus, RefreshCw, Upload, AlertCircle, BookOpen, Loader2, Check, X, Layers, Filter, Zap, Trash2} from 'lucide-react';
import {api} from '../../api/client';

interface Program { id: string; name: string; isActive?: boolean; }
interface ProgramVersion {
  id: string; program_id: string; program_name?: string; version_label: string;
  version_number: number; status: string; is_default?: number; duration_months?: number; description?: string | null;
  /**
   * Lifecycle metadata. The API has always returned these (getVersionTree does
   * `SELECT pv.*`); they were simply absent from this interface and therefore
   * invisible in the UI. Optional because older rows may not have them set.
   */
  effective_from?: string | null;
  effective_to?: string | null;
  published_at?: string | null;
  created_by?: string | null;
  /** Resolved display name for created_by; the raw column holds a user id. */
  created_by_name?: string | null;
}
interface TreeLevel { id: string; name: string; code?: string; order?: number; default_fee?: number; }
interface PlacementRule { id: string; name: string; min_score: number; max_score: number; recommended_level_id?: string; }
interface PromotionRule { id: string; name: string; min_score: number; min_attendance_pct: number; from_level_id?: string; to_level_id?: string; }

interface VersionTree {
  version: ProgramVersion;
  levels: TreeLevel[];
  subjects: any[];
  promotionRules: PromotionRule[];
  placementRules: PlacementRule[];
}

const inputCls = "w-full text-xs border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 transition-all";
const labelCls = "block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1";

export default function ProgramVersionsPanel() {
  const [programs, setPrograms] = useState<Program[]>([]);
  const [versions, setVersions] = useState<ProgramVersion[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tree, setTree] = useState<VersionTree | null>(null);
  
  const [loadingInit, setLoadingInit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [showPublishModal, setShowPublishModal] = useState(false);

  const [newProgramId, setNewProgramId] = useState('');
  const [newLabel, setNewLabel] = useState('v1');
  const [copyFrom, setCopyFrom] = useState('');

  const [promoForm, setPromoForm] = useState({ name: 'Default Pass Criteria', minScore: 60, minAttendancePct: 75, fromLevelId: '', toLevelId: '' });
  const [placeForm, setPlaceForm] = useState({ name: 'Placement Band', minScore: 0, maxScore: 40, recommendedLevelId: '' });
  // Value slot skipped on purpose: only the setter is used (loadTree writes
  // the placement profile). `const [setPlacementProfile] = ...` would bind the
  // state VALUE to this name and calling it throws 'not a function'.
  const [, setPlacementProfile] = useState<any>(null);
  const [testBankTests, setTestBankTests] = useState<any[]>([]);
  const [placementConfig, setPlacementConfig] = useState<any>({ enabled: true, required: false, requirementMode: 'not_required', firstLevelExempt: false, expiresMinutes: null, decisionRules: [], components: [{ key:'skill_scores', type:'skill_scores', label:'Skills Assessment', required:true, weight:100, maxScore:100, durationMinutes:30, skills:['grammar','vocabulary','reading','listening','writing','speaking'], instructions:'Score each skill using the examiner rubric.' }], scoringModel:'weighted_average', allowRetake:true, maxScore:100, passScore:60, instructions:'' });

  const loadInitialData = useCallback(async () => {
    setLoadingInit(true);
    setError(null);
    try {
      const [progs, vers, bankTests] = await Promise.all([
        api.get<Program[]>('/academic/programs'),
        api.get<ProgramVersion[]>('/catalog/program-versions'),
        api.get<any[]>('/placement/test-bank').catch(() => []),
      ]);
      setPrograms(progs || []);
      setVersions(vers || []);
      setTestBankTests(bankTests || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load versions');
    } finally {
      setLoadingInit(false);
    }
  }, []);

  const loadTree = useCallback(async (id: string) => {
    setBusy(true); setError(null);
    try {
      const t = await api.get<VersionTree>(`/catalog/program-versions/${id}`);
      setTree(t); setSelectedId(id);
      try { const pp = await api.get<any>(`/academic/program-versions/${id}/placement-profile`); setPlacementProfile(pp); setPlacementConfig({ enabled: pp.enabled !== false, required: !!pp.required, requirementMode: pp.requirementMode || (pp.required ? 'required' : 'not_required'), firstLevelExempt: !!pp.firstLevelExempt, expiresMinutes: pp.expiresMinutes ?? null, decisionRules: pp.decisionRules || [], method: pp.method || 'skill_scores', components: pp.components || [], scoringModel: pp.scoringModel || 'weighted_average', allowRetake: pp.allowRetake !== false, maxScore: pp.maxScore || 100, passScore: pp.passScore || 60, instructions: pp.instructions || '' }); } catch { setPlacementProfile(null); }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load version tree'); 
      setTree(null);
    } finally { setBusy(false); }
  }, [setPlacementProfile]);

  useEffect(() => { void (async () => { await loadInitialData(); })(); }, [loadInitialData]);

  const handleApiCall = async (fn: () => Promise<void>, successMsg: string) => {
    setBusy(true); setError(null);
    try {
      await fn();
      setMsg(successMsg);
      if (selectedId) await loadTree(selectedId);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Operation failed');
    } finally {
      setBusy(false);
    }
  };

  const createVersion = async () => {
    if (!newProgramId || !newLabel.trim()) return;
    await handleApiCall(async () => {
      const treeRes = await api.post<VersionTree>('/catalog/program-versions', {
        programId: newProgramId, versionLabel: newLabel.trim(), copyFromVersionId: copyFrom || null,
      });
      await loadInitialData();
      if (treeRes?.version?.id) await loadTree(treeRes.version.id);
    }, `Version ${newLabel} created successfully.`);
  };

  const publish = async () => {
    setShowPublishModal(false);
    await handleApiCall(async () => {
      await api.post(`/catalog/program-versions/${selectedId}/publish`, {});
      await loadInitialData();
    }, 'Version published successfully.');
  };

  const addPromotion = async () => {
    if (!selectedId || !promoForm.name) return;
    await handleApiCall(async () => {
      await api.post('/catalog/promotion-rules', {
        programVersionId: selectedId, ...promoForm,
        fromLevelId: promoForm.fromLevelId || null, toLevelId: promoForm.toLevelId || null,
      });
    }, 'Promotion rule added.');
  };

  const addPlacement = async () => {
    if (!selectedId || !placeForm.name) return;
    await handleApiCall(async () => {
      await api.post('/catalog/placement-rules', {
        programVersionId: selectedId, ...placeForm,
        recommendedLevelId: placeForm.recommendedLevelId || null,
      });
    }, 'Placement rule added.');
  };

  const deleteRule = async (type: 'promotion' | 'placement' | 'fee', ruleId: string) => {
    if (!window.confirm('Delete this rule permanently?')) return;
    await handleApiCall(async () => {
      await api.delete(`/catalog/${type}-rules/${ruleId}`);
    }, 'Rule deleted successfully.');
  };

  const componentTypes = [
    { value: 'skill_scores', label: 'Skill assessment' },
    { value: 'content_test', label: 'Content test (test-bank)' },
    { value: 'written_test', label: 'Written test' },
    { value: 'interview', label: 'Interview' },
    { value: 'level_assessment', label: 'Level assessment' },
    { value: 'custom_score', label: 'Custom score' },
  ];

  const derivePlacementMethod = (components: any[]) => {
    const types = [...new Set((components || []).map((x:any) => x.type))];
    if (types.length === 0) return 'skill_scores';
    if (types.length > 1) return 'hybrid';
    return types[0];
  };

  const updatePlacementComponent = (index: number, patch: any) => {
    setPlacementConfig((c:any) => {
      const components = (c.components || []).map((x:any, i:number) => i === index ? { ...x, ...patch } : x);
      return { ...c, components, method: derivePlacementMethod(components) };
    });
  };

  const addPlacementComponent = () => {
    setPlacementConfig((c:any) => {
      const components = [...(c.components || []), { key: `component_${(c.components || []).length + 1}`, type: 'written_test', label: 'Written Test', required: true, weight: 0, maxScore: 100, durationMinutes: 30, instructions: '' }];
      return { ...c, components, method: derivePlacementMethod(components) };
    });
  };

  const removePlacementComponent = (index: number) => {
    setPlacementConfig((c:any) => {
      const components = (c.components || []).filter((_x:any, i:number) => i !== index);
      return { ...c, components, method: derivePlacementMethod(components) };
    });
  };

  const levels = tree?.levels || [];

  if (loadingInit) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-slate-400 gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
        <span className="text-xs font-semibold uppercase tracking-wide">Loading Curriculum Data...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start gap-4 bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
        <div className="p-3 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 text-white shadow-lg shadow-indigo-200">
          <GitBranch className="w-6 h-6" />
        </div>
        <div className="flex-1">
          <h3 className="text-base font-extrabold text-slate-900">Curriculum Versions & Rules</h3>
          <p className="text-xs text-slate-500 mt-1">Define placement, promotion, and fee rules for each curriculum version.</p>
        </div>
        <button type="button" onClick={loadInitialData} className="p-2 rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 cursor-pointer">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
        </button>
      </div>

      {/* Alerts */}
      {error && <div className="flex items-center gap-2 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3"><AlertCircle className="w-4 h-4" /> {error}</div>}
      {msg && <div className="flex items-center gap-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3"><Check className="w-4 h-4" /> {msg}</div>}

      {/* Create Version Form */}
      <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
        <h4 className="text-xs font-extrabold text-slate-500 uppercase tracking-wider mb-3">Create New Version</h4>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div>
            <label className={labelCls}>Program</label>
            <select value={newProgramId} onChange={(e) => setNewProgramId(e.target.value)} className={inputCls}>
              <option value="">Select…</option>
              {programs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>Version Label</label>
            <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="v1" className={`${inputCls} font-mono`} />
          </div>
          <div>
            <label className={labelCls}>Copy From</label>
            <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)} className={inputCls}>
              <option value="">None (Fresh)</option>
              {versions.map((v) => <option key={v.id} value={v.id}>{v.program_name} {v.version_label}</option>)}
            </select>
          </div>
          <div className="flex items-end">
            <button type="button" disabled={busy || !newProgramId} onClick={createVersion} className="w-full inline-flex items-center justify-center gap-1 px-3 py-2.5 rounded-xl bg-indigo-600 text-white text-xs font-bold disabled:opacity-40 cursor-pointer hover:bg-indigo-700">
              <Plus className="w-3.5 h-3.5" /> Create
            </button>
          </div>
        </div>
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        {/* Left: Versions List */}
        <div className="lg:col-span-4 bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden h-fit sticky top-4">
          <div className="bg-slate-50 px-4 py-3 border-b border-slate-100 text-xs font-extrabold text-slate-600 uppercase tracking-wider">All Versions</div>
          <div className="max-h-[calc(100vh-12rem)] overflow-y-auto">
            {versions.length === 0 ? (
              <p className="p-4 text-xs text-slate-400 text-center">No versions yet.</p>
            ) : (
              versions.map((v) => (
                <button key={v.id} type="button" onClick={() => loadTree(v.id)}
                  className={`w-full text-left px-4 py-3 border-b border-slate-50 text-xs hover:bg-slate-50 transition-colors ${selectedId === v.id ? 'bg-indigo-50 border-l-4 border-l-indigo-600' : ''}`}>
                  <div className="font-bold text-slate-800">{v.program_name || 'Program'}</div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="font-mono text-slate-500">{v.version_label}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${v.status === 'published' ? 'bg-emerald-100 text-emerald-700' : v.status === 'archived' ? 'bg-slate-200 text-slate-500' : 'bg-amber-100 text-amber-700'}`}>{v.status}</span>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Right: Details & Rules (FIXED LAYOUT) */}
        <div className="lg:col-span-8 bg-white rounded-2xl border border-slate-200 shadow-sm p-6 min-h-[400px] overflow-visible">
          {!tree ? (
            <div className="flex flex-col items-center justify-center h-full text-center text-slate-400 py-12">
              <BookOpen className="w-10 h-10 mb-3" />
              <p className="text-sm font-semibold">Select a Version</p>
              <p className="text-xs">Select a version from the left to view and edit its rules.</p>
            </div>
          ) : (
            <div className="space-y-8">
              {/* Header */}
              <div className="flex items-center justify-between gap-2 border-b border-slate-100 pb-4">
                <div>
                  <p className="text-lg font-extrabold text-slate-900">{tree.version.program_name} — {tree.version.version_label}</p>
                  <p className="text-xs text-slate-500 mt-1">Status: <span className="font-bold capitalize">{tree.version.status}</span> · {tree.levels?.length || 0} Levels attached</p>
                  {/* Effective dates, publication state and authorship were already
                      returned by the API (getVersionTree does `SELECT pv.*`) but were
                      never rendered, so the operator could not tell WHEN a version
                      applies or WHETHER it is live — the core of the "nothing
                      meaningful is visible" report. Each field is omitted when unset
                      rather than printed as "null". */}
                  <dl className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-2 text-xs">
                    <div>
                      <dt className="text-slate-400 font-semibold uppercase tracking-wide text-[10px]">Effective from</dt>
                      <dd className="font-bold text-slate-700 mt-0.5">{tree.version.effective_from || '—'}</dd>
                    </div>
                    <div>
                      <dt className="text-slate-400 font-semibold uppercase tracking-wide text-[10px]">Effective to</dt>
                      <dd className="font-bold text-slate-700 mt-0.5">{tree.version.effective_to || 'Open-ended'}</dd>
                    </div>
                    <div>
                      <dt className="text-slate-400 font-semibold uppercase tracking-wide text-[10px]">Published</dt>
                      <dd className="font-bold text-slate-700 mt-0.5">{tree.version.published_at || 'Not published'}</dd>
                    </div>
                    <div>
                      <dt className="text-slate-400 font-semibold uppercase tracking-wide text-[10px]">Created by</dt>
                      <dd className="font-bold text-slate-700 mt-0.5">{tree.version.created_by_name || '—'}</dd>
                    </div>
                  </dl>
                </div>
                {tree.version.status !== 'published' && tree.version.status !== 'archived' && (
                  <button type="button" disabled={busy} onClick={() => setShowPublishModal(true)} className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-emerald-600 text-white text-xs font-bold hover:bg-emerald-700 cursor-pointer">
                    <Upload className="w-3.5 h-3.5" /> Publish
                  </button>
                )}
              </div>

              {/* Levels Summary */}
              <div>
                <h4 className="text-xs font-extrabold text-slate-500 uppercase tracking-wider mb-2 flex items-center gap-1"><Layers className="w-3.5 h-3.5" /> Levels Included</h4>
                <div className="flex flex-wrap gap-2">
                  {levels.map((l) => (
                    <span key={l.id} className="px-3 py-1.5 rounded-lg bg-slate-100 text-xs font-semibold text-slate-700 border border-slate-200">
                      {l.name}
                    </span>
                  ))}
                  {levels.length === 0 && <span className="text-xs text-slate-400 italic">No levels attached.</span>}
                </div>
              </div>

              {/* Rules Section (Vertical & Clear) */}
              <div className="space-y-6">

                {/* Placement Assessment Policy */}
                <div className="bg-indigo-50/30 border border-indigo-100 rounded-xl p-5">
                  <div className="flex items-center justify-between gap-4 mb-4">
                    <div className="flex items-center gap-2"><div className="p-2 bg-indigo-100 rounded-lg"><Zap className="w-4 h-4 text-indigo-700" /></div><div><h4 className="text-sm font-extrabold text-slate-900">Placement Assessment Blueprint</h4><p className="text-[11px] text-slate-500">This program version owns the complete assessment workflow used for every candidate.</p></div></div>
                    <label className="flex items-center gap-2 text-xs font-bold whitespace-nowrap"><input type="checkbox" checked={placementConfig.enabled} onChange={e=>setPlacementConfig((c:any)=>({...c,enabled:e.target.checked}))}/> Enabled</label>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 mb-5">
                    <div className="rounded-xl border border-slate-200 bg-white px-3 py-3 min-w-0"><label className={labelCls}>Placement requirement</label><select value={placementConfig.requirementMode} onChange={e=>setPlacementConfig((c:any)=>({...c,requirementMode:e.target.value, required: e.target.value==='required', enabled: e.target.value!=='not_required'}))} className={`${inputCls} min-w-0`}>
                      <option value="required">Required</option>
                      <option value="optional">Optional (may skip)</option>
                      <option value="not_required">Not required</option>
                    </select></div>
                    <label className="flex items-center gap-2 text-xs font-bold rounded-xl border border-slate-200 bg-white px-3 py-3 min-w-0 cursor-pointer"><input type="checkbox" checked={placementConfig.firstLevelExempt} onChange={e=>setPlacementConfig((c:any)=>({...c,firstLevelExempt:e.target.checked}))}/> <span>Exempt first level</span></label>
                    <div className="rounded-xl border border-slate-200 bg-white px-3 py-3 min-w-0"><label className={labelCls}>Attempt expiry (min)</label><input type="number" min="1" value={placementConfig.expiresMinutes ?? ''} onChange={e=>setPlacementConfig((c:any)=>({...c,expiresMinutes: e.target.value === '' ? null : Number(e.target.value)}))} className={`${inputCls} min-w-[5rem]`} placeholder="none"/></div>
                    <label className="flex items-center gap-2 text-xs font-bold rounded-xl border border-slate-200 bg-white px-3 py-3 min-w-0"><input type="checkbox" checked={placementConfig.allowRetake} onChange={e=>setPlacementConfig((c:any)=>({...c,allowRetake:e.target.checked}))}/> <span>Allow retakes</span></label>
                    <div className="rounded-xl border border-slate-200 bg-white px-3 py-3 min-w-0"><label className={labelCls}>Scoring Model</label><select value={placementConfig.scoringModel} onChange={e=>setPlacementConfig((c:any)=>({...c,scoringModel:e.target.value}))} className={inputCls}>
                      <option value="weighted_average">Weighted component score</option><option value="average">Simple average</option>
                    </select></div>
                    <div className="rounded-xl border border-indigo-200 bg-indigo-50/40 px-3 py-3 min-w-0">
                      <div className="text-[10px] font-bold uppercase tracking-wide text-indigo-500">Assessment strategy</div>
                      <div className="text-sm font-extrabold text-slate-800 mt-1 break-words">{placementConfig.method === 'hybrid' ? 'Hybrid' : placementConfig.method === 'skill_scores' ? 'Skill-based' : placementConfig.method === 'level_assessment' ? 'Level-based' : placementConfig.method === 'written_test' ? 'Written test' : 'Interview'}</div>
                      <div className="text-[10px] text-slate-400 mt-1">Derived from configured sections.</div>
                    </div>
                    <div className="rounded-xl border border-indigo-200 bg-white px-3 py-3 min-w-0"><label className={labelCls}>Pass / recommendation threshold</label><input type="number" min="0" max="100" value={placementConfig.passScore} onChange={e=>setPlacementConfig((c:any)=>({...c,passScore:Number(e.target.value)}))} className={`${inputCls} min-w-[5rem]`}/></div>
                    <div className="rounded-xl border border-indigo-200 bg-white px-3 py-3 min-w-0"><label className={labelCls}>Maximum overall score</label><input type="number" min="1" value={placementConfig.maxScore} onChange={e=>setPlacementConfig((c:any)=>({...c,maxScore:Number(e.target.value)}))} className={`${inputCls} min-w-[5rem]`}/></div>
                  </div>

                  <div className="space-y-3">
                    {(placementConfig.components || []).map((c:any, index:number) => (
                      <div key={c.key} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-12 gap-3 items-end">
                          <div className="xl:col-span-4 min-w-0"><label className={labelCls}>Section name</label><input value={c.label} onChange={e=>updatePlacementComponent(index,{label:e.target.value})} className={`${inputCls} min-w-0`} /></div>
                          <div className="xl:col-span-3 min-w-0"><label className={labelCls}>Type</label><select value={c.type} onChange={e=>updatePlacementComponent(index,{type:e.target.value})} className={`${inputCls} min-w-0`}>{componentTypes.map(t=><option key={t.value} value={t.value}>{t.label}</option>)}</select></div>
                          <div className="xl:col-span-2 min-w-0"><label className={labelCls}>Weight %</label><input type="number" min="0" max="100" value={c.weight} onChange={e=>updatePlacementComponent(index,{weight:Number(e.target.value)})} className={`${inputCls} min-w-[5rem]`}/></div>
                          <div className="xl:col-span-2 min-w-0"><label className={labelCls}>Max score</label><input type="number" min="1" value={c.maxScore} onChange={e=>updatePlacementComponent(index,{maxScore:Number(e.target.value)})} className={`${inputCls} min-w-[5rem]`}/></div>
                          <button type="button" onClick={()=>removePlacementComponent(index)} aria-label={`Remove ${c.label || 'assessment section'}`} className="h-[42px] rounded-xl border border-rose-200 text-rose-600 hover:bg-rose-50 flex items-center justify-center xl:col-span-1"><Trash2 className="w-3.5 h-3.5"/></button>
                        </div>
                        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-12 gap-3 items-end">
                          <label className="xl:col-span-2 flex items-center gap-2 text-[11px] font-bold text-slate-600 rounded-xl bg-slate-50 border border-slate-100 px-3 py-3"><input type="checkbox" checked={c.required !== false} onChange={e=>updatePlacementComponent(index,{required:e.target.checked})}/> Required</label>
                          <div className="xl:col-span-2 min-w-0"><label className={labelCls}>Time limit (s)</label><input type="number" min="0" value={c.timeLimitSeconds ?? (c.durationMinutes ? c.durationMinutes*60 : '')} onChange={e=>updatePlacementComponent(index,{timeLimitSeconds: e.target.value === '' ? null : Number(e.target.value), durationMinutes: undefined})} className={`${inputCls} min-w-[5rem]`} placeholder="no timer"/></div>
                          <div className="xl:col-span-2 min-w-0"><label className={labelCls}>Min score</label><input type="number" min="0" value={c.minScore ?? ''} onChange={e=>updatePlacementComponent(index,{minScore: e.target.value === '' ? null : Number(e.target.value)})} className={`${inputCls} min-w-[5rem]`} placeholder="none"/></div>
                          <div className="xl:col-span-3 min-w-0"><label className={labelCls}>Scoring</label><select value={c.scoringMethod || (c.type==='content_test' ? 'hybrid' : 'manual')} onChange={e=>updatePlacementComponent(index,{scoringMethod:e.target.value})} className={`${inputCls} min-w-0`}><option value="auto">Auto</option><option value="manual">Manual</option><option value="hybrid">Hybrid</option></select></div>
                          <div className="xl:col-span-3 min-w-0"><label className={labelCls}>Instructions</label><input value={c.instructions || ''} onChange={e=>updatePlacementComponent(index,{instructions:e.target.value})} className={`${inputCls} min-w-0`} placeholder="Examiner guidance…"/></div>
                        </div>
                        {c.type === 'content_test' && (
                          <div className="mt-3 rounded-xl bg-indigo-50/50 border border-indigo-100 p-3">
                            <label className={labelCls}>Test-bank content</label>
                            <select value={c.testId || ''} onChange={e=>updatePlacementComponent(index,{testId:e.target.value || undefined})} className={`${inputCls} min-w-0`}>
                              <option value="">Select an active test…</option>
                              {(testBankTests || []).filter((t:any)=>t.status==='active').map((t:any)=><option key={t.id} value={t.id}>{t.testType} · {t.title} (v{t.version})</option>)}
                            </select>
                          </div>
                        )}
                        {c.type === 'skill_scores' && <div className="mt-3 flex flex-wrap gap-2">{['grammar','vocabulary','reading','listening','writing','speaking'].map((skill:string)=><label key={skill} className="px-2.5 py-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[10px] font-bold"><input type="checkbox" className="mr-1.5" checked={(c.skills || []).includes(skill)} onChange={e=>updatePlacementComponent(index,{skills:e.target.checked ? [...new Set([...(c.skills || []),skill])] : (c.skills || []).filter((x:string)=>x!==skill)})}/>{skill}</label>)}</div>}
                      </div>
                    ))}
                    <button type="button" onClick={addPlacementComponent} className="w-full py-3 rounded-xl border border-dashed border-indigo-300 text-indigo-700 bg-indigo-50/40 hover:bg-indigo-50 text-xs font-black"><Plus className="w-3.5 h-3.5 inline mr-1"/> Add assessment section</button>
                    <div className="text-[11px] text-slate-500">Weights must total exactly 100%. All sections are saved into a candidate snapshot when the assessment starts.</div>
                  </div>

                  {/* Conditional decision rules */}
                  <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-[11px] font-black text-slate-600 uppercase tracking-wide">Conditional placement rules (IF component score THEN level)</div>
                      <button type="button" onClick={()=>setPlacementConfig((c:any)=>({...c,decisionRules:[...(c.decisionRules||[]),{levelId:'',label:'rule '+( (c.decisionRules||[]).length+1),when:[{componentKey:(c.components||[])[0]?.key||'',field:'score',op:'gte',value:60}]}]}))} className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-[10px] font-black"><Plus className="w-3 h-3 inline mr-1"/>Add rule</button>
                    </div>
                    {(!placementConfig.decisionRules || placementConfig.decisionRules.length === 0) && <p className="text-[11px] text-slate-400">No conditional rules — score bands (below) apply.</p>}
                    <div className="space-y-3">
                      {(placementConfig.decisionRules || []).map((rule:any, ri:number)=>(
                        <div key={ri} className="rounded-xl border border-slate-100 bg-slate-50 p-3">
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] font-black text-slate-400">IF</span>
                            <div className="flex items-center gap-1 flex-1 flex-wrap">
                              {rule.when.map((cond:any, ci:number)=>(
                                <span key={ci} className="flex items-center gap-1">
                                  <select value={cond.componentKey} onChange={e=>{const w=[...(rule.when)]; w[ci]={...w[ci],componentKey:e.target.value}; setPlacementConfig((c:any)=>({...c,decisionRules:c.decisionRules.map((r:any,i:number)=>i===ri?{...r,when:w}:r)}));}} className="text-[10px] rounded-lg border border-slate-200 px-2 py-1 bg-white">{placementConfig.components.map((comp:any)=><option key={comp.key} value={comp.key}>{comp.label}</option>)}</select>
                                  <select value={cond.field} onChange={e=>{const w=[...(rule.when)]; w[ci]={...w[ci],field:e.target.value}; setPlacementConfig((c:any)=>({...c,decisionRules:c.decisionRules.map((r:any,i:number)=>i===ri?{...r,when:w}:r)}));}} className="text-[10px] rounded-lg border border-slate-200 px-2 py-1 bg-white"><option value="score">score</option><option value="percentage">%</option></select>
                                  <select value={cond.op} onChange={e=>{const w=[...(rule.when)]; w[ci]={...w[ci],op:e.target.value}; setPlacementConfig((c:any)=>({...c,decisionRules:c.decisionRules.map((r:any,i:number)=>i===ri?{...r,when:w}:r)}));}} className="text-[10px] rounded-lg border border-slate-200 px-2 py-1 bg-white"><option value="gte">≥</option><option value="lte">≤</option><option value="eq">=</option></select>
                                  <input type="number" value={cond.value} onChange={e=>{const w=[...(rule.when)]; w[ci]={...w[ci],value:Number(e.target.value)}; setPlacementConfig((c:any)=>({...c,decisionRules:c.decisionRules.map((r:any,i:number)=>i===ri?{...r,when:w}:r)}));}} className="text-[10px] rounded-lg border border-slate-200 px-2 py-1 w-16 bg-white"/>
                                  <button type="button" onClick={()=>{const w=rule.when.filter((_:any,x:number)=>x!==ci); setPlacementConfig((c:any)=>({...c,decisionRules:c.decisionRules.map((r:any,i:number)=>i===ri?{...r,when:w}:r)}));}} className="text-rose-400 hover:text-rose-600"><X className="w-3 h-3"/></button>
                                </span>
                              ))}
                              <button type="button" onClick={()=>setPlacementConfig((c:any)=>({...c,decisionRules:c.decisionRules.map((r:any,i:number)=>i===ri?{...r,when:[...r.when,{componentKey:(c.components||[])[0]?.key||'',field:'score',op:'gte',value:60}]}:r)}))} className="text-[10px] font-black text-indigo-600">+ condition</button>
                            </div>
                            <span className="text-[10px] font-black text-slate-400">THEN</span>
                            <select value={rule.levelId} onChange={e=>setPlacementConfig((c:any)=>({...c,decisionRules:c.decisionRules.map((r:any,i:number)=>i===ri?{...r,levelId:e.target.value}:r)}))} className="text-[10px] rounded-lg border border-slate-200 px-2 py-1 bg-white"><option value="">Level…</option>{levels.map((l:any)=><option key={l.id} value={l.id}>{l.code?`${l.code} — `:''}{l.name}</option>)}</select>
                            <button type="button" onClick={()=>setPlacementConfig((c:any)=>({...c,decisionRules:c.decisionRules.filter((_:any,i:number)=>i!==ri)}))} className="text-rose-400 hover:text-rose-600"><Trash2 className="w-3 h-3"/></button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <textarea value={placementConfig.instructions} onChange={e=>setPlacementConfig((c:any)=>({...c,instructions:e.target.value}))} className={`${inputCls} mt-4`} rows={3} placeholder="Overall examiner guidance…"/>
                  <div className="flex justify-end mt-3"><button type="button" disabled={busy || !selectedId} onClick={()=>handleApiCall(async()=>{ await api.put(`/academic/program-versions/${selectedId}/placement-profile`, { ...placementConfig, requirementMode: placementConfig.requirementMode, firstLevelExempt: placementConfig.firstLevelExempt, expiresMinutes: placementConfig.expiresMinutes, decisionRules: placementConfig.decisionRules || [] }); }, 'Placement policy saved.')} className="px-4 py-2 rounded-xl bg-indigo-600 text-white text-xs font-bold">Save Assessment Blueprint</button></div>
                </div>

                {/* Promotion Rules */}
                <div className="bg-emerald-50/30 border border-emerald-100 rounded-xl p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <div className="p-2 bg-emerald-100 rounded-lg"><Zap className="w-4 h-4 text-emerald-700" /></div>
                    <div>
                      <h4 className="text-sm font-extrabold text-slate-900">Promotion Rules</h4>
                      <p className="text-[11px] text-slate-500">Define criteria for passing a level and moving to the next.</p>
                    </div>
                  </div>
                  
                  <form className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
                    <div>
                      <label className={labelCls}>Rule Name</label>
                      <input className={inputCls} value={promoForm.name} onChange={(e) => setPromoForm({ ...promoForm, name: e.target.value })} placeholder="e.g. Pass Mark" />
                    </div>
                    <div>
                      <label className={labelCls}>Min Exam Score (0-100)</label>
                      <input type="number" className={inputCls} value={promoForm.minScore} onChange={(e) => setPromoForm({ ...promoForm, minScore: Number(e.target.value) })} />
                    </div>
                    <div>
                      <label className={labelCls}>Min Attendance %</label>
                      <input type="number" className={inputCls} value={promoForm.minAttendancePct} onChange={(e) => setPromoForm({ ...promoForm, minAttendancePct: Number(e.target.value) })} />
                    </div>
                    <div>
                      <label className={labelCls}>From Level</label>
                      <select className={inputCls} value={promoForm.fromLevelId} onChange={(e) => setPromoForm({ ...promoForm, fromLevelId: e.target.value })}>
                        <option value="">Any Level</option>
                        {levels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className={labelCls}>To Level</label>
                      <select className={inputCls} value={promoForm.toLevelId} onChange={(e) => setPromoForm({ ...promoForm, toLevelId: e.target.value })}>
                        <option value="">Next Level</option>
                        {levels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                      </select>
                    </div>
                    <div className="flex items-end">
                      <button type="button" disabled={busy} onClick={addPromotion} className="w-full py-2 rounded-lg bg-emerald-600 text-white text-xs font-bold disabled:opacity-50 cursor-pointer flex items-center justify-center gap-1">
                        <Plus className="w-3 h-3" /> Add Rule
                      </button>
                    </div>
                  </form>

                  <div className="space-y-2 pt-3 border-t border-emerald-100">
                    {(tree.promotionRules || []).map((r) => (
                      <div key={r.id} className="flex justify-between items-center bg-white px-3 py-2 rounded-lg border border-slate-100 text-xs">
                        <span className="text-slate-700 font-medium">{r.name}: Score ≥ <b>{r.min_score}</b>, Attendance ≥ <b>{r.min_attendance_pct}%</b></span>
                        <button onClick={() => deleteRule('promotion', r.id)} className="text-rose-400 hover:text-rose-600"><Trash2 className="w-3 h-3" /></button>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Placement Rules */}
                <div className="bg-indigo-50/30 border border-indigo-100 rounded-xl p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <div className="p-2 bg-indigo-100 rounded-lg"><Filter className="w-4 h-4 text-indigo-700" /></div>
                    <div>
                      <h4 className="text-sm font-extrabold text-slate-900">Placement Rules</h4>
                      <p className="text-[11px] text-slate-500">Map placement test scores to recommended levels.</p>
                    </div>
                  </div>
                  
                  <form className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
                    <div>
                      <label className={labelCls}>Rule Name</label>
                      <input className={inputCls} value={placeForm.name} onChange={(e) => setPlaceForm({ ...placeForm, name: e.target.value })} placeholder="e.g. Beginner Band" />
                    </div>
                    <div>
                      <label className={labelCls}>Min Score</label>
                      <input type="number" className={inputCls} value={placeForm.minScore} onChange={(e) => setPlaceForm({ ...placeForm, minScore: Number(e.target.value) })} />
                    </div>
                    <div>
                      <label className={labelCls}>Max Score</label>
                      <input type="number" className={inputCls} value={placeForm.maxScore} onChange={(e) => setPlaceForm({ ...placeForm, maxScore: Number(e.target.value) })} />
                    </div>
                    <div>
                      <label className={labelCls}>Recommended Level</label>
                      <select className={inputCls} value={placeForm.recommendedLevelId} onChange={(e) => setPlaceForm({ ...placeForm, recommendedLevelId: e.target.value })}>
                        <option value="">Select Level…</option>
                        {levels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                      </select>
                    </div>
                    <div className="lg:col-span-4 flex justify-end">
                      <button type="button" disabled={busy} onClick={addPlacement} className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-xs font-bold disabled:opacity-50 cursor-pointer flex items-center justify-center gap-1">
                        <Plus className="w-3 h-3" /> Add Rule
                      </button>
                    </div>
                  </form>

                  <div className="space-y-2 pt-3 border-t border-indigo-100">
                    {(tree.placementRules || []).map((r) => (
                      <div key={r.id} className="flex justify-between items-center bg-white px-3 py-2 rounded-lg border border-slate-100 text-xs">
                        <span className="text-slate-700 font-medium">{r.name}: Score <b>{r.min_score}-{r.max_score}</b> → {levels.find(l=>l.id===r.recommended_level_id)?.name || 'Any'}</span>
                        <button onClick={() => deleteRule('placement', r.id)} className="text-rose-400 hover:text-rose-600"><Trash2 className="w-3 h-3" /></button>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="bg-amber-50 border border-amber-100 rounded-xl p-5">
                  <div className="flex items-start gap-3">
                    <div className="p-2 bg-amber-100 rounded-lg text-amber-700 font-black">$</div>
                    <div>
                      <h4 className="text-sm font-extrabold text-slate-900">Fee configuration has one owner</h4>
                      <p className="text-[11px] text-slate-600 mt-1 leading-relaxed">Program and level fees are configured in the Academic Catalog. Branch overrides are managed on each Level. This version screen intentionally does not create a second fee-rule registry.</p>
                    </div>
                  </div>
                </div>

              </div>
            </div>
          )}
        </div>
      </div>

      {/* Publish Modal */}
      {showPublishModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4 animate-in fade-in duration-200" onClick={() => setShowPublishModal(false)}>
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md p-6 border border-slate-200" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-extrabold text-slate-900">Confirm Publish</h3>
              <button onClick={() => setShowPublishModal(false)} className="p-2 hover:bg-slate-100 rounded-xl text-slate-500"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-sm text-slate-600 mb-6">Publishing this version will make it the active curriculum for new enrollments. Any previously published version for this program will be archived. Are you sure?</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowPublishModal(false)} className="px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-100 rounded-xl transition-colors cursor-pointer">Cancel</button>
              <button onClick={publish} className="px-5 py-2 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl shadow-sm transition-colors cursor-pointer">Yes, Publish Now</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}