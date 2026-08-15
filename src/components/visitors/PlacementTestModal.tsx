import React, { useEffect, useMemo, useState } from 'react';
import {
  Award, CheckCircle2, Clock3, FileText, Loader2, MessageSquareText, Save, Sparkles, X, BookOpen, ShieldCheck, Pause, Play, SkipForward, Timer, AlertTriangle
} from 'lucide-react';
import { api } from '../../api/client';
import type { Visitor } from '../../types';

type ComponentType = 'skill_scores' | 'written_test' | 'interview' | 'level_assessment' | 'custom_score' | 'content_test';
interface ComponentConfig { key:string; type:ComponentType; label:string; required:boolean; weight:number; maxScore:number; durationMinutes?:number|null; timeLimitSeconds?:number|null; minScore?:number|null; scoringMethod?:string; enabled?:boolean; instructions?:string|null; skills?:string[]; testId?:string; }
interface TestQuestion { id:string; questionKey:string; qtype:string; prompt:string; options:Array<{key:string; text:string}>|null; points:number; sectionKey?:string|null; }
interface TestSection { key:string; title?:string|null; kind:string; audioUrl?:string|null; transcript?:string|null; body?:string|null; durationSeconds?:number|null; }
interface ContentTest { id:string; title:string; testType:string; instructions?:string|null; audioUrl?:string|null; transcript?:string|null; passage?:string|null; difficulty?:string|null; durationSeconds?:number|null; version?:number; sections?:TestSection[]; questions:TestQuestion[]; }
interface PlacementProfile { configured:boolean; enabled:boolean; required:boolean; requirementMode?:string; firstLevelExempt?:boolean; expiresMinutes?:number|null; policyVersion?:number; method:string; programName:string; versionLabel?:string; instructions?:string|null; components:ComponentConfig[]; levels:Array<{id:string;name:string;code?:string|null}>; allowRetake:boolean; passScore:number; contentTests?:ContentTest[]; }
interface AttemptResult { component_key:string; component_type:string; label:string; status:string; score:number|null; max_score:number; weight:number; selected_level_id?:string|null; notes?:string|null; result_text?:string|null; payload_json?:string|null; started_at?:string|null; deadline_at?:string|null; elapsed_seconds?:number|null; timeout_flag?:number|null; raw_score?:number|null; percentage?:number|null; score_version?:number|null; }
interface Attempt { id:string; attempt_number:number; status:string; percentage?:number|null; recommendation_text?:string|null; expires_at?:string|null; results:AttemptResult[]; }
interface Requirement { mode:string; reason?:string; firstLevelExemptApplied?:boolean; }

interface Props { visitor: Visitor; onClose:()=>void; onCompleted:()=>Promise<void>; triggerToast:(message:string,type:'success'|'error'|'info')=>void; }

const skillLabels: Record<string,string> = { grammar:'Grammar', vocabulary:'Vocabulary', reading:'Reading', listening:'Listening', writing:'Writing', speaking:'Speaking' };
const componentIcon: Record<string, React.ReactNode> = {
  skill_scores:<Sparkles className="w-4 h-4"/>, written_test:<FileText className="w-4 h-4"/>, interview:<MessageSquareText className="w-4 h-4"/>, level_assessment:<BookOpen className="w-4 h-4"/>, custom_score:<Award className="w-4 h-4"/>, content_test:<FileText className="w-4 h-4"/>
};

