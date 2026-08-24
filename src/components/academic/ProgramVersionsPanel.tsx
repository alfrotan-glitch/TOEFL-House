import { text } from '../../design-system/styles';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  BookOpen,
  Check,
  GitBranch,
  Layers,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Upload,
  X,
  Zap,
} from 'lucide-react';
import { api } from '../../api/client';
import { useInvalidate } from '../../state/serverStateFreshness';

interface Program { id: string; name: string; isActive?: boolean; }
interface ProgramVersion {
  id: string;
  program_id: string;
  program_name?: string;
  version_label: string;
  version_number: number;
  status: string;
  is_default?: number;
  duration_months?: number;
  description?: string | null;
  effective_from?: string | null;
  effective_to?: string | null;
  published_at?: string | null;
  created_by?: string | null;
  created_by_name?: string | null;
}
interface TreeLevel { id: string; name: string; code?: string; order?: number; default_fee?: number; }
interface PromotionRule { id: string; name: string; min_score: number; min_attendance_pct: number; from_level_id?: string; to_level_id?: string; }
interface VersionTree {
  version: ProgramVersion;
  levels: TreeLevel[];
  subjects: unknown[];
  promotionRules: PromotionRule[];
}

const inputCls = 'w-full text-xs border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 transition-all';
const labelCls = "block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1 break-words";
const chipCls = 'inline-flex items-center rounded-full px-2.5 py-1 text-[10px] font-bold';

type ComponentKey = 'grammar' | 'reading' | 'listening' | 'writing' | 'speaking';
type CefrLevel = 'A1' | 'A2' | 'B1' | 'B2' | 'C1';
type Difficulty = 'easy' | 'medium' | 'hard' | 'ANY';

interface TestBankSummary {
  id: string;
  title: string;
  testType?: string;
  status?: string;
  version?: number;
  branchId?: string | null;
}

interface BlueprintBucketDraft {
  count: number;
  cefrLevel: CefrLevel | 'ANY';
  difficulty: Difficulty;
  qtypes: string[];
}

interface PlacementComponentDraft {
  key: ComponentKey;
  type: ComponentKey;
  label: string;
  required: true;
  weight: number;
  maxScore: number;
  durationMinutes: number;
  timeLimitSeconds: number;
  instructions: string;
  bankIds: string[];
  blueprintBuckets: BlueprintBucketDraft[];
}

interface DecisionRuleDraft {
  cefrLevel: CefrLevel;
  recommendedLevelId: string;
  minimumScores: Record<ComponentKey, number>;
  label?: string;
}

interface PlacementConfigDraft {
  version: number | null;
  requirementMode: 'required' | 'optional' | 'not_required';
  firstLevelExempt: boolean;
  expiresMinutes: number | null;
  decisionRules: DecisionRuleDraft[];
  components: PlacementComponentDraft[];
  scoringModel: 'canonical';
  allowRetake: boolean;
  maxAttempts: number | null;
  firstAttemptBillable: boolean;
  retakeBillable: boolean;
  retakeFeeAmount: number | null;
  passScore: number;
  instructions: string;
}

const COMPONENT_ORDER: ComponentKey[] = ['grammar', 'reading', 'listening', 'writing', 'speaking'];
const CEFR_ORDER: CefrLevel[] = ['A1', 'A2', 'B1', 'B2', 'C1'];
const DIFFICULTIES: Difficulty[] = ['ANY', 'easy', 'medium', 'hard'];

const COMPONENT_SPECS: Record<ComponentKey, {
  label: string;
  maxScore: number;
  weight: number;
  selectionCount: number;
  defaultDurationMinutes: number;
  allowedQtypes: string[];
  helper: string;
}> = {
  grammar: {
    label: 'Grammar',
    maxScore: 30,
    weight: 25,
    selectionCount: 30,
    defaultDurationMinutes: 30,
    allowedQtypes: ['mcq', 'fill_blank', 'sentence_completion', 'error_identification', 'short_answer'],
    helper: '30 objective items assembled from active grammar banks.',
  },
  reading: {
    label: 'Reading',
    maxScore: 20,
    weight: 16.67,
    selectionCount: 20,
    defaultDurationMinutes: 25,
    allowedQtypes: ['mcq', 'short_answer'],
    helper: '20 objective items assembled from active reading banks.',
  },
  listening: {
    label: 'Listening',
    maxScore: 20,
    weight: 16.67,
    selectionCount: 20,
    defaultDurationMinutes: 25,
    allowedQtypes: ['mcq', 'short_answer'],
    helper: '20 objective items assembled from active listening banks.',
  },
  writing: {
    label: 'Writing',
    maxScore: 25,
    weight: 20.83,
    selectionCount: 1,
    defaultDurationMinutes: 30,
    allowedQtypes: ['essay'],
    helper: 'One human-scored writing task with rubric evidence.',
  },
  speaking: {
    label: 'Speaking',
    maxScore: 25,
    weight: 20.83,
    selectionCount: 1,
    defaultDurationMinutes: 15,
    allowedQtypes: ['speaking'],
    helper: 'One human-scored speaking prompt or evaluation.',
  },
};

function defaultBucket(key: ComponentKey): BlueprintBucketDraft {
  const spec = COMPONENT_SPECS[key];
  return {
    count: spec.selectionCount,
    cefrLevel: 'ANY',
    difficulty: 'ANY',
    qtypes: [...spec.allowedQtypes],
  };
}

