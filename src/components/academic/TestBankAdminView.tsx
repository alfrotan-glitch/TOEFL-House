import React, { useEffect, useState } from 'react';
import { Plus, FileText, Trash2, X, Save, Eye, Archive, CheckCircle2, Upload, Loader2, Mic, BookOpen, PenLine, MessageSquareText } from 'lucide-react';
import { api } from '../../api/client';
import { useInvalidate } from '../../state/serverStateFreshness';

interface Question { id?: string; key: string; qtype: string; prompt: string; options: Array<{ key: string; text: string }> | null; answerKey: string; points: number; orderIndex?: number; difficulty?: string | null; sectionKey?: string | null; }
interface Section { id?: string; key: string; kind: string; title?: string | null; audioUrl?: string | null; transcript?: string | null; body?: string | null; durationSeconds?: number | null; }
interface Test { id: string; title: string; testType: string; instructions?: string | null; audioUrl?: string | null; transcript?: string | null; passage?: string | null; status: string; difficulty?: string | null; durationSeconds?: number | null; version?: number; rubricId?: string | null; wordTarget?: number | null; sections: Section[]; questions: Question[]; }
interface Rubric { id: string; title: string; kind: string; version: number; criteria: Array<{ key: string; label: string; weight: number; maxScore: number }>; }
interface Media { id: string; filename: string; mime: string; sizeBytes: number; sha256: string; url: string; }

const inputCls = 'w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm bg-white';
const labelCls = 'block text-[11px] font-black text-slate-500 uppercase tracking-wide mb-1.5';
const btn = 'px-4 py-2 rounded-xl text-xs font-black flex items-center gap-1.5 disabled:opacity-50';

function emptyQuestion(): Question { return { key: '', qtype: 'mcq', prompt: '', options: [{ key: 'A', text: '' }, { key: 'B', text: '' }], answerKey: 'A', points: 1 }; }
function emptySection(): Section { return { key: '', kind: 'audio_track', title: '', audioUrl: null, transcript: null, body: null, durationSeconds: null }; }

