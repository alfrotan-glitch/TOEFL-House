import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Clock3,
  FileText,
  Loader2,
  MessageSquareText,
  Mic,
  Pause,
  Play,
  Save,
  ShieldCheck,
  Timer,
  X,
} from 'lucide-react';
import { api } from '../../api/client';
import { useInvalidate } from '../../state/serverStateFreshness';
import type { Visitor } from '../../types';

type DeliveryMode = 'DIGITAL' | 'PHYSICAL';
type ComponentType = 'grammar' | 'reading' | 'listening' | 'writing' | 'speaking';
type PlacementDecision = 'REQUIRED' | 'NOT_REQUIRED' | 'EXEMPT' | 'CONFIGURATION_ERROR' | 'INVALID_CONTEXT';

interface ComponentConfig {
  key: ComponentType;
  type: ComponentType;
  label: string;
  required: boolean;
  weight: number;
  maxScore: number;
  durationMinutes?: number | null;
  timeLimitSeconds?: number | null;
  instructions?: string | null;
  testId?: string;
}

interface TestQuestion {
  id: string;
  questionKey: string;
  qtype: string;
  prompt: string;
  optionsJson: string | null;
  points: number;
  sectionKey?: string | null;
  difficulty?: string | null;
}

interface TestSection {
  key: string;
  title?: string | null;
  kind: string;
  audioUrl?: string | null;
  transcript?: string | null;
  body?: string | null;
  durationSeconds?: number | null;
}

interface TestRubric {
  id: string;
  title?: string | null;
  criteria: Array<{ key: string; label: string; weight: number; maxScore: number }>;
}

interface SnapshotTest {
  id: string;
  componentKey: ComponentType;
  title: string;
  testType: ComponentType;
  instructions?: string | null;
  durationSeconds?: number | null;
  rubric?: TestRubric | null;
  sections?: TestSection[];
  questions: TestQuestion[];
}

interface PlacementProfile {
  configured: boolean;
  enabled: boolean;
  required: boolean;
  requirementMode?: string;
  policyVersion?: number;
  programName?: string;
  versionLabel?: string;
  instructions?: string | null;
  components: ComponentConfig[];
  levels: Array<{ id: string; name: string; code?: string | null }>;
  allowRetake: boolean;
  passScore: number;
  scoringModel: 'canonical';
  deliveryModes: DeliveryMode[];
}

interface AttemptResult {
  componentKey: ComponentType;
  componentType: ComponentType;
  label: string;
  status: string;
  score: number | null;
  maxScore: number;
  weight: number;
  selectedLevelId?: string | null;
  notes?: string | null;
  resultText?: string | null;
  payloadJson?: string | null;
  startedAt?: string | null;
  deadlineAt?: string | null;
  elapsedSeconds?: number | null;
  timeoutFlag?: number | null;
  rawScore?: number | null;
  percentage?: number | null;
}

interface AttemptSnapshot {
  deliveryMode?: DeliveryMode;
  tests?: SnapshotTest[];
  components?: ComponentConfig[];
}

interface Attempt {
  id: string;
  attemptNumber: number;
  status: string;
  percentage?: number | null;
  recommendationText?: string | null;
  expiresAt?: string | null;
  deliveryMode?: DeliveryMode;
  snapshot?: AttemptSnapshot;
  results: AttemptResult[];
}

interface Requirement {
  mode: string;
  decision?: PlacementDecision;
  reason?: string;
  firstLevelExemptApplied?: boolean;
  policySource?: string;
}

interface Props {
  visitor: Visitor;
  onClose: () => void;
  onCompleted: () => Promise<void>;
  triggerToast: (message: string, type: 'success' | 'error' | 'info') => void;
}