function defaultComponent(key: ComponentKey): PlacementComponentDraft {
  const spec = COMPONENT_SPECS[key];
  return {
    key,
    type: key,
    label: spec.label,
    required: true,
    weight: spec.weight,
    maxScore: spec.maxScore,
    durationMinutes: spec.defaultDurationMinutes,
    timeLimitSeconds: spec.defaultDurationMinutes * 60,
    instructions: `${spec.label} placement section`,
    bankIds: [],
    blueprintBuckets: [defaultBucket(key)],
  };
}

function resolveLevelForCefr(levels: TreeLevel[], cefr: CefrLevel): string {
  const exact = levels.find((level) => String(level.code || '').toUpperCase() === cefr || String(level.name || '').toUpperCase() === cefr);
  if (exact) return exact.id;
  if (cefr === 'A1' && levels[0]) return levels[0].id;
  if (levels.length > 0) return levels[Math.min(levels.length - 1, 1)]?.id || levels[0].id;
  return '';
}

function defaultRule(levels: TreeLevel[], cefrLevel: CefrLevel): DecisionRuleDraft {
  const thresholds: Record<CefrLevel, Record<ComponentKey, number>> = {
    A1: { grammar: 5, reading: 3, listening: 3, writing: 8, speaking: 8 },
    A2: { grammar: 12, reading: 8, listening: 8, writing: 12, speaking: 12 },
    B1: { grammar: 18, reading: 12, listening: 12, writing: 15, speaking: 15 },
    B2: { grammar: 24, reading: 16, listening: 16, writing: 18, speaking: 18 },
    C1: { grammar: 28, reading: 18, listening: 18, writing: 22, speaking: 22 },
  };
  return {
    cefrLevel,
    recommendedLevelId: resolveLevelForCefr(levels, cefrLevel),
    minimumScores: thresholds[cefrLevel],
    label: `${cefrLevel} threshold`,
  };
}

function normalizeComponent(key: ComponentKey, raw: Partial<PlacementComponentDraft> | undefined): PlacementComponentDraft {
  const base = defaultComponent(key);
  const bankIds = Array.isArray(raw?.bankIds) ? raw!.bankIds.filter(Boolean) : base.bankIds;
  const blueprintBuckets = Array.isArray(raw?.blueprintBuckets) && raw!.blueprintBuckets.length > 0
    ? raw!.blueprintBuckets.map((bucket) => ({
        count: Number(bucket.count || 0),
        cefrLevel: bucket.cefrLevel || 'ANY',
        difficulty: bucket.difficulty || 'ANY',
        qtypes: Array.isArray(bucket.qtypes) ? bucket.qtypes : [],
      }))
    : base.blueprintBuckets;
  const durationMinutes = raw?.durationMinutes == null ? base.durationMinutes : Number(raw.durationMinutes);
  const timeLimitSeconds = raw?.timeLimitSeconds == null ? Math.round(durationMinutes * 60) : Number(raw.timeLimitSeconds);
  return {
    ...base,
    ...raw,
    key,
    type: key,
    label: String(raw?.label || base.label),
    required: true,
    weight: base.weight,
    maxScore: base.maxScore,
    durationMinutes,
    timeLimitSeconds,
    instructions: String(raw?.instructions || base.instructions),
    bankIds,
    blueprintBuckets,
  };
}

function normalizeConfig(raw: any, levels: TreeLevel[]): PlacementConfigDraft {
  const componentMap = new Map<string, Partial<PlacementComponentDraft>>(
    Array.isArray(raw?.components)
      ? raw.components.map((component: any) => [String(component?.key || component?.type || ''), component])
      : [],
  );
  const components = COMPONENT_ORDER.map((key) => normalizeComponent(key, componentMap.get(key)));

  const ruleMap = new Map<string, Partial<DecisionRuleDraft>>(
    Array.isArray(raw?.decisionRules)
      ? raw.decisionRules.map((rule: any) => [String(rule?.cefrLevel || ''), rule])
      : [],
  );
  const decisionRules = CEFR_ORDER.map((cefrLevel) => {
    const existing = ruleMap.get(cefrLevel);
    const base = defaultRule(levels, cefrLevel);
    const minimumScores = COMPONENT_ORDER.reduce((acc, key) => {
      acc[key] = existing?.minimumScores?.[key] == null ? base.minimumScores[key] : Number(existing.minimumScores[key]);
      return acc;
    }, {} as Record<ComponentKey, number>);
    return {
      cefrLevel,
      recommendedLevelId: String(existing?.recommendedLevelId || base.recommendedLevelId || ''),
      minimumScores,
      label: typeof existing?.label === 'string' && existing.label.trim() ? existing.label.trim() : base.label,
    };
  });

  return {
    version: raw?.version ?? null,
    requirementMode: raw?.requirementMode === 'required' || raw?.requirementMode === 'optional' || raw?.requirementMode === 'not_required'
      ? raw.requirementMode
      : 'not_required',
    firstLevelExempt: Boolean(raw?.firstLevelExempt),
    expiresMinutes: raw?.expiresMinutes == null ? null : Number(raw.expiresMinutes),
    decisionRules,
    components,
    scoringModel: 'canonical',
    allowRetake: raw?.allowRetake !== false,
    maxAttempts: raw?.maxAttempts == null ? null : Number(raw.maxAttempts),
    firstAttemptBillable: raw?.firstAttemptBillable !== false,
    retakeBillable: raw?.retakeBillable === true,
    retakeFeeAmount: raw?.retakeFeeAmount == null ? null : Number(raw.retakeFeeAmount),
    passScore: raw?.passScore == null ? 60 : Number(raw.passScore),
    instructions: typeof raw?.instructions === 'string' ? raw.instructions : '',
  };
}