export default function TestBankAdminView({ triggerToast }: { triggerToast: (m: string, t: 'success' | 'error' | 'info') => void }) {
  const invalidate = useInvalidate();
  const [tests, setTests] = useState<Test[]>([]);
  const [rubrics, setRubrics] = useState<Rubric[]>([]);
  const [media, setMedia] = useState<Media[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Test | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [preview, setPreview] = useState<Test | null>(null);
  const [rubricForm, setRubricForm] = useState<{ title: string; kind: string; criteria: Rubric['criteria'] }>({ title: '', kind: 'writing', criteria: [{ key: 'content', label: 'Content', weight: 50, maxScore: 10 }, { key: 'language', label: 'Language', weight: 50, maxScore: 10 }] });
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const [t, r, m] = await Promise.all([
      api.get<Test[]>('/placement/test-bank'),
      api.get<Rubric[]>('/placement/rubrics'),
      api.get<Media[]>('/placement/media'),
    ]);
    setTests(t || []);
    setRubrics(r || []);
    setMedia(m || []);
  };

  useEffect(() => { void (async () => { try { await load(); } catch { /* auth-gated */ } finally { setLoading(false); } })(); }, []);

  const saveTest = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      const payload: any = {
        title: editing.title, testType: editing.testType, instructions: editing.instructions || null,
        audioUrl: editing.audioUrl || null, transcript: editing.transcript || null, passage: editing.passage || null,
        version: editing.version,
        difficulty: editing.difficulty || null, durationSeconds: editing.durationSeconds ?? null,
        rubricId: editing.rubricId || null, wordTarget: editing.wordTarget ?? null,
        sections: editing.sections.filter((s) => s.key).map((s) => ({ key: s.key, kind: s.kind, title: s.title || null, audioUrl: s.audioUrl || null, transcript: s.transcript || null, body: s.body || null, durationSeconds: s.durationSeconds ?? null })),
        questions: editing.questions.filter((q) => q.key).map((q) => ({ key: q.key, qtype: q.qtype, prompt: q.prompt, options: q.qtype === 'mcq' ? q.options : null, answerKey: q.answerKey, points: Number(q.points), difficulty: q.difficulty || null, sectionKey: q.sectionKey || null })),
      };
      if (isNew) await api.post<Test>('/placement/test-bank', payload);
      else await api.put<Test>(`/placement/test-bank/${editing.id}`, payload);
      invalidate('placement');
      triggerToast(isNew ? 'Test created.' : 'Test updated (new content version).', 'success');
      setEditing(null); setIsNew(false);
      await load();
    } catch (e: any) { triggerToast(e?.message || 'Could not save the test.', 'error'); }
    finally { setSaving(false); }
  };

  const setStatus = async (t: Test, status: 'active' | 'archived') => {
    try {
      await api.post(`/placement/test-bank/${t.id}/${status === 'active' ? 'activate' : 'archive'}`, { version: t.version });
      invalidate('placement');
      triggerToast(status === 'active' ? 'Test activated.' : 'Test archived (history preserved).', 'success');
      await load();
    } catch (e: any) { triggerToast(e?.message || 'Action failed.', 'error'); }
  };

  const uploadFile = async (file: File) => {
    setUploading(true);
    try {
      const res = await fetch(`/api/placement/media/upload`, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: await file.arrayBuffer(),
        credentials: 'include',
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `Upload failed (HTTP ${res.status})`); }
      triggerToast('Audio uploaded.', 'success');
      await load();
    } catch (e: any) { triggerToast(e?.message || 'Upload failed.', 'error'); }
    finally { setUploading(false); }
  };

  const saveRubric = async () => {
    if (!rubricForm.title) { triggerToast('Rubric title is required.', 'error'); return; }
    try {
      await api.post('/placement/rubrics', { title: rubricForm.title, kind: rubricForm.kind, criteria: rubricForm.criteria });
      invalidate('placement');
      triggerToast('Rubric created.', 'success');
      setRubricForm({ title: '', kind: 'writing', criteria: [{ key: 'content', label: 'Content', weight: 50, maxScore: 10 }, { key: 'language', label: 'Language', weight: 50, maxScore: 10 }] });
      await load();
    } catch (e: any) { triggerToast(e?.message || 'Could not create rubric.', 'error'); }
  };

  if (loading) return <div className="p-10 text-center text-sm text-slate-400 flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Loading placement test bank…</div>;

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div><h2 className="text-lg font-black text-slate-800">Placement Test Bank</h2><p className="text-xs text-slate-500">Reusable content: listening tracks, reading passages, writing prompts, speaking blocks, rubrics, audio.</p></div>
        <button onClick={() => { setEditing({ id: '', title: '', testType: 'listening', status: 'draft', sections: [], questions: [emptyQuestion()] }); setIsNew(true); }} className={`${btn} bg-indigo-600 hover:bg-indigo-700 text-white`}><Plus className="w-3.5 h-3.5" /> New test</button>
      </div>

      {editing && (
        <TestEditor test={editing} isNew={isNew} rubrics={rubrics} media={media} setTest={setEditing} onCancel={() => { setEditing(null); setIsNew(false); }} onSave={saveTest} saving={saving} triggerToast={triggerToast} />
      )}

      {/* Tests */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {tests.map((t) => (
          <div key={t.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-9 h-9 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0">{t.testType === 'listening' ? <Mic className="w-4 h-4" /> : t.testType === 'reading' ? <BookOpen className="w-4 h-4" /> : t.testType === 'writing' ? <PenLine className="w-4 h-4" /> : <MessageSquareText className="w-4 h-4" />}</span>
                <div className="min-w-0"><div className="text-sm font-black text-slate-800 break-words">{t.title}</div><div className="text-[10px] text-slate-400 uppercase tracking-wide">{t.testType} · v{t.version ?? 1} · {t.difficulty || 'no difficulty'}</div></div>
              </div>
              <span className={`text-[9px] font-black px-2 py-0.5 rounded-full uppercase shrink-0 ${t.status === 'active' ? 'bg-emerald-100 text-emerald-700' : t.status === 'archived' ? 'bg-slate-100 text-slate-500' : 'bg-amber-100 text-amber-700'}`}>{t.status}</span>
            </div>
            <div className="mt-3 text-[11px] text-slate-500 space-y-0.5">
              <div>{t.sections?.length || 0} sections · {t.questions?.length || 0} questions · {t.durationSeconds ? `${t.durationSeconds}s` : 'no duration'}{t.rubricId ? ' · rubric' : ''}{t.wordTarget ? ` · ${t.wordTarget} words` : ''}</div>
            </div>
            <div className="mt-4 flex items-center gap-1.5 flex-wrap">
              <button onClick={() => { setEditing(t); setIsNew(false); }} className={`${btn} bg-slate-800 text-white`}><FileText className="w-3 h-3" /> Edit</button>
              <button onClick={() => setPreview(t)} className={`${btn} bg-slate-100 text-slate-600`}><Eye className="w-3 h-3" /> Preview</button>
              {t.status === 'draft' && <button onClick={() => setStatus(t, 'active')} className={`${btn} bg-emerald-600 text-white`}><CheckCircle2 className="w-3 h-3" /> Activate</button>}
              {t.status === 'active' && <button onClick={() => setStatus(t, 'archived')} className={`${btn} bg-amber-100 text-amber-700`}><Archive className="w-3 h-3" /> Archive</button>}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-8 grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Rubrics */}
        <div className="rounded-2xl border border-slate-200 bg-white p-5">
          <h3 className="text-sm font-black text-slate-800 mb-3">Writing / Speaking Rubrics</h3>
          <div className="space-y-2 mb-4">
            {(rubrics || []).map((r) => (
              <div key={r.id} className="rounded-xl border border-slate-100 bg-slate-50 p-3 text-xs"><b className="text-slate-700">{r.title}</b> <span className="text-slate-400">· {r.kind}</span><div className="mt-1 text-[10px] text-slate-500">{r.criteria.map((c) => `${c.label} ${c.weight}%`).join(' · ')}</div></div>
            ))}
            {(!rubrics || rubrics.length === 0) && <p className="text-[11px] text-slate-400">No rubrics yet.</p>}
          </div>
          <div className="rounded-xl border border-indigo-100 bg-indigo-50/40 p-3 space-y-2">
            <div className="flex gap-2"><input value={rubricForm.title} onChange={(e) => setRubricForm({ ...rubricForm, title: e.target.value })} placeholder="Rubric title…" className={inputCls} /><select value={rubricForm.kind} onChange={(e) => setRubricForm({ ...rubricForm, kind: e.target.value })} className={inputCls + ' w-36'}><option value="writing">Writing</option><option value="speaking">Speaking</option><option value="interview">Interview</option></select></div>
            {(rubricForm.criteria || []).map((c, i) => (
              <div key={i} className="flex gap-2 items-center">
                <input value={c.key} onChange={(e) => setRubricForm((f) => ({ ...f, criteria: f.criteria.map((x, xi) => xi === i ? { ...x, key: e.target.value } : x) }))} placeholder="key" className={inputCls + ' w-24'} />
                <input value={c.label} onChange={(e) => setRubricForm((f) => ({ ...f, criteria: f.criteria.map((x, xi) => xi === i ? { ...x, label: e.target.value } : x) }))} placeholder="label" className={inputCls} />
                <input type="number" value={c.weight} onChange={(e) => setRubricForm((f) => ({ ...f, criteria: f.criteria.map((x, xi) => xi === i ? { ...x, weight: Number(e.target.value) } : x) }))} placeholder="%" className={inputCls + ' w-20'} />
                <input type="number" value={c.maxScore} onChange={(e) => setRubricForm((f) => ({ ...f, criteria: f.criteria.map((x, xi) => xi === i ? { ...x, maxScore: Number(e.target.value) } : x) }))} placeholder="max" className={inputCls + ' w-20'} />
                <button onClick={() => setRubricForm((f) => ({ ...f, criteria: f.criteria.filter((_, xi) => xi !== i) }))} className="text-rose-400"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            ))}
            <div className="flex gap-2">
              <button onClick={() => setRubricForm((f) => ({ ...f, criteria: [...f.criteria, { key: '', label: '', weight: 0, maxScore: 10 }] }))} className={`${btn} border border-dashed border-indigo-300 text-indigo-600 text-[10px]`}><Plus className="w-3 h-3" /> Criterion</button>
              <button onClick={saveRubric} className={`${btn} bg-indigo-600 text-white`}><Save className="w-3 h-3" /> Save rubric</button>
            </div>
          </div>
        </div>

        {/* Media */}
        <div className="rounded-2xl border border-slate-200 bg-white p-5">
          <h3 className="text-sm font-black text-slate-800 mb-3">Audio Media Library</h3>
          <label className={`${btn} border border-dashed border-indigo-300 text-indigo-600 bg-indigo-50/40 cursor-pointer w-full justify-center py-4`}>
            {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />} Upload audio (mp3/wav/ogg/m4a — max 25 MB)
            <input type="file" accept="audio/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadFile(f); e.target.value = ''; }} />
          </label>
          <div className="mt-3 space-y-1.5 max-h-64 overflow-y-auto">
            {(media || []).map((m) => (
              <div key={m.id} className="flex items-center gap-2 rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-xs">
                <Mic className="w-3.5 h-3.5 text-slate-400" />
                <span className="font-bold text-slate-600 truncate flex-1">{m.filename}</span>
                <span className="text-[10px] text-slate-400 font-mono">{Math.round(m.sizeBytes / 1024)} KB</span>
                <audio controls src={m.url} className="h-8 w-40" />
              </div>
            ))}
            {(!media || media.length === 0) && <p className="text-[11px] text-slate-400">No media uploaded. Audio URLs can also reference external files.</p>}
          </div>
        </div>
      </div>

      {/* Preview */}
      {preview && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-50" onClick={() => setPreview(null)}>
          <div className="bg-white rounded-3xl shadow-2xl max-w-3xl w-full max-h-[90vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4"><h3 className="font-black text-slate-800">Preview — {preview.title} (v{preview.version ?? 1})</h3><button onClick={() => setPreview(null)} className="p-1.5 rounded-lg hover:bg-slate-100"><X className="w-4 h-4 text-slate-400" /></button></div>
            <div className="space-y-3 text-sm">
              <p className="text-xs text-slate-500">{preview.instructions || 'No instructions'}</p>
              {(preview.sections || []).map((s) => (
                <div key={s.key} className="rounded-xl border border-slate-100 bg-slate-50 p-3">
                  <div className="text-[10px] font-black text-slate-400 uppercase">{s.kind} · {s.key}{s.title ? ` · ${s.title}` : ''}</div>
                  {s.audioUrl && <audio controls src={s.audioUrl} className="mt-2 w-full" />}
                  {s.transcript && <details className="mt-1"><summary className="text-[10px] font-bold text-indigo-600">Transcript</summary><p className="text-xs text-slate-600 whitespace-pre-wrap">{s.transcript}</p></details>}
                  {s.body && <p className="text-xs text-slate-700 whitespace-pre-wrap mt-1">{s.body}</p>}
                </div>
              ))}
              {(preview.questions || []).map((q, i) => (
                <div key={i} className="rounded-xl border border-slate-200 p-3">
                  <div className="flex justify-between"><span className="text-xs font-bold text-slate-700">{i + 1}. {q.prompt}</span><span className="text-[10px] font-mono text-slate-400">{q.points} pts{q.sectionKey ? ` · ${q.sectionKey}` : ''}</span></div>
                  {q.qtype === 'mcq' && (q.options || []).map((o) => <div key={o.key} className={`text-xs mt-1 ${o.key === q.answerKey ? 'text-emerald-600 font-black' : 'text-slate-500'}`}>{o.key}. {o.text}{o.key === q.answerKey ? ' ✓' : ''}</div>)}
                  {q.qtype !== 'mcq' && <div className="text-[10px] text-slate-400 mt-1">Answer key: <b className="text-slate-600">{q.answerKey || '—'}</b> ({q.qtype})</div>}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TestEditor({ test, isNew, rubrics, setTest, onCancel, onSave, saving }: any) {
  const set = (patch: Partial<Test>) => setTest((t: Test) => ({ ...t, ...patch }));
  const setQuestion = (i: number, patch: Partial<Question>) => set({ questions: test.questions.map((q: Question, qi: number) => qi === i ? { ...q, ...patch } : q) });
  const setSection = (i: number, patch: Partial<Section>) => set({ sections: test.sections.map((s: Section, si: number) => si === i ? { ...s, ...patch } : s) });

  return (
    <div className="mb-6 rounded-3xl border-2 border-indigo-200 bg-white p-5 shadow-lg">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-black text-slate-800">{isNew ? 'New test' : `Edit — ${test.title}`}</h3>
        <div className="flex gap-2">
          <button onClick={onCancel} className={`${btn} bg-slate-100 text-slate-600`}><X className="w-3 h-3" /> Cancel</button>
          <button onClick={onSave} disabled={saving} className={`${btn} bg-indigo-600 text-white`}>{saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save test</button>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <div><label className={labelCls}>Title</label><input value={test.title} onChange={(e) => set({ title: e.target.value })} className={inputCls} /></div>
        <div><label className={labelCls}>Type</label><select value={test.testType} onChange={(e) => { const testType = e.target.value; const rubric = (rubrics || []).find((r: any) => r.id === test.rubricId); const rubricId = rubric && (rubric.kind === testType || rubric.kind === 'interview') && (testType === 'writing' || testType === 'speaking') ? test.rubricId : null; set({ testType, rubricId, wordTarget: testType === 'writing' ? test.wordTarget : null }); }} className={inputCls}><option value="listening">Listening</option><option value="reading">Reading</option><option value="writing">Writing</option><option value="speaking">Speaking</option></select></div>
        <div><label className={labelCls}>Difficulty</label><select value={test.difficulty || ''} onChange={(e) => set({ difficulty: e.target.value || null })} className={inputCls}><option value="">—</option><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select></div>
        <div><label className={labelCls}>Duration (seconds)</label><input type="number" value={test.durationSeconds ?? ''} onChange={(e) => set({ durationSeconds: e.target.value === '' ? null : Number(e.target.value) })} className={inputCls} /></div>
      </div>
      <div className="mt-3"><label className={labelCls}>Instructions</label><textarea value={test.instructions || ''} onChange={(e) => set({ instructions: e.target.value })} rows={2} className={inputCls} /></div>
      {(test.testType === 'writing' || test.testType === 'speaking') && (
        <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
          <div><label className={labelCls}>Rubric</label><select value={test.rubricId || ''} onChange={(e) => set({ rubricId: e.target.value || null })} className={inputCls}><option value="">— none —</option>{(rubrics || []).filter((r: any) => test.testType === 'writing' ? (r.kind === 'writing' || r.kind === 'interview') : test.testType === 'speaking' ? (r.kind === 'speaking' || r.kind === 'interview') : false).map((r: any) => <option key={r.id} value={r.id}>{r.title}</option>)}</select></div>
          {test.testType === 'writing' && <div><label className={labelCls}>Word target</label><input type="number" value={test.wordTarget ?? ''} onChange={(e) => set({ wordTarget: e.target.value === '' ? null : Number(e.target.value) })} className={inputCls} /></div>}
        </div>
      )}

      {/* Sections */}
      <div className="mt-5">
        <div className="flex items-center justify-between"><label className={labelCls}>Sections / tracks / passages</label><button onClick={() => set({ sections: [...test.sections, emptySection()] })} className="text-[10px] font-black text-indigo-600"><Plus className="w-3 h-3 inline me-0.5" /> Add section</button></div>
        <div className="space-y-2">
          {(test.sections || []).map((s: Section, i: number) => (
            <div key={i} className="rounded-xl border border-slate-100 bg-slate-50 p-3 grid grid-cols-1 md:grid-cols-6 gap-2">
              <input value={s.key} onChange={(e) => setSection(i, { key: e.target.value })} placeholder="key (s1/p1)" className={inputCls + ' md:col-span-1'} />
              <select value={s.kind} onChange={(e) => setSection(i, { kind: e.target.value })} className={inputCls + ' md:col-span-1'}><option value="audio_track">Audio track</option><option value="passage">Passage</option><option value="prompt_block">Prompt block</option><option value="instructions">Instructions</option></select>
              <input value={s.title || ''} onChange={(e) => setSection(i, { title: e.target.value })} placeholder="Title" className={inputCls + ' md:col-span-1'} />
              <input value={s.audioUrl || ''} onChange={(e) => setSection(i, { audioUrl: e.target.value || null })} placeholder="Audio URL or media id" className={inputCls + ' md:col-span-1'} />
              <input type="number" value={s.durationSeconds ?? ''} onChange={(e) => setSection(i, { durationSeconds: e.target.value === '' ? null : Number(e.target.value) })} placeholder="Sec" className={inputCls + ' md:col-span-1'} />
              <button onClick={() => set({ sections: test.sections.filter((_: Section, si: number) => si !== i) })} className="text-rose-400 md:col-span-1"><Trash2 className="w-4 h-4" /></button>
              <textarea value={s.body || ''} onChange={(e) => setSection(i, { body: e.target.value || null })} placeholder={s.kind === 'passage' ? 'Passage text…' : 'Block content…'} rows={2} className={inputCls + ' md:col-span-3'} />
              <textarea value={s.transcript || ''} onChange={(e) => setSection(i, { transcript: e.target.value || null })} placeholder="Transcript (audio)…" rows={2} className={inputCls + ' md:col-span-3'} />
            </div>
          ))}
        </div>
      </div>

      {/* Questions */}
      <div className="mt-5">
        <div className="flex items-center justify-between"><label className={labelCls}>Questions</label><button onClick={() => set({ questions: [...test.questions, emptyQuestion()] })} className="text-[10px] font-black text-indigo-600"><Plus className="w-3 h-3 inline me-0.5" /> Add question</button></div>
        <div className="space-y-2">
          {(test.questions || []).map((q: Question, i: number) => (
            <div key={i} className="rounded-xl border border-slate-100 bg-slate-50 p-3 space-y-2">
              <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
                <input value={q.key} onChange={(e) => setQuestion(i, { key: e.target.value })} placeholder="key" className={inputCls + ' md:col-span-2'} />
                <select value={q.qtype} onChange={(e) => setQuestion(i, { qtype: e.target.value, options: e.target.value === 'mcq' ? (q.options?.length ? q.options : [{ key: 'A', text: '' }, { key: 'B', text: '' }]) : null })} className={inputCls + ' md:col-span-2'}><option value="mcq">MCQ</option><option value="short_answer">Short answer</option><option value="essay">Essay</option><option value="speaking">Speaking</option></select>
                <input value={q.prompt} onChange={(e) => setQuestion(i, { prompt: e.target.value })} placeholder="Question prompt" className={inputCls + ' md:col-span-4'} />
                <input type="number" value={q.points} onChange={(e) => setQuestion(i, { points: Number(e.target.value) })} placeholder="pts" className={inputCls + ' md:col-span-1'} />
                <input value={q.difficulty || ''} onChange={(e) => setQuestion(i, { difficulty: e.target.value || null })} placeholder="difficulty" className={inputCls + ' md:col-span-1'} />
                <select value={q.sectionKey || ''} onChange={(e) => setQuestion(i, { sectionKey: e.target.value || null })} className={inputCls + ' md:col-span-1'}><option value="">section…</option>{(test.sections || []).map((s: Section) => <option key={s.key} value={s.key}>{s.key}</option>)}</select>
                <button onClick={() => set({ questions: test.questions.filter((_: Question, qi: number) => qi !== i) })} className="text-rose-400 md:col-span-1"><Trash2 className="w-4 h-4" /></button>
              </div>
              {q.qtype === 'mcq' && (
                <div className="grid grid-cols-1 md:grid-cols-6 gap-2">
                  {(q.options || []).map((o, oi) => (
                    <div key={oi} className="flex gap-1 items-center">
                      <span className="text-[10px] font-black text-slate-400">{o.key}.</span>
                      <input value={o.text} onChange={(e) => setQuestion(i, { options: q.options!.map((x, xi) => xi === oi ? { ...x, text: e.target.value } : x) })} placeholder={`Option ${o.key}`} className={inputCls} />
                    </div>
                  ))}
                  <div className="flex items-center gap-2">
                    <select value={q.answerKey} onChange={(e) => setQuestion(i, { answerKey: e.target.value })} className={inputCls + ' w-24'}>{(q.options || []).map((o) => <option key={o.key} value={o.key}>{o.key}</option>)}</select>
                    <button onClick={() => setQuestion(i, { options: [...(q.options || []), { key: String.fromCharCode(65 + (q.options?.length || 0)), text: '' }] })} className="text-[10px] font-black text-indigo-600">+opt</button>
                  </div>
                </div>
              )}
              {q.qtype !== 'mcq' && <div className="grid grid-cols-1 md:grid-cols-3 gap-2"><input value={q.answerKey} onChange={(e) => setQuestion(i, { answerKey: e.target.value })} placeholder="Answer key (auto-graded types)" className={inputCls} /></div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