const DECISION_PRESENTATION: Record<PlacementDecision, { tone: 'ok' | 'warn' | 'error'; title: string; body: string }> = {
  NOT_REQUIRED: { tone: 'ok', title: 'Placement not required', body: 'The policy for this program version does not require a placement assessment.' },
  EXEMPT: { tone: 'ok', title: 'Candidate is exempt', body: 'This candidate is exempt from placement because the selected level qualifies for the first-level exemption.' },
  CONFIGURATION_ERROR: { tone: 'error', title: 'Placement policy is not configured', body: 'Enrollment is blocked until an administrator configures this program version’s Placement Test V1 policy.' },
  INVALID_CONTEXT: { tone: 'error', title: 'Program selection is incomplete', body: 'Select a valid program version on the visitor record before starting placement.' },
  REQUIRED: { tone: 'warn', title: 'Placement required', body: 'This program requires a placement assessment.' },
};

const componentIcons: Record<ComponentType, React.ReactNode> = {
  grammar: <FileText className="w-4 h-4" />,
  reading: <BookOpen className="w-4 h-4" />,
  listening: <Mic className="w-4 h-4" />,
  writing: <MessageSquareText className="w-4 h-4" />,
  speaking: <Mic className="w-4 h-4" />,
};

function fmtRemaining(seconds: number | null | undefined): string {
  if (seconds == null) return '—';
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function parsePayload(payload: string | null | undefined) {
  if (!payload) return {} as Record<string, unknown>;
  try { return JSON.parse(payload) as Record<string, unknown>; } catch { return {}; }
}

function parseOptions(question: TestQuestion): Array<{ key: string; text: string }> {
  if (!question.optionsJson) return [];
  try {
    const parsed = JSON.parse(question.optionsJson) as Array<{ key: string; text: string }>;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export default function PlacementTestModal({ visitor, onClose, onCompleted, triggerToast }: Props) {
  const invalidate = useInvalidate();
  const [profile, setProfile] = useState<PlacementProfile | null>(null);
  const [requirement, setRequirement] = useState<Requirement | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [admissionRequired, setAdmissionRequired] = useState(false);
  const [linkedStudentId, setLinkedStudentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>('DIGITAL');
  const [activeKey, setActiveKey] = useState<ComponentType | ''>('');
  const [starting, setStarting] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [savingKey, setSavingKey] = useState<ComponentType | null>(null);
  const [submittingKey, setSubmittingKey] = useState<ComponentType | null>(null);
  const [completing, setCompleting] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, any>>({});
  const [answers, setAnswers] = useState<Record<string, Record<string, string>>>({});
  const [feedback, setFeedback] = useState<Record<string, Record<string, string>>>({});
  const [autoScore, setAutoScore] = useState<Record<string, { earned: number; max: number; complete: boolean; answered: number }>>({});
  const [nowTick, setNowTick] = useState<number>(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const currentTests = useMemo(() => attempt?.snapshot?.tests || [], [attempt]);

  const testFor = (componentKey: ComponentType) => currentTests.find((test) => test.componentKey === componentKey) || null;

  const remainingFor = (componentKey: ComponentType): number | null => {
    const result = attempt?.results.find((row) => row.componentKey === componentKey);
    if (!result?.deadlineAt) return null;
    const deadlineMs = new Date(result.deadlineAt.replace(' ', 'T') + 'Z').getTime();
    return Math.max(0, Math.round((deadlineMs - nowTick) / 1000));
  };

  const timedOutFor = (componentKey: ComponentType): boolean => {
    const result = attempt?.results.find((row) => row.componentKey === componentKey);
    if (!result) return false;
    if (result.timeoutFlag === 1 || result.status === 'timed_out') return true;
    return !!(result.deadlineAt && result.status !== 'completed' && result.status !== 'waived' && remainingFor(componentKey) === 0);
  };

  const loadWorkspace = async () => {
    const data = await api.get<any>(`/placement/visitors/${visitor.id}/placement`);
    setProfile(data.profile);
    setRequirement(data.requirement);
    setAdmissionRequired(Boolean(data.admissionRequired));
    setLinkedStudentId(data.linkedStudentId ?? null);
    setDeliveryMode((data.profile?.deliveryModes || ['DIGITAL'])[0]);
    const current = data.current as Attempt | null;
    setAttempt(current);
    const nextDrafts: Record<string, any> = {};
    const nextAnswers: Record<string, Record<string, string>> = {};
    for (const result of current?.results || []) {
      const payload = parsePayload(result.payloadJson);
      nextDrafts[result.componentKey] = {
        score: result.score ?? '',
        notes: result.notes ?? '',
        resultText: result.resultText ?? '',
        selectedLevelId: result.selectedLevelId ?? '',
        criteriaScores: (payload.criteriaScores as Record<string, number> | undefined) ?? {},
      };
    }
    for (const response of (current as any)?.responses || []) {
      const componentTest = current?.snapshot?.tests?.find((test) => test.id === response.testId);
      const componentKey = componentTest?.componentKey;
      if (!componentKey) continue;
      nextAnswers[componentKey] = nextAnswers[componentKey] || {};
      nextAnswers[componentKey][response.questionKey] = typeof response.response === 'string' ? response.response : '';
    }
    setDrafts(nextDrafts);
    setAnswers(nextAnswers);
    const availableKeys = new Set<string>([
      ...(current?.snapshot?.components?.map((entry) => entry.key) || []),
      ...(data.profile?.components?.map((entry: ComponentConfig) => entry.key) || []),
    ]);
    const fallbackKey = current?.snapshot?.components?.[0]?.key || data.profile?.components?.[0]?.key || '';
    setActiveKey((previous) => (previous && availableKeys.has(previous) ? previous : fallbackKey));
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        await loadWorkspace();
      } catch (error: any) {
        if (!cancelled) triggerToast(error?.message || 'Unable to load placement workspace.', 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visitor.id]);

  const objectiveIsDigital = (component: ComponentConfig) => {
    const mode = attempt?.deliveryMode || attempt?.snapshot?.deliveryMode || deliveryMode;
    return mode === 'DIGITAL' && ['grammar', 'reading', 'listening'].includes(component.type);
  };

  const writingIsDigital = (component: ComponentConfig) => {
    const mode = attempt?.deliveryMode || attempt?.snapshot?.deliveryMode || deliveryMode;
    return mode === 'DIGITAL' && component.type === 'writing';
  };

  const startAttempt = async () => {
    if (admissionRequired) {
      triggerToast('Admit this candidate to a student record before starting placement.', 'error');
      return;
    }
    setStarting(true);
    try {
      await api.post(`/placement/visitors/${visitor.id}/placement/attempts`, { deliveryMode });
      invalidate('placement');
      triggerToast('Placement attempt started.', 'success');
      await loadWorkspace();
    } catch (error: any) {
      triggerToast(error?.message || 'Could not start the assessment.', 'error');
    } finally {
      setStarting(false);
    }
  };

  const skipOptional = async () => {
    if (admissionRequired) {
      triggerToast('Admit this candidate to a student record before resolving placement.', 'error');
      return;
    }
    setSkipping(true);
    try {
      await api.post(`/placement/visitors/${visitor.id}/placement/attempts`, { skip: true, reason: 'Candidate opted to skip optional placement.' });
      invalidate('placement');
      triggerToast('Placement skipped.', 'success');
      await onCompleted();
    } catch (error: any) {
      triggerToast(error?.message || 'Could not record the skip.', 'error');
    } finally {
      setSkipping(false);
    }
  };

  const startTimer = async (component: ComponentConfig) => {
    if (!attempt) return;
    try {
      await api.put(`/placement/visitors/${visitor.id}/placement/attempts/${attempt.id}/tests/${component.key}/start`, {});
      invalidate('placement');
      await loadWorkspace();
    } catch (error: any) {
      triggerToast(error?.message || 'Could not start the timer.', 'error');
    }
  };

  const submitResponses = async (component: ComponentConfig) => {
    if (!attempt) return;
    const test = testFor(component.key);
    if (!test) return;
    const payloadAnswers = Object.entries(answers[component.key] || {}).map(([questionKey, response]) => ({ questionKey, response }));
    if (payloadAnswers.length === 0) {
      triggerToast('Enter at least one response before submitting.', 'error');
      return;
    }
    setSubmittingKey(component.key);
    try {
      const response = await api.put<any>(`/placement/visitors/${visitor.id}/placement/attempts/${attempt.id}/tests/${component.key}/responses`, {
        answers: payloadAnswers,
      });
      invalidate('placement');
      setFeedback((prev) => ({ ...prev, [component.key]: response.feedback || {} }));
      setAutoScore((prev) => ({ ...prev, [component.key]: { earned: response.autoScore, max: response.maxScore, complete: response.complete, answered: response.answered } }));
      await loadWorkspace();
      triggerToast(response.complete ? `${component.label} submitted and scored.` : `${component.label} responses saved.`, 'success');
    } catch (error: any) {
      triggerToast(error?.message || 'Could not submit responses.', 'error');
    } finally {
      setSubmittingKey(null);
    }
  };

  const saveComponent = async (component: ComponentConfig) => {
    if (!attempt) return;
    const draft = drafts[component.key] || {};
    setSavingKey(component.key);
    try {
      const payload: Record<string, unknown> = {
        notes: draft.notes || null,
        resultText: draft.resultText || null,
        selectedLevelId: draft.selectedLevelId || null,
      };
      if (component.type === 'grammar' || component.type === 'reading' || component.type === 'listening') {
        payload.score = Number(draft.score);
      } else if (draft.criteriaScores && Object.keys(draft.criteriaScores).length > 0) {
        payload.criteriaScores = draft.criteriaScores;
      } else {
        payload.score = Number(draft.score);
      }
      await api.put(`/placement/visitors/${visitor.id}/placement/attempts/${attempt.id}/components/${component.key}`, payload);
      invalidate('placement');
      await loadWorkspace();
      triggerToast(`${component.label} saved.`, 'success');
    } catch (error: any) {
      triggerToast(error?.message || 'Could not save the section.', 'error');
    } finally {
      setSavingKey(null);
    }
  };

  const completeAttempt = async () => {
    if (!attempt) return;
    setCompleting(true);
    try {
      const result = await api.post<any>(`/placement/visitors/${visitor.id}/placement/attempts/${attempt.id}/complete`, {});
      invalidate('placement');
      const failed = result?.outcome === 'failed';
      triggerToast(
        failed
          ? `Placement recorded as not passed.${result?.failureReasons?.length ? ` ${result.failureReasons.join(' ')}` : ''}`
          : `Placement completed — ${result?.decision?.recommendationText || 'decision recorded'}`,
        failed ? 'error' : 'success',
      );
      await onCompleted();
    } catch (error: any) {
      triggerToast(error?.message || 'Could not complete the assessment.', 'error');
    } finally {
      setCompleting(false);
    }
  };

  const pauseAttempt = async () => {
    if (!attempt) return;
    setPausing(true);
    try {
      await api.post(`/placement/visitors/${visitor.id}/placement/attempts/${attempt.id}/pause`, { reason: 'Paused by operator' });
      invalidate('placement');
      await loadWorkspace();
    } catch (error: any) {
      triggerToast(error?.message || 'Could not pause the attempt.', 'error');
    } finally {
      setPausing(false);
    }
  };

  const resumeAttempt = async () => {
    if (!attempt) return;
    setPausing(true);
    try {
      await api.post(`/placement/visitors/${visitor.id}/placement/attempts/${attempt.id}/resume`, {});
      invalidate('placement');
      await loadWorkspace();
    } catch (error: any) {
      triggerToast(error?.message || 'Could not resume the attempt.', 'error');
    } finally {
      setPausing(false);
    }
  };

  const doneCount = useMemo(() => (attempt?.results || []).filter((result) => result.status === 'completed' || result.status === 'waived').length, [attempt]);
  const totalCount = useMemo(() => (attempt?.results || []).length, [attempt]);

  if (loading) {
    return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40"><div className="rounded-2xl bg-white px-6 py-5 font-bold text-slate-600 shadow-2xl"><Loader2 className="me-2 inline h-4 w-4 animate-spin" />Loading placement workspace…</div></div>;
  }

  if (requirement && requirement.mode === 'not_required') {
    const decision: PlacementDecision = requirement.decision ?? (requirement.firstLevelExemptApplied ? 'EXEMPT' : 'NOT_REQUIRED');
    const view = DECISION_PRESENTATION[decision];
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
        <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl" onClick={(event) => event.stopPropagation()}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className={`flex h-10 w-10 items-center justify-center rounded-2xl ${view.tone === 'ok' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{view.tone === 'ok' ? <ShieldCheck className="h-5 w-5" /> : <AlertTriangle className="h-5 w-5" />}</span>
              <h3 className="font-black text-slate-800">{view.title}</h3>
            </div>
            <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button>
          </div>
          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">{view.body}</div>
          <button onClick={onClose} className="mt-5 w-full rounded-xl bg-slate-800 py-3 text-sm font-black text-white">Close</button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-3">
      <div className="flex max-h-[94vh] w-full max-w-6xl flex-col rounded-3xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
          <div>
            <h3 className="font-black text-slate-900">Placement Assessment — {visitor.fullName}</h3>
            <p className="text-[11px] text-slate-500">{profile?.programName}{profile?.versionLabel ? ` · ${profile.versionLabel}` : ''}{linkedStudentId ? ` · Student linked` : ''}</p>
          </div>
          <div className="flex items-center gap-2">
            {attempt?.status === 'in_progress' && <button onClick={pauseAttempt} disabled={pausing} className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50"><Pause className="me-1 inline h-3.5 w-3.5" />Pause</button>}
            {attempt?.status === 'paused' && <button onClick={resumeAttempt} disabled={pausing} className="rounded-xl bg-emerald-600 px-3 py-2 text-xs font-black text-white hover:bg-emerald-700"><Play className="me-1 inline h-3.5 w-3.5" />Resume</button>}
            <button onClick={onClose} className="rounded-xl p-2 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {admissionRequired && !attempt && (
            <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-600" />
                <div>
                  <p className="font-black">Admission required before placement</p>
                  <p className="mt-1 text-xs text-amber-800">
                    Placement billing now uses the student financial identity first. Admit this candidate to a student record, then return here to start the assessment.
                  </p>
                </div>
              </div>
            </div>
          )}
          {!attempt && (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-6 text-center">
              <p className="text-sm text-slate-600">{profile?.instructions || 'Start the Placement Test V1 workflow when the candidate is ready.'}</p>
              <div className="mx-auto mt-4 max-w-xs text-start">
                <label className="mb-1 block text-[11px] font-black uppercase tracking-wide text-slate-500">Delivery mode</label>
                <select value={deliveryMode} onChange={(event) => setDeliveryMode(event.target.value as DeliveryMode)} className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm">
                  {(profile?.deliveryModes || ['DIGITAL', 'PHYSICAL']).map((mode) => <option key={mode} value={mode}>{mode}</option>)}
                </select>
              </div>
              <div className="mt-5 flex items-center justify-center gap-2">
                {requirement?.mode === 'optional' && <button onClick={skipOptional} disabled={skipping || admissionRequired} className="rounded-xl border border-amber-300 px-4 py-3 text-xs font-black text-amber-700 hover:bg-amber-50 disabled:opacity-50">{skipping ? <Loader2 className="me-1 inline h-4 w-4 animate-spin" /> : null}Skip optional placement</button>}
                <button onClick={startAttempt} disabled={starting || admissionRequired} className="rounded-xl bg-indigo-600 px-5 py-3 text-sm font-black text-white hover:bg-indigo-700 disabled:opacity-50">{starting ? <Loader2 className="me-2 inline h-4 w-4 animate-spin" /> : null}Start assessment</button>
              </div>
            </div>
          )}

          {attempt && (
            <>
              <div className="mb-5 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {attempt.results.map((result) => {
                  const remaining = remainingFor(result.componentKey);
                  const timedOut = timedOutFor(result.componentKey);
                  return (
                    <button key={result.componentKey} onClick={() => setActiveKey(result.componentKey)} className={`rounded-2xl border p-4 text-start ${activeKey === result.componentKey ? 'border-indigo-400 bg-indigo-50/60' : 'border-slate-200 bg-white hover:border-slate-300'}`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-2 text-sm font-black text-slate-800">{componentIcons[result.componentType]}{result.label}</span>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-black uppercase ${result.status === 'completed' ? 'bg-emerald-100 text-emerald-700' : timedOut ? 'bg-rose-100 text-rose-700' : result.status === 'in_progress' ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-500'}`}>{timedOut ? 'timed out' : result.status}</span>
                      </div>
                      <div className="mt-3 flex items-center justify-between text-[11px] text-slate-500">
                        <span className="font-mono">{result.score ?? '–'}/{result.maxScore}</span>
                        <span className="flex items-center gap-1 font-mono"><Clock3 className="h-3 w-3" />{fmtRemaining(remaining)}</span>
                      </div>
                    </button>
                  );
                })}
              </div>

              <div className="mb-5 flex items-center gap-3">
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100"><div className="h-full bg-indigo-600" style={{ width: `${totalCount ? Math.round((doneCount / totalCount) * 100) : 0}%` }} /></div>
                <span className="text-[11px] font-black text-slate-500">{doneCount}/{totalCount} complete</span>
                <button onClick={completeAttempt} disabled={completing || doneCount < totalCount || attempt.status !== 'in_progress'} className="rounded-xl bg-emerald-600 px-4 py-2.5 text-xs font-black text-white hover:bg-emerald-700 disabled:opacity-40">{completing ? <Loader2 className="me-1 inline h-4 w-4 animate-spin" /> : <CheckCircle2 className="me-1 inline h-4 w-4" />}Complete & decide</button>
              </div>

              {activeKey && profile && (
                <ActiveEditor
                  component={profile.components.find((entry) => entry.key === activeKey) || null}
                  result={attempt.results.find((entry) => entry.componentKey === activeKey) || null}
                  test={testFor(activeKey)}
                  draft={drafts[activeKey] || {}}
                  answers={answers[activeKey] || {}}
                  feedback={feedback[activeKey] || {}}
                  autoScore={autoScore[activeKey] || null}
                  timedOut={timedOutFor(activeKey)}
                  remaining={remainingFor(activeKey)}
                  attempt={attempt}
                  objectiveIsDigital={objectiveIsDigital}
                  writingIsDigital={writingIsDigital}
                  onStartTimer={startTimer}
                  onPatchDraft={(patch: any) => setDrafts((prev) => ({ ...prev, [activeKey]: { ...(prev[activeKey] || {}), ...patch } }))}
                  onPatchAnswer={(questionKey: string, value: string) => setAnswers((prev) => ({ ...prev, [activeKey]: { ...(prev[activeKey] || {}), [questionKey]: value } }))}
                  onSubmitResponses={submitResponses}
                  onSave={saveComponent}
                  saving={savingKey === activeKey}
                  submitting={submittingKey === activeKey}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ActiveEditor(props: {
  component: ComponentConfig | null;
  result: AttemptResult | null;
  test: SnapshotTest | null;
  draft: any;
  answers: Record<string, string>;
  feedback: Record<string, string>;
  autoScore: { earned: number; max: number; complete: boolean; answered: number } | null;
  timedOut: boolean;
  remaining: number | null;
  attempt: Attempt;
  objectiveIsDigital: (component: ComponentConfig) => boolean;
  writingIsDigital: (component: ComponentConfig) => boolean;
  onStartTimer: (component: ComponentConfig) => void;
  onPatchDraft: (patch: any) => void;
  onPatchAnswer: (questionKey: string, value: string) => void;
  onSubmitResponses: (component: ComponentConfig) => void;
  onSave: (component: ComponentConfig) => void;
  saving: boolean;
  submitting: boolean;
}) {
  const {
    component,
    result,
    test,
    draft,
    answers,
    feedback,
    autoScore,
    timedOut,
    remaining,
    attempt,
    objectiveIsDigital,
    writingIsDigital,
    onStartTimer,
    onPatchDraft,
    onPatchAnswer,
    onSubmitResponses,
    onSave,
    saving,
    submitting,
  } = props;

  if (!component || !result) return null;
  const showManualSave = !objectiveIsDigital(component);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-black text-slate-900">{componentIcons[component.type]}{component.label}</div>
          <p className="mt-1 text-[11px] text-slate-500">{component.instructions || 'Use the canonical Placement Test V1 workflow for this section.'}</p>
        </div>
        <div className="flex items-center gap-2">
          {!result.startedAt && attempt.status === 'in_progress' && <button onClick={() => onStartTimer(component)} className="rounded-xl bg-indigo-600 px-3 py-2 text-[11px] font-black text-white hover:bg-indigo-700"><Timer className="me-1 inline h-3.5 w-3.5" />Start timer</button>}
          {result.startedAt && <span className={`rounded-xl px-3 py-2 text-xs font-black font-mono ${timedOut ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-700'}`}>{timedOut ? 'TIMED OUT' : fmtRemaining(remaining)}</span>}
        </div>
      </div>

      {test && (
        <div className="mb-4 rounded-2xl border border-indigo-100 bg-indigo-50/40 p-4">
          <div className="text-[11px] font-black uppercase tracking-wide text-indigo-700">{test.testType} · {test.title}</div>
          <div className="mt-1 text-xs text-slate-600">{test.instructions || 'Follow the prompt and record the official result.'}</div>
          {(test.sections || []).map((section) => (
            <div key={section.key} className="mt-3 rounded-xl border border-slate-100 bg-white p-3">
              {section.title && <div className="text-[10px] font-black uppercase tracking-wide text-slate-500">{section.title}</div>}
              {section.audioUrl && <audio controls src={section.audioUrl} className="mt-2 w-full" />}
              {section.body && <div className="mt-2 whitespace-pre-wrap text-xs text-slate-700">{section.body}</div>}
              {section.transcript && <details className="mt-2"><summary className="cursor-pointer text-[10px] font-bold text-indigo-600">Show transcript</summary><div className="mt-1 whitespace-pre-wrap text-xs text-slate-600">{section.transcript}</div></details>}
            </div>
          ))}
        </div>
      )}

      {objectiveIsDigital(component) && test && (
        <div className="space-y-3">
          {test.questions.map((question, index) => {
            const section = (test.sections || []).find((item) => item.key === question.sectionKey);
            const value = answers[question.questionKey] || '';
            const options = parseOptions(question);
            return (
              <div key={question.id} className="rounded-xl border border-slate-200 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-sm font-bold text-slate-800">
                    {section?.title && <span className="mb-1 block text-[10px] uppercase tracking-wide text-slate-400">{section.title}</span>}
                    {index + 1}. {question.prompt}
                  </div>
                  <span className="text-[10px] font-mono text-slate-400">{question.points} pt</span>
                </div>
                {question.qtype === 'mcq' && <div className="mt-3 space-y-1.5">{options.map((option) => <label key={option.key} className="flex cursor-pointer items-center gap-2 text-xs text-slate-700"><input type="radio" name={question.questionKey} checked={value === option.key} onChange={() => onPatchAnswer(question.questionKey, option.key)} className="accent-indigo-600" />{option.text}</label>)}</div>}
                {question.qtype !== 'mcq' && <input value={value} onChange={(event) => onPatchAnswer(question.questionKey, event.target.value)} className="mt-3 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" placeholder="Enter answer…" />}
                {feedback[question.questionKey] && <div className="mt-2 text-[11px] font-bold text-slate-500">{feedback[question.questionKey]}</div>}
              </div>
            );
          })}
          <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
            <span>{autoScore ? `${autoScore.answered} answered · ${autoScore.earned}/${autoScore.max} auto points` : 'Submit responses to auto-score this section.'}</span>
            <button onClick={() => onSubmitResponses(component)} disabled={submitting || attempt.status !== 'in_progress' || timedOut} className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-black text-white hover:bg-indigo-700 disabled:opacity-40">{submitting ? <Loader2 className="me-1 inline h-4 w-4 animate-spin" /> : null}Submit responses</button>
          </div>
        </div>
      )}

      {writingIsDigital(component) && test && (
        <div className="space-y-3">
          {test.questions.map((question, index) => (
            <div key={question.id} className="rounded-xl border border-slate-200 p-3">
              <div className="text-sm font-bold text-slate-800">{index + 1}. {question.prompt}</div>
              <textarea value={answers[question.questionKey] || ''} onChange={(event) => onPatchAnswer(question.questionKey, event.target.value)} rows={6} className="mt-3 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" placeholder="Write the response here…" />
            </div>
          ))}
          <div className="flex justify-end">
            <button onClick={() => onSubmitResponses(component)} disabled={submitting || attempt.status !== 'in_progress' || timedOut} className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-black text-white hover:bg-indigo-700 disabled:opacity-40">{submitting ? <Loader2 className="me-1 inline h-4 w-4 animate-spin" /> : null}Save writing response</button>
          </div>
        </div>
      )}

      {component.type === 'speaking' && <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">Speaking is assessed as a structured face-to-face speaking evaluation. Recording is not required; record the official rubric result below.</div>}

      {showManualSave && (
        <div className="mt-4 space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
          {test?.rubric?.criteria?.length ? (
            test.rubric.criteria.map((criterion) => (
              <div key={criterion.key} className="flex items-center gap-3">
                <div className="w-48 shrink-0 text-xs font-bold text-slate-600">{criterion.label} <span className="text-slate-400">0–{criterion.maxScore}</span></div>
                <input type="number" min={0} max={criterion.maxScore} value={draft.criteriaScores?.[criterion.key] ?? ''} onChange={(event) => onPatchDraft({ criteriaScores: { ...(draft.criteriaScores || {}), [criterion.key]: Number(event.target.value) } })} className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-mono" />
              </div>
            ))
          ) : (
            <div>
              <label className="mb-1 block text-[11px] font-black uppercase tracking-wide text-slate-500">Score</label>
              <input type="number" min={0} max={component.maxScore} value={draft.score ?? ''} onChange={(event) => onPatchDraft({ score: event.target.value })} className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-mono" placeholder={`0–${component.maxScore}`} />
            </div>
          )}
          <div>
            <label className="mb-1 block text-[11px] font-black uppercase tracking-wide text-slate-500">Evaluator feedback</label>
            <textarea value={draft.resultText || ''} onChange={(event) => onPatchDraft({ resultText: event.target.value })} rows={4} className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" placeholder="Record the official scoring notes…" />
          </div>
          <div className="flex justify-end">
            <button onClick={() => onSave(component)} disabled={saving || attempt.status !== 'in_progress' || timedOut} className="rounded-xl bg-slate-800 px-5 py-2.5 text-xs font-black text-white hover:bg-slate-900 disabled:opacity-40">{saving ? <Loader2 className="me-1 inline h-4 w-4 animate-spin" /> : <Save className="me-1 inline h-4 w-4" />}Save section</button>
          </div>
        </div>
      )}
    </div>
  );
}