function fmtRemaining(sec: number|null|undefined): string {
  if (sec == null) return '—';
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}` : `${m}:${String(r).padStart(2,'0')}`;
}

export default function PlacementTestModal({ visitor, onClose, onCompleted, triggerToast }: Props) {
  const [profile,setProfile]=useState<PlacementProfile|null>(null);
  const [requirement,setRequirement]=useState<Requirement|null>(null);
  const [attempt,setAttempt]=useState<Attempt|null>(null);
  const [loading,setLoading]=useState(true);
  const [starting,setStarting]=useState(false);
  const [skipping,setSkipping]=useState(false);
  const [canStart,setCanStart]=useState(false);
  const [savingKey,setSavingKey]=useState<string|null>(null);
  const [completing,setCompleting]=useState(false);
  const [pausing,setPausing]=useState(false);
  const [activeKey,setActiveKey]=useState<string>('');
  const [drafts,setDrafts]=useState<Record<string,any>>({});
  const [contentAnswers,setContentAnswers]=useState<Record<string,Record<string,string>>>({});
  const [contentFeedback,setContentFeedback]=useState<Record<string,Record<string,string>>>({});
  const [contentAutoScore,setContentAutoScore]=useState<Record<string,{earned:number;max:number;complete:boolean;answered:number}>>({});
  const [submittingContent,setSubmittingContent]=useState<string|null>(null);
  const [nowTick,setNowTick]=useState<number>(() => Date.now());

  // Server-synced clock tick for countdowns (the server deadline is the truth).
  useEffect(()=>{ const t=setInterval(()=>setNowTick(Date.now()),1000); return ()=>clearInterval(t); },[]);

  const loadWorkspace = async () => {
    const data = await api.get<any>(`/placement/visitors/${visitor.id}/placement`);
    setProfile(data.profile);
    setRequirement(data.requirement);
    const current = data.current as Attempt|null;
    setCanStart(!current && data.requirement?.mode !== 'not_required');
    setAttempt(current);
    if (current?.results?.length) {
      const next:Record<string,any>={};
      for(const r of current.results){
        const payload=r.payload_json?JSON.parse(r.payload_json):{};
        next[r.component_key]={...payload,score:r.score ?? '',notes:r.notes ?? '',resultText:r.result_text ?? '',selectedLevelId:r.selected_level_id ?? ''};
      }
      setDrafts(next);
      setActiveKey(current.results.find(r=>r.status!=='completed'&&r.status!=='waived'&&r.status!=='timed_out')?.component_key || current.results[0]?.component_key || '');
    } else if(data.profile?.components?.[0]) setActiveKey(data.profile.components[0].key);
  };

  useEffect(()=>{ let cancelled=false; (async()=>{
    setLoading(true);
    try { await loadWorkspace(); }
    catch(err:any){
      const status = err?.status || err?.response?.status;
      const message = err?.message || err?.response?.data?.error || 'Unable to load placement workspace.';
      triggerToast(status ? `${message} (HTTP ${status})` : message,'error');
    } finally { if(!cancelled) setLoading(false); }
  })(); return ()=>{ cancelled=true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visitor.id]);

  const contentTestFor=(component:ComponentConfig)=>profile?.contentTests?.find(t=>t.id===component.testId)||null;
  const remainingFor=(componentKey:string): number|null => {
    const r = attempt?.results?.find(x=>x.component_key===componentKey);
    if (!r?.deadline_at) return null;
    const deadlineMs = new Date(r.deadline_at.replace(' ','T')+'Z').getTime();
    return Math.max(0, Math.round((deadlineMs - nowTick)/1000));
  };
  const timedOutFor=(componentKey:string): boolean => {
    const r = attempt?.results?.find(x=>x.component_key===componentKey);
    if (!r) return false;
    if (r.timeout_flag === 1 || r.status === 'timed_out') return true;
    return !!(r.deadline_at && r.status !== 'completed' && r.status !== 'waived' && remainingFor(componentKey) === 0);
  };

  const startComponentTimer = async (component:ComponentConfig) => {
    if (!attempt) return;
    try {
      const res = await api.put<any>(`/placement/visitors/${visitor.id}/placement/attempts/${attempt.id}/tests/${component.key}/start`, {});
      triggerToast(`${component.label} timer started (${res.timeLimitSeconds}s).`,'info');
      await loadWorkspace();
    } catch(err:any){ triggerToast(err?.message || 'Could not start the timer.','error'); }
  };

  const patchDraft=(key:string,patch:any)=>setDrafts(prev=>({...prev,[key]:{...(prev[key]||{}),...patch}}));
  const patchAnswer=(compKey:string,qKey:string,val:string)=>setContentAnswers(prev=>({...prev,[compKey]:{...(prev[compKey]||{}),[qKey]:val}}));

  const submitContent=async(component:ComponentConfig)=>{
    const test=contentTestFor(component);
    if(!test||!attempt) return;
    const answers=Object.entries(contentAnswers[component.key]||{}).map(([questionKey,response])=>({questionKey,response}));
    setSubmittingContent(component.key);
    try{
      const res=await api.put<any>(`/placement/visitors/${visitor.id}/placement/attempts/${attempt.id}/tests/${component.key}/responses`,{answers});
      setContentAutoScore(prev=>({...prev,[component.key]:{earned:res.autoScore,max:res.maxScore,complete:res.complete,answered:res.answered}}));
      setContentFeedback(prev=>({...prev,[component.key]:res.feedback||{}}));
      await loadWorkspace();
      triggerToast(res.complete?`${component.label} auto-scored ${res.autoScore}/${res.maxScore}.`:`${component.label}: ${res.answered}/${res.total} answered. Auto points: ${res.autoScore}.`,'success');
    }catch(err:any){triggerToast(err?.message||'Could not submit responses.','error');}
    finally{setSubmittingContent(null);}
  };

  const startAttempt = async () => {
    setStarting(true);
    try {
      await api.post<any>(`/placement/visitors/${visitor.id}/placement/attempts`, {});
      triggerToast('Placement attempt started.','success');
      await loadWorkspace();
    } catch(err:any){ triggerToast(err?.message || 'Could not start the assessment.','error'); }
    finally{ setStarting(false); }
  };

  const skipOptional = async () => {
    setSkipping(true);
    try {
      await api.post<any>(`/placement/visitors/${visitor.id}/placement/attempts`, { skip: true, reason: 'Candidate opted to skip optional placement.' });
      triggerToast('Placement skipped (exemption recorded).','success');
      await onCompleted();
    } catch(err:any){ triggerToast(err?.message || 'Could not record the skip.','error'); }
    finally{ setSkipping(false); }
  };

  const saveComponent = async (component:ComponentConfig) => {
    const draft=drafts[component.key]||{};
    setSavingKey(component.key);
    try{
      const payload:any={status:'completed',notes:draft.notes||null,resultText:draft.resultText||null,selectedLevelId:draft.selectedLevelId||null};
      if(component.type==='skill_scores') payload.skills=draft.skills||{};
      else if(component.type==='content_test'){
        await submitContent(component);
        if(draft.score==null||draft.score===''){triggerToast('Enter a score for the manual section.','error');return;}
        payload.score=Number(draft.score);
      }
      else payload.score=Number(draft.score);
      const results=await api.put<AttemptResult[]>(`/placement/visitors/${visitor.id}/placement/attempts/${attempt!.id}/components/${component.key}`,payload);
      await loadWorkspace();
      triggerToast(`${component.label} saved.`,'success');
      void results;
    }catch(err:any){triggerToast(err?.message||'Could not save the section.','error');}
    finally{setSavingKey(null);}
  };

  const completeAttempt = async () => {
    if(!attempt) return;
    setCompleting(true);
    try{
      const result=await api.post<any>(`/placement/visitors/${visitor.id}/placement/attempts/${attempt.id}/complete`,{notes:null});
      triggerToast(`Placement completed: ${result.attempt?.percentage ?? 0}% — ${result.attempt?.recommendation_text ?? 'Decision recorded'}`,'success');
      await onCompleted();
    }catch(err:any){triggerToast(err?.message||'Could not complete the assessment.','error');}
    finally{setCompleting(false);}
  };

  const pauseAttempt = async () => {
    if(!attempt) return;
    setPausing(true);
    try{
      await api.post<any>(`/placement/visitors/${visitor.id}/placement/attempts/${attempt.id}/pause`, { reason: 'Paused by operator' });
      triggerToast('Attempt paused.','info');
      await loadWorkspace();
    }catch(err:any){triggerToast(err?.message||'Could not pause.','error');}
    finally{setPausing(false);}
  };

  const resumeAttempt = async () => {
    if(!attempt) return;
    setPausing(true);
    try{
      await api.post<any>(`/placement/visitors/${visitor.id}/placement/attempts/${attempt.id}/resume`, {});
      triggerToast('Attempt resumed — deadlines extended.','info');
      await loadWorkspace();
    }catch(err:any){triggerToast(err?.message||'Could not resume.','error');}
    finally{setPausing(false);}
  };

  const doneCount = useMemo(()=> (attempt?.results||[]).filter(r=>r.status==='completed'||r.status==='waived').length, [attempt]);
  const totalCount = useMemo(()=> (attempt?.results||[]).length, [attempt]);

  if(loading) return <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-50"><div className="bg-white rounded-2xl p-8 shadow-2xl flex items-center gap-3 text-slate-600 font-bold"><Loader2 className="w-5 h-5 animate-spin"/>Loading placement workspace…</div></div>;

  if(requirement?.mode==='not_required'){
    return (
      <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
        <div className="bg-white rounded-2xl p-8 shadow-2xl max-w-md w-full" onClick={e=>e.stopPropagation()}>
          <div className="flex items-start justify-between"><div className="flex items-center gap-3"><span className="w-10 h-10 rounded-2xl bg-emerald-100 text-emerald-600 flex items-center justify-center"><ShieldCheck className="w-5 h-5"/></span><div><h3 className="font-black text-slate-800">Placement not required</h3><p className="text-xs text-slate-500">This program/level does not require a placement assessment.</p></div></div><button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400"><X className="w-4 h-4"/></button></div>
          <div className="mt-4 rounded-xl bg-slate-50 border border-slate-100 p-3 text-xs text-slate-600">Reason: {requirement.reason || 'no_policy'}{requirement.firstLevelExemptApplied ? ' (first-level exemption)' : ''}</div>
          <button onClick={onClose} className="mt-5 w-full py-3 rounded-xl bg-slate-800 text-white text-sm font-black">Close</button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-5xl max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <span className="w-10 h-10 rounded-2xl bg-indigo-100 text-indigo-600 flex items-center justify-center"><FileText className="w-5 h-5"/></span>
            <div>
              <h3 className="font-black text-slate-800">Placement Assessment — {visitor.fullName}</h3>
              <p className="text-[11px] text-slate-500">{profile?.programName}{profile?.versionLabel?` · ${profile.versionLabel}`:''} · {requirement?.mode === 'optional' ? 'Optional' : requirement?.mode === 'not_required' ? 'Not required' : 'Required'}{profile?.policyVersion ? ` · Policy v${profile.policyVersion}` : ''}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {attempt && attempt.status === 'in_progress' && <button onClick={pauseAttempt} disabled={pausing} className="px-3 py-2 rounded-xl border border-slate-200 text-slate-600 text-xs font-bold hover:bg-slate-50 flex items-center gap-1.5"><Pause className="w-3.5 h-3.5"/>{pausing?<Loader2 className="w-3.5 h-3.5 animate-spin"/>:'Pause'}</button>}
            {attempt && attempt.status === 'paused' && <button onClick={resumeAttempt} disabled={pausing} className="px-3 py-2 rounded-xl bg-emerald-600 text-white text-xs font-black hover:bg-emerald-700 flex items-center gap-1.5"><Play className="w-3.5 h-3.5"/>{pausing?<Loader2 className="w-3.5 h-3.5 animate-spin"/>:'Resume'}</button>}
            <button onClick={onClose} className="p-2 rounded-xl hover:bg-slate-100 text-slate-400"><X className="w-4 h-4"/></button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {!attempt && requirement?.mode === 'optional' && (
            <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 flex items-center justify-between gap-3">
              <div className="text-xs text-amber-800"><b>Placement is optional</b> for this program. Start the assessment or record an authorized exemption (skip).</div>
              <div className="flex gap-2 shrink-0">
                <button onClick={skipOptional} disabled={skipping} className="px-4 py-2 rounded-xl border border-amber-300 text-amber-700 text-xs font-black hover:bg-amber-100 flex items-center gap-1.5"><SkipForward className="w-3.5 h-3.5"/>{skipping?<Loader2 className="w-3.5 h-3.5 animate-spin"/>:'Skip (exempt)'}</button>
              </div>
            </div>
          )}

          {/* Component list with timers + progress */}
          {attempt && (
            <div className="mb-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {(attempt.results||[]).map(r=>{
                const c = profile?.components?.find(x=>x.key===r.component_key);
                const remaining = remainingFor(r.component_key);
                const timedOut = timedOutFor(r.component_key);
                const auto = contentAutoScore[r.component_key];
                const isActive = r.status==='pending'||r.status==='in_progress';
                return (
                  <button key={r.component_key} onClick={()=>setActiveKey(r.component_key)} className={`text-left rounded-xl border p-3 transition ${activeKey===r.component_key?'border-indigo-400 bg-indigo-50/50 shadow-sm':'border-slate-200 bg-white hover:border-slate-300'}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-[11px] font-black text-slate-700">{componentIcon[r.component_type]}<span className="truncate">{r.label}</span></span>
                      <span className={`text-[9px] font-black px-2 py-0.5 rounded-full uppercase ${r.status==='completed'?'bg-emerald-100 text-emerald-700':r.status==='waived'?'bg-slate-100 text-slate-500':r.status==='timed_out'||timedOut?'bg-rose-100 text-rose-700':isActive?'bg-indigo-100 text-indigo-700':'bg-slate-100 text-slate-400'}`}>{r.status==='timed_out'||timedOut?'timed out':r.status}</span>
                    </div>
                    <div className="mt-2 flex items-center gap-2 text-[10px] text-slate-500">
                      {r.deadline_at ? <span className={`flex items-center gap-1 font-mono font-bold ${timedOut?'text-rose-600':remaining!=null&&remaining<120?'text-amber-600':'text-slate-600'}`}><Timer className="w-3 h-3"/>{fmtRemaining(remaining)}</span> : <span className="flex items-center gap-1"><Clock3 className="w-3 h-3"/>no timer</span>}
                      {auto && <span className="text-slate-400">{auto.answered}/{auto.max? (auto.max/ (auto.earned?1:1)):0}</span>}
                      {c && <span className="ml-auto font-bold">{r.score ?? '–'}/{c.maxScore}</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {attempt && (
            <div className="mb-5 flex items-center gap-3">
              <div className="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden"><div className="h-full bg-indigo-500 transition-all" style={{width:`${totalCount? Math.round(doneCount/totalCount*100):0}%`}}/></div>
              <span className="text-[11px] font-black text-slate-500">{doneCount}/{totalCount} sections completed</span>
              <button onClick={completeAttempt} disabled={completing || doneCount<totalCount || attempt.status!=='in_progress'} className="px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-black disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2">{completing?<Loader2 className="w-4 h-4 animate-spin"/>:<CheckCircle2 className="w-4 h-4"/>} Complete & decide</button>
            </div>
          )}

          {/* No attempt yet → start */}
          {!attempt && (
            <div className="text-center py-10">
              <p className="text-sm text-slate-500 mb-4">{profile?.instructions || 'This candidate is ready for placement. Start the assessment when ready.'}</p>
              {requirement?.mode === 'optional' && <p className="text-[11px] text-slate-400 mb-4">Placement is <b>optional</b> — you can also record an exemption instead.</p>}
              <button onClick={startAttempt} disabled={starting || !canStart} className="px-8 py-3.5 rounded-2xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-black disabled:opacity-50 flex items-center gap-2 mx-auto">{starting?<Loader2 className="w-4 h-4 animate-spin"/>:<FileText className="w-4 h-4"/>} Start placement assessment</button>
            </div>
          )}

          {/* Active component editor */}
          {attempt && profile?.components?.length ? (
            <ActiveEditor
              profile={profile} attempt={attempt} activeKey={activeKey} drafts={drafts}
              contentAnswers={contentAnswers} contentFeedback={contentFeedback} contentAutoScore={contentAutoScore}
              submittingContent={submittingContent} timedOutFor={timedOutFor} remainingFor={remainingFor}
              onStartTimer={startComponentTimer} onPatchDraft={patchDraft} onPatchAnswer={patchAnswer}
              onSubmitContent={submitContent} onSave={saveComponent} savingKey={savingKey}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ActiveEditor(props:any){
  const { profile, attempt, activeKey, drafts, contentAnswers, contentFeedback, contentAutoScore, submittingContent, timedOutFor, remainingFor, onStartTimer, onPatchDraft, onPatchAnswer, onSubmitContent, onSave, savingKey } = props;
  const component = profile.components.find((c:any)=>c.key===activeKey) as any;
  if(!component) return null;
  const d = drafts[component.key]||{};
  const test = profile.contentTests?.find((t:any)=>t.id===component.testId) || null;
  const result = attempt.results?.find((r:any)=>r.component_key===component.key) || {};
  const timedOut = timedOutFor(component.key);
  const remaining = remainingFor(component.key);
  const auto = contentAutoScore[component.key];
  const answeredCount = test ? Object.keys(contentAnswers[component.key]||{}).length : 0;
  const hasManual = test?.questions?.some((q:any)=>q.qtype==='essay'||q.qtype==='speaking');

  const sectionFor = (q:any) => test?.sections?.find((s: {key:string})=>s.key===q.sectionKey);

  const renderEditor = () => {
    if(component.type==='skill_scores'){
      const skills: string[] = component.skills?.length?component.skills:['grammar','vocabulary','reading','listening','writing','speaking'];
      return <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">{skills.map(s=>(
        <div key={s} className="rounded-xl border border-slate-200 p-3"><label className="block text-[11px] font-black text-slate-500 uppercase tracking-wide mb-2">{skillLabels[s]||s}</label><input type="number" min={0} max={25} value={d.skills?.[s]??''} onChange={e=>onPatchDraft(component.key,{skills:{...(d.skills||{}),[s]:Number(e.target.value)}})} className="w-full rounded-xl border border-slate-200 px-3 py-3 font-mono font-bold text-center"/></div>
      ))}</div>;
    }
    if(component.type==='level_assessment') return <div className="space-y-4"><div><label className="block text-[11px] font-black text-slate-500 uppercase tracking-wide mb-2">Recommended level</label><select value={d.selectedLevelId||''} onChange={e=>onPatchDraft(component.key,{selectedLevelId:e.target.value})} className="w-full rounded-xl border border-slate-200 px-3 py-3 text-sm font-semibold"><option value="">Select level…</option>{(profile.levels||[]).map((l:any)=><option key={l.id} value={l.id}>{l.code ? `${l.code} — `:''}{l.name}</option>)}</select></div><div><label className="block text-[11px] font-black text-slate-500 uppercase tracking-wide mb-2">Assessment score (optional)</label><input type="number" min={0} max={component.maxScore} value={d.score??''} onChange={e=>onPatchDraft(component.key,{score:e.target.value})} className="w-full rounded-xl border border-slate-200 px-3 py-3 font-mono font-bold"/></div></div>;
    if(component.type==='content_test'){
      if(!test) return <p className="text-sm text-slate-400">Test content is unavailable in this profile view. (Content is attached at attempt start.)</p>;
      return <div className="space-y-5">
        <div className="rounded-2xl border border-indigo-100 bg-indigo-50/40 p-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div><div className="text-[11px] font-black text-indigo-700 uppercase tracking-wide">{test.testType} · {test.title}{test.version ? ` · v${test.version}` : ''}</div>
            <div className="text-[10px] text-slate-500 mt-0.5">{test.instructions||component.instructions||'Answer each question. MCQ and short answers are auto-scored.'}</div></div>
            <div className="flex items-center gap-2">
              {!result.started_at && <button type="button" onClick={()=>onStartTimer(component)} className="px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-[10px] font-black flex items-center gap-1.5"><Timer className="w-3.5 h-3.5"/> Start timer</button>}
              {result.started_at && <span className={`text-xs font-black px-3 py-1.5 rounded-xl font-mono ${timedOut?'bg-rose-100 text-rose-700':remaining!=null&&remaining<120?'bg-amber-100 text-amber-700':'bg-slate-100 text-slate-600'}`}>{timedOut?'TIMED OUT':fmtRemaining(remaining)}</span>}
              {auto && <span className={`text-xs font-black px-3 py-1.5 rounded-xl ${auto.complete?'bg-emerald-100 text-emerald-700':'bg-amber-100 text-amber-700'}`}>Auto: {auto.earned}/{auto.max}</span>}
            </div>
          </div>
          {(test.sections||[]).map((s: {key:string;title?:string|null;kind:string;audioUrl?:string|null;transcript?:string|null;body?:string|null})=>(
            <div key={s.key} className="mt-3 rounded-xl bg-white border border-slate-100 p-3">
              {s.title && <div className="text-[10px] font-black text-slate-500 uppercase tracking-wide mb-1">{s.title}</div>}
              {s.kind==='audio_track' && s.audioUrl && <audio controls src={s.audioUrl} className="w-full" />}
              {s.transcript && <details className="mt-1.5"><summary className="text-[10px] font-bold text-indigo-600 cursor-pointer">Show transcript</summary><p className="text-xs text-slate-600 mt-1 whitespace-pre-wrap">{s.transcript}</p></details>}
              {s.body && <p className="text-xs text-slate-700 whitespace-pre-wrap mt-1">{s.body}</p>}
            </div>
          ))}
          {!test.sections?.length && test.audioUrl && <audio controls src={test.audioUrl} className="mt-3 w-full" />}
          {!test.sections?.length && test.transcript && <details className="mt-2"><summary className="text-[10px] font-bold text-indigo-600 cursor-pointer">Show transcript</summary><p className="text-xs text-slate-600 mt-1 whitespace-pre-wrap">{test.transcript}</p></details>}
          {!test.sections?.length && test.passage && <div className="mt-3 rounded-xl bg-white border border-slate-100 p-3 text-xs text-slate-700 whitespace-pre-wrap max-h-48 overflow-y-auto">{test.passage}</div>}
        </div>
        <div className="flex items-center justify-between text-[11px] text-slate-500"><span>{answeredCount}/{test.questions.length} answered</span><span className="font-mono">{result.raw_score ?? 0}/{test.questions.reduce((a:number,q:any)=>a+Number(q.points||0),0)} auto pts</span></div>
        <div className="space-y-3">
          {test.questions.map((q:any)=>{
            const ans=contentAnswers[component.key]?.[q.questionKey]||'';
            const fb=contentFeedback[component.key]?.[q.questionKey];
            const sec=sectionFor(q);
            return <div key={q.id} className="rounded-xl border border-slate-200 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="text-xs font-bold text-slate-800">{sec?.title ? <span className="block text-[9px] text-slate-400 uppercase tracking-wide">{sec.title}</span> : null}{q.prompt}</div>
                <span className="text-[10px] text-slate-400 font-mono shrink-0">{q.points} pts{q.difficulty?` · ${q.difficulty}`:''}</span>
              </div>
              {q.qtype==='mcq' && q.options && <div className="mt-2 space-y-1">{q.options.map((o:any)=>(
                <label key={o.key} className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer"><input type="radio" name={`${component.key}-${q.questionKey}`} checked={ans===o.key} onChange={()=>onPatchAnswer(component.key,q.questionKey,o.key)} className="accent-indigo-600"/>{o.text}</label>
              ))}</div>}
              {(q.qtype==='short_answer') && <input value={ans} onChange={e=>onPatchAnswer(component.key,q.questionKey,e.target.value)} placeholder="Type answer…" className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-xs" />}
              {(q.qtype==='essay'||q.qtype==='speaking') && <textarea value={ans} onChange={e=>onPatchAnswer(component.key,q.questionKey,e.target.value)} rows={q.qtype==='essay'?4:2} placeholder={q.qtype==='essay'?'Write the essay here…':'Record speaking notes / response…'} className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-xs" />}
              {fb && <div className={`mt-1.5 text-[10px] font-bold ${fb==='Correct'?'text-emerald-600':'text-slate-500'}`}>{fb}</div>}
            </div>;
          })}
        </div>
        {timedOut ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 flex items-center gap-2 text-xs font-bold text-rose-700"><AlertTriangle className="w-4 h-4"/> This component timed out. Only management can waive it.</div>
        ) : (
          <button type="button" onClick={()=>onSubmitContent(component)} disabled={submittingContent===component.key||attempt.status==='completed'||attempt.status==='paused'} className="px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-black disabled:opacity-50 cursor-pointer flex items-center gap-2">{submittingContent===component.key?<Loader2 className="w-4 h-4 animate-spin"/>:<FileText className="w-4 h-4"/>} Submit & auto-score</button>
        )}
        {hasManual && !timedOut && <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 space-y-2">
          <div className="text-[10px] font-black text-amber-700 uppercase tracking-wide">Manual score (essay / speaking)</div>
          <input type="number" min={0} max={component.maxScore} value={d.score??''} onChange={e=>onPatchDraft(component.key,{score:e.target.value})} className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono font-bold text-xs" placeholder={`0–${component.maxScore}`} />
          <textarea value={d.resultText||''} onChange={e=>onPatchDraft(component.key,{resultText:e.target.value})} rows={3} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs" placeholder="Rubric-based feedback…" />
          <p className="text-[10px] text-amber-600">Save the section to record the manual score after auto-grading.</p>
        </div>}
      </div>;
    }
    return <div className="space-y-4"><div><label className="block text-[11px] font-black text-slate-500 uppercase tracking-wide mb-2">Score</label><input type="number" min={0} max={component.maxScore} value={d.score??''} onChange={e=>onPatchDraft(component.key,{score:e.target.value})} className="w-full rounded-xl border border-slate-200 px-3 py-3 text-lg font-mono font-black" placeholder={`0–${component.maxScore}`}/></div><div><label className="block text-[11px] font-black text-slate-500 uppercase tracking-wide mb-2">Evaluator notes</label><textarea value={d.resultText||''} onChange={e=>onPatchDraft(component.key,{resultText:e.target.value})} rows={5} className="w-full rounded-xl border border-slate-200 px-3 py-3 text-sm" placeholder={component.type==='interview'?'Record fluency, pronunciation, grammar, confidence, comprehension…':'Summarize the written/assessment outcome…'}/></div></div>;
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2 text-sm font-black text-slate-800">{componentIcon[component.type]}{component.label} <span className="text-[10px] font-bold text-slate-400">({component.key})</span></div>
        <div className="flex items-center gap-2 text-[10px] font-bold text-slate-400">{component.required?'Required':'Optional'} · {component.weight}% · max {component.maxScore}{component.scoringMethod?` · ${component.scoringMethod}`:''}{component.minScore?` · min ${component.minScore}`:''}</div>
      </div>
      {renderEditor()}
      <div className="mt-4 flex justify-end">
        <button onClick={()=>onSave(component)} disabled={savingKey===component.key || attempt.status==='completed' || attempt.status==='paused' || timedOut} className="px-5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-900 text-white text-xs font-black disabled:opacity-40 flex items-center gap-2">{savingKey===component.key?<Loader2 className="w-4 h-4 animate-spin"/>:<Save className="w-4 h-4"/>} Save section</button>
      </div>
    </div>
  );
}