export default function ProgramVersionsPanel({ branchId }: { branchId?: string } = {}) {
  const invalidate = useInvalidate();
  const [programs, setPrograms] = useState<Program[]>([]);
  const [versions, setVersions] = useState<ProgramVersion[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tree, setTree] = useState<VersionTree | null>(null);
  const [testBankTests, setTestBankTests] = useState<TestBankSummary[]>([]);
  const [loadingInit, setLoadingInit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [showPublishModal, setShowPublishModal] = useState(false);

  const [newProgramId, setNewProgramId] = useState('');
  const [newLabel, setNewLabel] = useState('v1');
  const [copyFrom, setCopyFrom] = useState('');

  const [promoForm, setPromoForm] = useState({ name: 'Default Pass Criteria', minScore: 60, minAttendancePct: 75, fromLevelId: '', toLevelId: '' });
  const [placementConfig, setPlacementConfig] = useState<PlacementConfigDraft>(normalizeConfig({}, []));

  const loadInitialData = useCallback(async () => {
    setLoadingInit(true);
    setError(null);
    try {
      const query = branchId ? { branchId } : undefined;
      const [progs, vers, bankTests] = await Promise.all([
        api.get<Program[]>('/academic/programs', query),
        api.get<ProgramVersion[]>('/catalog/program-versions', query),
        api.get<TestBankSummary[]>('/placement/test-bank', query).catch(() => []),
      ]);
      setPrograms(progs || []);
      setVersions(vers || []);
      setTestBankTests(bankTests || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load versions');
    } finally {
      setLoadingInit(false);
    }
  }, [branchId]);

  const loadTree = useCallback(async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const t = await api.get<VersionTree>(`/catalog/program-versions/${id}`);
      setTree(t);
      setSelectedId(id);
      try {
        const profile = await api.get<any>(`/academic/program-versions/${id}/placement-profile`);
        setPlacementConfig(normalizeConfig(profile, t.levels || []));
      } catch {
        setPlacementConfig(normalizeConfig({}, t.levels || []));
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load version tree');
      setTree(null);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void loadInitialData(); }, [loadInitialData]);

  useEffect(() => {
    if (selectedId || versions.length === 0) return;
    const preferred = versions.find((v) => v.status === 'published' && v.is_default) || versions.find((v) => v.status === 'published') || versions[0];
    if (preferred) void loadTree(preferred.id);
  }, [versions, selectedId, loadTree]);

  const handleApiCall = async (fn: () => Promise<void>, successMsg: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setMsg(successMsg);
      if (selectedId) await loadTree(selectedId);
      invalidate('academic');
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
        programId: newProgramId,
        versionLabel: newLabel.trim(),
        copyFromVersionId: copyFrom || null,
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
        programVersionId: selectedId,
        ...promoForm,
        branchId,
        fromLevelId: promoForm.fromLevelId || null,
        toLevelId: promoForm.toLevelId || null,
      });
    }, 'Promotion rule added.');
  };

  const deletePromotionRule = async (ruleId: string) => {
    if (!window.confirm('Delete this rule permanently?')) return;
    await handleApiCall(async () => {
      await api.delete(`/catalog/promotion-rules/${ruleId}`);
    }, 'Rule deleted successfully.');
  };

  const levels = tree?.levels || [];

  useEffect(() => {
    setPlacementConfig((current) => normalizeConfig(current, levels));
  }, [levels]);

  const testsByComponent = useMemo(() => {
    return COMPONENT_ORDER.reduce((acc, key) => {
      acc[key] = testBankTests.filter((test) => test.status === 'active' && test.testType === key);
      return acc;
    }, {} as Record<ComponentKey, TestBankSummary[]>);
  }, [testBankTests]);

  const setComponent = (key: ComponentKey, patch: Partial<PlacementComponentDraft>) => {
    setPlacementConfig((current) => ({
      ...current,
      components: current.components.map((component) => component.key === key ? normalizeComponent(key, { ...component, ...patch }) : component),
    }));
  };

  const updateBucket = (componentKey: ComponentKey, bucketIndex: number, patch: Partial<BlueprintBucketDraft>) => {
    const component = placementConfig.components.find((entry) => entry.key === componentKey);
    if (!component) return;
    const nextBuckets = component.blueprintBuckets.map((bucket, index) => index === bucketIndex ? { ...bucket, ...patch } : bucket);
    setComponent(componentKey, { blueprintBuckets: nextBuckets });
  };

  const addBucket = (componentKey: ComponentKey) => {
    const component = placementConfig.components.find((entry) => entry.key === componentKey);
    if (!component) return;
    setComponent(componentKey, { blueprintBuckets: [...component.blueprintBuckets, defaultBucket(componentKey)] });
  };

  const removeBucket = (componentKey: ComponentKey, bucketIndex: number) => {
    const component = placementConfig.components.find((entry) => entry.key === componentKey);
    if (!component || component.blueprintBuckets.length <= 1) return;
    setComponent(componentKey, { blueprintBuckets: component.blueprintBuckets.filter((_, index) => index !== bucketIndex) });
  };

  const toggleBank = (componentKey: ComponentKey, bankId: string, checked: boolean) => {
    const component = placementConfig.components.find((entry) => entry.key === componentKey);
    if (!component) return;
    const bankIds = checked
      ? Array.from(new Set([...component.bankIds, bankId]))
      : component.bankIds.filter((id) => id !== bankId);
    setComponent(componentKey, { bankIds });
  };

  const toggleBucketQtype = (componentKey: ComponentKey, bucketIndex: number, qtype: string, checked: boolean) => {
    const component = placementConfig.components.find((entry) => entry.key === componentKey);
    if (!component) return;
    const current = component.blueprintBuckets[bucketIndex];
    if (!current) return;
    const qtypes = checked
      ? Array.from(new Set([...current.qtypes, qtype]))
      : current.qtypes.filter((value) => value !== qtype);
    updateBucket(componentKey, bucketIndex, { qtypes });
  };

  const setRuleScore = (cefrLevel: CefrLevel, componentKey: ComponentKey, value: number) => {
    setPlacementConfig((current) => ({
      ...current,
      decisionRules: current.decisionRules.map((rule) =>
        rule.cefrLevel === cefrLevel
          ? { ...rule, minimumScores: { ...rule.minimumScores, [componentKey]: value } }
          : rule,
      ),
    }));
  };

  const savePlacementProfile = async () => {
    if (!selectedId) return;
    await handleApiCall(async () => {
      await api.put(`/academic/program-versions/${selectedId}/placement-profile`, {
        version: placementConfig.version,
        requirementMode: placementConfig.requirementMode,
        firstLevelExempt: placementConfig.requirementMode === 'required' && placementConfig.firstLevelExempt,
        expiresMinutes: placementConfig.expiresMinutes,
        decisionRules: placementConfig.requirementMode === 'not_required' ? [] : placementConfig.decisionRules,
        components: placementConfig.requirementMode === 'not_required' ? [] : placementConfig.components,
        scoringModel: 'canonical',
        allowRetake: placementConfig.allowRetake,
        maxAttempts: placementConfig.maxAttempts,
        firstAttemptBillable: placementConfig.firstAttemptBillable,
        retakeBillable: placementConfig.retakeBillable,
        retakeFeeAmount: placementConfig.retakeFeeAmount,
        passScore: placementConfig.passScore,
        instructions: placementConfig.instructions,
      });
    }, 'Placement policy saved.');
  };

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
      <div className="flex items-start gap-4 bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
        <div className="p-3 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 text-white shadow-lg shadow-indigo-200">
          <GitBranch className="w-6 h-6" />
        </div>
        <div className="flex-1">
          <h3 className="text-base font-extrabold text-slate-900">Curriculum Versions & Rules</h3>
          <p className={text.hint}>Define promotion rules and the canonical Placement Test V1 policy for each curriculum version.</p>
        </div>
        <button type="button" onClick={loadInitialData} className="p-2 rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 cursor-pointer">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
        </button>
      </div>

      {error && <div className="flex items-center gap-2 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3"><AlertCircle className="w-4 h-4" /> {error}</div>}
      {msg && <div className="flex items-center gap-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3"><Check className="w-4 h-4" /> {msg}</div>}

      <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
        <h4 className="text-xs font-extrabold text-slate-500 uppercase tracking-wider mb-3">Create New Version</h4>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div>
            <label className={labelCls}>Program</label>
            <select value={newProgramId} onChange={(e) => setNewProgramId(e.target.value)} className={inputCls}>
              <option value="">Select…</option>
              {programs.map((program) => <option key={program.id} value={program.id}>{program.name}</option>)}
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
              {versions.map((version) => <option key={version.id} value={version.id}>{version.program_name} {version.version_label}</option>)}
            </select>
          </div>
          <div className="flex items-end">
            <button type="button" disabled={busy || !newProgramId} onClick={createVersion} className="w-full inline-flex items-center justify-center gap-1 px-3 py-2.5 rounded-xl bg-indigo-600 text-white text-xs font-bold disabled:opacity-40 cursor-pointer hover:bg-indigo-700">
              <Plus className="w-3.5 h-3.5" /> Create
            </button>
          </div>
        </div>
      </div>

      <div className="@container">
        <div className="grid grid-cols-1 @3xl:grid-cols-12 gap-6">
          <div className="@3xl:col-span-4 min-w-0 bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden h-fit @3xl:sticky @3xl:top-4">
            <div className="bg-slate-50 px-4 py-3 border-b border-slate-100 text-xs font-extrabold text-slate-600 uppercase tracking-wider">All Versions</div>
            <div className="max-h-[calc(100vh-12rem)] overflow-y-auto">
              {versions.length === 0 ? (
                <p className="p-4 text-xs text-slate-400 text-center">No versions yet.</p>
              ) : (
                versions.map((version) => (
                  <button
                    key={version.id}
                    type="button"
                    onClick={() => loadTree(version.id)}
                    className={`w-full text-start px-4 py-3 border-b border-slate-50 text-xs hover:bg-slate-50 transition-colors ${selectedId === version.id ? 'bg-indigo-50 border-l-4 border-l-indigo-600' : ''}`}
                  >
                    <div className="font-bold text-slate-800">{version.program_name || 'Program'}</div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="font-mono text-slate-500">{version.version_label}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${version.status === 'published' ? 'bg-emerald-100 text-emerald-700' : version.status === 'archived' ? 'bg-slate-200 text-slate-500' : 'bg-amber-100 text-amber-700'}`}>{version.status}</span>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="@container @3xl:col-span-8 bg-white rounded-2xl border border-slate-200 shadow-sm p-6 min-h-[400px] min-w-0">
            {!tree ? (
              <div className="flex flex-col items-center justify-center h-full text-center text-slate-400 py-12">
                <BookOpen className="w-10 h-10 mb-3" />
                <p className="text-sm font-semibold">Select a Version</p>
                <p className="text-xs">Select a version from the left to view and edit its policy.</p>
              </div>
            ) : (
              <div className="space-y-8">
                <div className="flex items-center justify-between gap-2 border-b border-slate-100 pb-4">
                  <div>
                    <p className="text-lg font-extrabold text-slate-900">{tree.version.program_name} — {tree.version.version_label}</p>
                    <p className={text.hint}>Status: <span className="font-bold capitalize">{tree.version.status}</span> · {tree.levels?.length || 0} Levels attached</p>
                    <dl className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-2 text-xs">
                      <div><dt className="text-slate-400 font-semibold uppercase tracking-wide text-[10px]">Effective from</dt><dd className="font-bold text-slate-700 mt-0.5">{tree.version.effective_from || '—'}</dd></div>
                      <div><dt className="text-slate-400 font-semibold uppercase tracking-wide text-[10px]">Effective to</dt><dd className="font-bold text-slate-700 mt-0.5">{tree.version.effective_to || 'Open-ended'}</dd></div>
                      <div><dt className="text-slate-400 font-semibold uppercase tracking-wide text-[10px]">Published</dt><dd className="font-bold text-slate-700 mt-0.5">{tree.version.published_at || 'Not published'}</dd></div>
                      <div><dt className="text-slate-400 font-semibold uppercase tracking-wide text-[10px]">Created by</dt><dd className="font-bold text-slate-700 mt-0.5">{tree.version.created_by_name || '—'}</dd></div>
                    </dl>
                  </div>
                  {tree.version.status !== 'published' && tree.version.status !== 'archived' && (
                    <button type="button" disabled={busy} onClick={() => setShowPublishModal(true)} className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-emerald-600 text-white text-xs font-bold hover:bg-emerald-700 cursor-pointer">
                      <Upload className="w-3.5 h-3.5" /> Publish
                    </button>
                  )}
                </div>

                <div>
                  <h4 className="text-xs font-extrabold text-slate-500 uppercase tracking-wider mb-2 flex items-center gap-1"><Layers className="w-3.5 h-3.5" /> Levels Included</h4>
                  <div className="flex flex-wrap gap-2">
                    {levels.map((level) => (
                      <span key={level.id} className="px-3 py-1.5 rounded-lg bg-slate-100 text-xs font-semibold text-slate-700 border border-slate-200">
                        {level.name}
                      </span>
                    ))}
                    {levels.length === 0 && <span className="text-xs text-slate-400 italic">No levels attached.</span>}
                  </div>
                </div>

                <div className="bg-indigo-50/30 border border-indigo-100 rounded-xl p-5 space-y-5">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-2">
                      <div className="p-2 bg-indigo-100 rounded-lg"><Zap className="w-4 h-4 text-indigo-700" /></div>
                      <div>
                        <h4 className={text.value}>Placement Test V1 Policy</h4>
                        <p className="text-[11px] text-slate-500">One placement domain, two delivery modes, five canonical components, one CEFR decision ladder.</p>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2 justify-end">
                      <span className={`${chipCls} bg-indigo-100 text-indigo-700`}>DIGITAL</span>
                      <span className={`${chipCls} bg-indigo-100 text-indigo-700`}>PHYSICAL</span>
                      <span className={`${chipCls} ${placementConfig.requirementMode === 'not_required' ? 'bg-slate-100 text-slate-500' : 'bg-emerald-100 text-emerald-700'}`}>{placementConfig.requirementMode === 'not_required' ? 'Not required' : 'Canonical V1 active'}</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 @md:grid-cols-2 @4xl:grid-cols-3 gap-3">
                    <div className="rounded-xl border border-slate-200 bg-white px-3 py-3 min-w-0"><label className={labelCls}>Placement requirement</label><select value={placementConfig.requirementMode} onChange={(e) => setPlacementConfig((current) => ({ ...current, requirementMode: e.target.value as PlacementConfigDraft['requirementMode'], firstLevelExempt: e.target.value === 'required' ? current.firstLevelExempt : false }))} className={inputCls}><option value="required">Required</option><option value="optional">Optional (may waive)</option><option value="not_required">Not required</option></select></div>
                    <label className="flex items-center gap-2 text-xs font-bold rounded-xl border border-slate-200 bg-white px-3 py-3 cursor-pointer"><input type="checkbox" disabled={placementConfig.requirementMode !== 'required'} checked={placementConfig.firstLevelExempt} onChange={(e) => setPlacementConfig((current) => ({ ...current, firstLevelExempt: e.target.checked }))} /> Exempt first active level</label>
                    <div className="rounded-xl border border-slate-200 bg-white px-3 py-3 min-w-0"><label className={labelCls}>Attempt expiry (minutes)</label><input type="number" min="1" value={placementConfig.expiresMinutes ?? ''} onChange={(e) => setPlacementConfig((current) => ({ ...current, expiresMinutes: e.target.value === '' ? null : Number(e.target.value) }))} className={inputCls} placeholder="none" /></div>
                    <label className="flex items-center gap-2 text-xs font-bold rounded-xl border border-slate-200 bg-white px-3 py-3 cursor-pointer"><input type="checkbox" checked={placementConfig.allowRetake} onChange={(e) => setPlacementConfig((current) => ({ ...current, allowRetake: e.target.checked }))} /> Allow retakes</label>
                    <div className="rounded-xl border border-slate-200 bg-white px-3 py-3 min-w-0"><label className={labelCls}>Maximum attempts</label><input type="number" min="1" value={placementConfig.maxAttempts ?? ''} onChange={(e) => setPlacementConfig((current) => ({ ...current, maxAttempts: e.target.value === '' ? null : Number(e.target.value) }))} className={inputCls} placeholder="Unlimited" /></div>
                    <div className="rounded-xl border border-indigo-200 bg-white px-3 py-3 min-w-0"><label className={labelCls}>Pass score (0-120)</label><input type="number" min="0" max="120" value={placementConfig.passScore} onChange={(e) => setPlacementConfig((current) => ({ ...current, passScore: Number(e.target.value) }))} className={inputCls} /></div>
                    <label className="flex items-center gap-2 text-xs font-bold rounded-xl border border-slate-200 bg-white px-3 py-3 cursor-pointer"><input type="checkbox" checked={placementConfig.firstAttemptBillable} onChange={(e) => setPlacementConfig((current) => ({ ...current, firstAttemptBillable: e.target.checked }))} /> Bill first attempt</label>
                    <label className="flex items-center gap-2 text-xs font-bold rounded-xl border border-slate-200 bg-white px-3 py-3 cursor-pointer"><input type="checkbox" checked={placementConfig.retakeBillable} onChange={(e) => setPlacementConfig((current) => ({ ...current, retakeBillable: e.target.checked, retakeFeeAmount: e.target.checked ? current.retakeFeeAmount : null }))} /> Bill retakes</label>
                    <div className="rounded-xl border border-slate-200 bg-white px-3 py-3 min-w-0"><label className={labelCls}>Retake fee (AFN)</label><input type="number" min="0" step="1" disabled={!placementConfig.retakeBillable} value={placementConfig.retakeFeeAmount ?? ''} onChange={(e) => setPlacementConfig((current) => ({ ...current, retakeFeeAmount: e.target.value === '' ? null : Number(e.target.value) }))} className={inputCls} placeholder="Branch placement fee" /></div>
                  </div>

                  <div className="rounded-2xl border border-slate-200 bg-white p-4">
                    <div className="flex items-center justify-between gap-3 mb-3">
                      <div>
                        <div className="text-[11px] font-black text-slate-600 uppercase tracking-wide">Canonical components</div>
                        <p className="text-[11px] text-slate-500 mt-1">Component keys, weights, maxima, and delivery convergence are fixed by Placement Test V1.</p>
                      </div>
                      <span className={`${chipCls} bg-slate-100 text-slate-600`}>maxScore:120</span>
                    </div>
                    <div className="space-y-4">
                      {placementConfig.components.map((component) => {
                        const spec = COMPONENT_SPECS[component.key];
                        const bucketTotal = component.blueprintBuckets.reduce((sum, bucket) => sum + Number(bucket.count || 0), 0);
                        return (
                          <div key={component.key} className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4 space-y-4">
                            <div className="flex items-start justify-between gap-3 flex-wrap">
                              <div>
                                <div className="text-sm font-extrabold text-slate-900">{component.label}</div>
                                <div className="text-[11px] text-slate-500 mt-1">{spec.helper}</div>
                              </div>
                              <div className="flex flex-wrap gap-2 text-[10px] font-bold">
                                <span className={`${chipCls} bg-indigo-100 text-indigo-700`}>weight {component.weight}%</span>
                                <span className={`${chipCls} bg-emerald-100 text-emerald-700`}>max {component.maxScore}</span>
                                <span className={`${chipCls} ${bucketTotal === spec.selectionCount ? 'bg-slate-100 text-slate-700' : 'bg-amber-100 text-amber-700'}`}>bucket total {bucketTotal}/{spec.selectionCount}</span>
                              </div>
                            </div>

                            <div className="grid grid-cols-1 @md:grid-cols-3 gap-3">
                              <div className="min-w-0"><label className={labelCls}>Label</label><input value={component.label} onChange={(e) => setComponent(component.key, { label: e.target.value })} className={inputCls} /></div>
                              <div className="min-w-0"><label className={labelCls}>Duration (minutes)</label><input type="number" min="1" value={component.durationMinutes} onChange={(e) => setComponent(component.key, { durationMinutes: Number(e.target.value), timeLimitSeconds: Number(e.target.value) * 60 })} className={inputCls} /></div>
                              <div className="min-w-0"><label className={labelCls}>Timer (seconds)</label><input type="number" min="1" value={component.timeLimitSeconds} onChange={(e) => setComponent(component.key, { timeLimitSeconds: Number(e.target.value) })} className={inputCls} /></div>
                            </div>

                            <div>
                              <label className={labelCls}>Section instructions</label>
                              <input value={component.instructions} onChange={(e) => setComponent(component.key, { instructions: e.target.value })} className={inputCls} placeholder="Examiner guidance for this component" />
                            </div>

                            <div className="rounded-xl border border-slate-200 bg-white p-3 space-y-3">
                              <div className="flex items-center justify-between gap-2 flex-wrap">
                                <div className="text-[11px] font-black text-slate-600 uppercase tracking-wide">Active bank selection</div>
                                <div className="text-[11px] text-slate-500">Pick one or more active {component.key} banks.</div>
                              </div>
                              {testsByComponent[component.key].length === 0 ? (
                                <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">No active {component.key} banks are available in the current branch scope.</div>
                              ) : (
                                <div className="grid grid-cols-1 @md:grid-cols-2 gap-2">
                                  {testsByComponent[component.key].map((test) => (
                                    <label key={test.id} className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs cursor-pointer">
                                      <input type="checkbox" checked={component.bankIds.includes(test.id)} onChange={(e) => toggleBank(component.key, test.id, e.target.checked)} />
                                      <span>
                                        <span className="font-semibold text-slate-700">{test.title}</span>
                                        <span className="block text-[11px] text-slate-500">{test.testType} · v{test.version ?? 1}</span>
                                      </span>
                                    </label>
                                  ))}
                                </div>
                              )}
                            </div>

                            <div className="rounded-xl border border-slate-200 bg-white p-3 space-y-3">
                              <div className="flex items-center justify-between gap-2 flex-wrap">
                                <div>
                                  <div className="text-[11px] font-black text-slate-600 uppercase tracking-wide">Blueprint buckets</div>
                                  <p className="text-[11px] text-slate-500 mt-1">Counts across all buckets must total {spec.selectionCount}. Productive skills should usually stay at one bucket.</p>
                                </div>
                                <button type="button" onClick={() => addBucket(component.key)} className="inline-flex items-center gap-1 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-[11px] font-bold text-indigo-700 cursor-pointer">
                                  <Plus className="w-3 h-3" /> Add bucket
                                </button>
                              </div>
                              <div className="space-y-3">
                                {component.blueprintBuckets.map((bucket, bucketIndex) => (
                                  <div key={`${component.key}-${bucketIndex}`} className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-3">
                                    <div className="flex items-center justify-between gap-2">
                                      <div className="text-[11px] font-bold text-slate-600">Bucket {bucketIndex + 1}</div>
                                      <button type="button" disabled={component.blueprintBuckets.length <= 1} onClick={() => removeBucket(component.key, bucketIndex)} className="text-rose-500 disabled:text-slate-300 cursor-pointer">
                                        <Trash2 className="w-3.5 h-3.5" />
                                      </button>
                                    </div>
                                    <div className="grid grid-cols-1 @md:grid-cols-3 gap-3">
                                      <div className="min-w-0"><label className={labelCls}>Count</label><input type="number" min="1" value={bucket.count} onChange={(e) => updateBucket(component.key, bucketIndex, { count: Number(e.target.value) })} className={inputCls} /></div>
                                      <div className="min-w-0"><label className={labelCls}>CEFR</label><select value={bucket.cefrLevel} onChange={(e) => updateBucket(component.key, bucketIndex, { cefrLevel: e.target.value as BlueprintBucketDraft['cefrLevel'] })} className={inputCls}><option value="ANY">ANY</option>{CEFR_ORDER.map((level) => <option key={level} value={level}>{level}</option>)}</select></div>
                                      <div className="min-w-0"><label className={labelCls}>Difficulty</label><select value={bucket.difficulty} onChange={(e) => updateBucket(component.key, bucketIndex, { difficulty: e.target.value as Difficulty })} className={inputCls}>{DIFFICULTIES.map((difficulty) => <option key={difficulty} value={difficulty}>{difficulty}</option>)}</select></div>
                                    </div>
                                    <div>
                                      <label className={labelCls}>Allowed question types</label>
                                      <div className="flex flex-wrap gap-2">
                                        {spec.allowedQtypes.map((qtype) => (
                                          <label key={qtype} className="px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 text-[10px] font-bold cursor-pointer">
                                            <input type="checkbox" className="me-1.5" checked={bucket.qtypes.includes(qtype)} onChange={(e) => toggleBucketQtype(component.key, bucketIndex, qtype, e.target.checked)} />
                                            {qtype}
                                          </label>
                                        ))}
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-slate-200 bg-white p-4">
                    <div className="flex items-center justify-between gap-3 mb-3">
                      <div>
                        <div className="text-[11px] font-black text-slate-600 uppercase tracking-wide">CEFR decision ladder</div>
                        <p className="text-[11px] text-slate-500 mt-1">Each row defines the minimum score required in all five components for that CEFR outcome.</p>
                      </div>
                      <span className={`${chipCls} bg-slate-100 text-slate-700`}>one CEFR authority</span>
                    </div>
                    <div className="space-y-3">
                      {placementConfig.decisionRules.map((rule) => (
                        <div key={rule.cefrLevel} className="rounded-xl border border-slate-200 bg-slate-50/60 p-4 space-y-3">
                          <div className="grid grid-cols-1 @md:grid-cols-3 gap-3 items-end">
                            <div>
                              <label className={labelCls}>CEFR level</label>
                              <div className="h-[38px] rounded-lg border border-slate-200 bg-white px-3 flex items-center text-xs font-black text-slate-700">{rule.cefrLevel}</div>
                            </div>
                            <div>
                              <label className={labelCls}>Recommended TOEFL House level</label>
                              <select value={rule.recommendedLevelId} onChange={(e) => setPlacementConfig((current) => ({ ...current, decisionRules: current.decisionRules.map((candidate) => candidate.cefrLevel === rule.cefrLevel ? { ...candidate, recommendedLevelId: e.target.value } : candidate) }))} className={inputCls}>
                                <option value="">Select level…</option>
                                {levels.map((level) => <option key={level.id} value={level.id}>{level.code ? `${level.code} — ` : ''}{level.name}</option>)}
                              </select>
                            </div>
                            <div>
                              <label className={labelCls}>Rule label</label>
                              <input value={rule.label || ''} onChange={(e) => setPlacementConfig((current) => ({ ...current, decisionRules: current.decisionRules.map((candidate) => candidate.cefrLevel === rule.cefrLevel ? { ...candidate, label: e.target.value } : candidate) }))} className={inputCls} />
                            </div>
                          </div>
                          <div className="grid grid-cols-1 @md:grid-cols-2 @4xl:grid-cols-5 gap-3">
                            {COMPONENT_ORDER.map((key) => (
                              <div key={key}>
                                <label className={labelCls}>{COMPONENT_SPECS[key].label} minimum</label>
                                <input type="number" min="0" max={COMPONENT_SPECS[key].maxScore} value={rule.minimumScores[key]} onChange={(e) => setRuleScore(rule.cefrLevel, key, Number(e.target.value))} className={inputCls} />
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className={labelCls}>Overall policy notes</label>
                    <textarea value={placementConfig.instructions} onChange={(e) => setPlacementConfig((current) => ({ ...current, instructions: e.target.value }))} className={inputCls} rows={4} placeholder="Optional guidance for examiners and operators" />
                  </div>

                  <div className="flex justify-end">
                    <button type="button" disabled={busy || !selectedId} onClick={savePlacementProfile} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 text-white text-xs font-bold cursor-pointer disabled:opacity-50">
                      <Save className="w-3.5 h-3.5" /> Save Placement Test V1 Policy
                    </button>
                  </div>
                </div>

                <div className="bg-emerald-50/30 border border-emerald-100 rounded-xl p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <div className="p-2 bg-emerald-100 rounded-lg"><Zap className="w-4 h-4 text-emerald-700" /></div>
                    <div>
                      <h4 className={text.value}>Promotion Rules</h4>
                      <p className="text-[11px] text-slate-500">Define criteria for passing a level and moving to the next.</p>
                    </div>
                  </div>

                  <form className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-4" onSubmit={(e) => e.preventDefault()}>
                    <div className="min-w-0"><label className={labelCls}>Rule Name</label><input className={inputCls} value={promoForm.name} onChange={(e) => setPromoForm({ ...promoForm, name: e.target.value })} placeholder="e.g. Pass Mark" /></div>
                    <div className="min-w-0"><label className={labelCls}>Min Exam Score (0-100)</label><input type="number" className={inputCls} value={promoForm.minScore} onChange={(e) => setPromoForm({ ...promoForm, minScore: Number(e.target.value) })} /></div>
                    <div className="min-w-0"><label className={labelCls}>Min Attendance %</label><input type="number" className={inputCls} value={promoForm.minAttendancePct} onChange={(e) => setPromoForm({ ...promoForm, minAttendancePct: Number(e.target.value) })} /></div>
                    <div className="min-w-0"><label className={labelCls}>From Level</label><select className={inputCls} value={promoForm.fromLevelId} onChange={(e) => setPromoForm({ ...promoForm, fromLevelId: e.target.value })}><option value="">Any Level</option>{levels.map((level) => <option key={level.id} value={level.id}>{level.name}</option>)}</select></div>
                    <div className="min-w-0"><label className={labelCls}>To Level</label><select className={inputCls} value={promoForm.toLevelId} onChange={(e) => setPromoForm({ ...promoForm, toLevelId: e.target.value })}><option value="">Next Level</option>{levels.map((level) => <option key={level.id} value={level.id}>{level.name}</option>)}</select></div>
                    <div className="flex items-end"><button type="button" disabled={busy} onClick={addPromotion} className="w-full py-2 rounded-lg bg-emerald-600 text-white text-xs font-bold disabled:opacity-50 cursor-pointer flex items-center justify-center gap-1"><Plus className="w-3 h-3" /> Add Rule</button></div>
                  </form>

                  <div className="space-y-2 pt-3 border-t border-emerald-100">
                    {(tree.promotionRules || []).map((rule) => (
                      <div key={rule.id} className="flex justify-between items-center bg-white px-3 py-2 rounded-lg border border-slate-100 text-xs">
                        <span className="text-slate-700 font-medium">{rule.name}: Score ≥ <b>{rule.min_score}</b>, Attendance ≥ <b>{rule.min_attendance_pct}%</b></span>
                        <button type="button" onClick={() => deletePromotionRule(rule.id)} className="text-rose-400 hover:text-rose-600"><Trash2 className="w-3 h-3" /></button>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="bg-amber-50 border border-amber-100 rounded-xl p-5">
                  <div className="flex items-start gap-3">
                    <div className="p-2 bg-amber-100 rounded-lg text-amber-700 font-black">$</div>
                    <div>
                      <h4 className={text.value}>Fee configuration has one owner</h4>
                      <p className="text-[11px] text-slate-600 mt-1 leading-relaxed">Program and level fees remain configured in the Academic Catalog. This version screen intentionally does not create a second fee registry or a parallel placement rule engine.</p>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {showPublishModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4 animate-in fade-in duration-200" onClick={() => setShowPublishModal(false)}>
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md p-6 border border-slate-200" onClick={(event) => event.stopPropagation()}>
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-extrabold text-slate-900">Confirm Publish</h3>
              <button type="button" onClick={() => setShowPublishModal(false)} className="p-2 hover:bg-slate-100 rounded-xl text-slate-500"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-sm text-slate-600 mb-6">Publishing this version will make it the active curriculum for new enrollments. Any previously published version for this program will be archived. Are you sure?</p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowPublishModal(false)} className="px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-100 rounded-xl transition-colors cursor-pointer">Cancel</button>
              <button type="button" onClick={publish} className="px-5 py-2 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl shadow-sm transition-colors cursor-pointer">Yes, Publish Now</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
