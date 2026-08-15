import React, { useEffect, useMemo, useState } from 'react';
import {
  Award, CheckCircle2, Clock3, FileText, Loader2, MessageSquareText, Save, Sparkles, X, ChevronRight, BookOpen, ShieldCheck
} from 'lucide-react';
import { api } from '../../api/client';
import type { Visitor } from '../../types';

type ComponentType = 'skill_scores' | 'written_test' | 'interview' | 'level_assessment' | 'custom_score';
interface ComponentConfig { key:string; type:ComponentType; label:string; required:boolean; weight:number; maxScore:number; durationMinutes?:number|null; instructions?:string|null; skills?:string[]; }
interface PlacementProfile { configured:boolean; enabled:boolean; required:boolean; method:string; programName:string; versionLabel?:string; instructions?:string|null; components:ComponentConfig[]; levels:Array<{id:string;name:string;code?:string|null}>; allowRetake:boolean; passScore:number; }
interface AttemptResult { component_key:string; component_type:string; label:string; status:string; score:number|null; max_score:number; weight:number; selected_level_id?:string|null; notes?:string|null; result_text?:string|null; payload_json?:string|null; }
interface Attempt { id:string; attempt_number:number; status:string; percentage?:number|null; recommendation_text?:string|null; results:AttemptResult[]; }

interface Props { visitor: Visitor; onClose:()=>void; onCompleted:()=>Promise<void>; triggerToast:(message:string,type:'success'|'error'|'info')=>void; }

const skillLabels: Record<string,string> = { grammar:'Grammar', vocabulary:'Vocabulary', reading:'Reading', listening:'Listening', writing:'Writing', speaking:'Speaking' };
const componentIcon: Record<ComponentType, React.ReactNode> = {
  skill_scores:<Sparkles className="w-4 h-4"/>, written_test:<FileText className="w-4 h-4"/>, interview:<MessageSquareText className="w-4 h-4"/>, level_assessment:<BookOpen className="w-4 h-4"/>, custom_score:<Award className="w-4 h-4"/>
};

export default function PlacementTestModal({ visitor, onClose, onCompleted, triggerToast }: Props) {
  const [profile,setProfile]=useState<PlacementProfile|null>(null);
  const [attempt,setAttempt]=useState<Attempt|null>(null);
  const [loading,setLoading]=useState(true);
  const [starting,setStarting]=useState(false);
  const [canStart,setCanStart]=useState(false);
  const [savingKey,setSavingKey]=useState<string|null>(null);
  const [completing,setCompleting]=useState(false);
  const [activeKey,setActiveKey]=useState<string>('');
  const [drafts,setDrafts]=useState<Record<string,any>>({});

  useEffect(()=>{ let cancelled=false; (async()=>{
    setLoading(true);
    try {
      const data=await api.get<any>(`/placement/visitors/${visitor.id}/placement`);
      if(cancelled)return;
      setProfile(data.profile);
      const current=data.current as Attempt|null;
      if(!current && data.profile?.enabled) setCanStart(true);
      if(cancelled)return;
      setAttempt(current);
      if(current?.results?.length) {
        const next:Record<string,any>={};
        for(const r of current.results){
          const payload=r.payload_json?JSON.parse(r.payload_json):{};
          next[r.component_key]={...payload,score:r.score ?? '',notes:r.notes ?? '',resultText:r.result_text ?? '',selectedLevelId:r.selected_level_id ?? ''};
        }
        setDrafts(next);
        setActiveKey(current.results.find(r=>r.status!=='completed')?.component_key || current.results[0]?.component_key || '');
      } else if(data.profile?.components?.[0]) setActiveKey(data.profile.components[0].key);
    }catch(err:any){
      const status = err?.status || err?.response?.status;
      const message = err?.message || err?.response?.data?.error || 'Unable to load placement workspace.';
      triggerToast(status ? `${message} (HTTP ${status})` : message,'error');
    }
    finally{ if(!cancelled){setLoading(false);setStarting(false);} }
  })(); return ()=>{cancelled=true;}; },[visitor.id, triggerToast]);

  const activeComponent=useMemo(()=>profile?.components?.find(c=>c.key===activeKey)||profile?.components?.[0]||null,[profile,activeKey]);
  const completedCount=attempt?.results?.filter(r=>r.status==='completed').length||0;
  const totalCount=profile?.components?.length||0;
  const progress=totalCount?Math.round((completedCount/totalCount)*100):0;

  const patchDraft=(key:string,patch:any)=>setDrafts(prev=>({...prev,[key]:{...(prev[key]||{}),...patch}}));
  const saveComponent=async(component:ComponentConfig)=>{
    if(!attempt) return;
    const draft=drafts[component.key]||{};
    setSavingKey(component.key);
    try{
      const payload:any={status:'completed',notes:draft.notes||null,resultText:draft.resultText||null,selectedLevelId:draft.selectedLevelId||null};
      if(component.type==='skill_scores') payload.skills=draft.skills||{};
      else payload.score=Number(draft.score);
      const results=await api.put<AttemptResult[]>(`/placement/visitors/${visitor.id}/placement/attempts/${attempt.id}/components/${component.key}`,payload);
      setAttempt(prev=>prev?({...prev,results}):prev);
      triggerToast(`${component.label} saved.`,'success');
    }catch(err:any){triggerToast(err?.message||err?.response?.data?.error||`Could not save ${component.label}.`,'error');}
    finally{setSavingKey(null);}
  };

  const startAssessment=async()=>{
    if(!profile?.enabled || attempt || starting) return;
    setStarting(true);
    try {
      const current=await api.post<Attempt>(`/placement/visitors/${visitor.id}/placement/attempts`,{});
      setAttempt(current);
      setCanStart(false);
      setDrafts({});
      setActiveKey(current.results?.[0]?.component_key || profile.components?.[0]?.key || '');
      triggerToast('Placement assessment started.','success');
    } catch (err: any) {
      triggerToast(err?.message || err?.response?.data?.error || 'Unable to start placement assessment.','error');
    } finally { setStarting(false); }
  };

  const completeAttempt=async()=>{
    if(!attempt) return;
    setCompleting(true);
    try{
      const result=await api.post<any>(`/placement/visitors/${visitor.id}/placement/attempts/${attempt.id}/complete`,{notes:null});
      setAttempt(result.attempt);
      triggerToast(result.feeCharged>0?`Placement completed. Fee ${result.feeCharged} AFN recorded.`:'Placement assessment completed.','success');
      await onCompleted();
    }catch(err:any){triggerToast(err?.message||err?.response?.data?.error||'Complete the required sections before finishing the assessment.','error');}
    finally{setCompleting(false);}
  };

  const renderEditor=()=>{
    if(!activeComponent) return null;
    const d=drafts[activeComponent.key]||{};
    if(activeComponent.type==='skill_scores'){
      const skills=(activeComponent.skills?.length?activeComponent.skills:['grammar','vocabulary','reading','listening','writing','speaking']);
      return <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{skills.map(skill=><div key={skill} className="rounded-2xl border border-slate-200 bg-slate-50 p-3"><div className="flex justify-between text-[11px] font-bold text-slate-600 mb-2"><span>{skillLabels[skill]||skill}</span><span className="font-mono">{d.skills?.[skill] ?? 0}/25</span></div><input type="range" min={0} max={25} value={Number(d.skills?.[skill]??0)} onChange={e=>patchDraft(activeComponent.key,{skills:{...(d.skills||{}),[skill]:Number(e.target.value)}})} className="w-full"/><div className="mt-2 text-right text-xs font-black text-indigo-700">{Number(d.skills?.[skill]??0)}</div></div>)}</div>;
    }
    if(activeComponent.type==='level_assessment') return <div className="space-y-4"><div><label className="block text-[11px] font-black text-slate-500 uppercase tracking-wide mb-2">Recommended level</label><select value={d.selectedLevelId||''} onChange={e=>patchDraft(activeComponent.key,{selectedLevelId:e.target.value})} className="w-full rounded-xl border border-slate-200 px-3 py-3 text-sm font-semibold"><option value="">Select level…</option>{(profile?.levels||[]).map(l=><option key={l.id} value={l.id}>{l.code ? `${l.code} — `:''}{l.name}</option>)}</select></div><div><label className="block text-[11px] font-black text-slate-500 uppercase tracking-wide mb-2">Assessment score (optional)</label><input type="number" min={0} max={activeComponent.maxScore} value={d.score??''} onChange={e=>patchDraft(activeComponent.key,{score:e.target.value})} className="w-full rounded-xl border border-slate-200 px-3 py-3 font-mono font-bold"/></div></div>;
    return <div className="space-y-4"><div><label className="block text-[11px] font-black text-slate-500 uppercase tracking-wide mb-2">Score</label><input type="number" min={0} max={activeComponent.maxScore} value={d.score??''} onChange={e=>patchDraft(activeComponent.key,{score:e.target.value})} className="w-full rounded-xl border border-slate-200 px-3 py-3 text-lg font-mono font-black" placeholder={`0–${activeComponent.maxScore}`}/></div><div><label className="block text-[11px] font-black text-slate-500 uppercase tracking-wide mb-2">Evaluator notes</label><textarea value={d.resultText||''} onChange={e=>patchDraft(activeComponent.key,{resultText:e.target.value})} rows={5} className="w-full rounded-xl border border-slate-200 px-3 py-3 text-sm" placeholder={activeComponent.type==='interview'?'Record fluency, pronunciation, grammar, confidence, comprehension…':'Summarize the written/assessment outcome…'}/></div></div>;
  };

  return <div className="fixed inset-0 z-[70] bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={e=>e.target===e.currentTarget&&!completing&&!savingKey&&onClose()}>
    <div className="w-full max-w-6xl max-h-[94vh] bg-white rounded-[28px] shadow-2xl overflow-hidden flex flex-col">
      <header className="px-6 py-4 border-b border-slate-100 flex items-center justify-between gap-4"><div className="flex items-center gap-3"><div className="w-11 h-11 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center"><Award className="w-5 h-5"/></div><div><div className="text-sm font-black text-slate-900">Placement Assessment Workspace</div><div className="text-xs text-slate-500">{visitor.fullName} · {profile?.programName||'Program'} {profile?.versionLabel||''}</div></div></div><div className="flex items-center gap-2"><span className={`px-3 py-1.5 rounded-full text-[10px] font-black ${profile?.required?'bg-amber-100 text-amber-800':'bg-emerald-100 text-emerald-800'}`}>{profile?.required?'Required':'Optional'}</span><button onClick={onClose} className="p-2 rounded-xl bg-slate-50 hover:bg-slate-100 text-slate-500"><X className="w-4 h-4"/></button></div></header>
      {loading ? <div className="flex-1 flex items-center justify-center py-24 text-slate-500"><Loader2 className="w-6 h-6 animate-spin mr-3"/>Preparing candidate workspace…</div> : !profile?.enabled ? <div className="p-10 text-center"><ShieldCheck className="w-10 h-10 mx-auto text-emerald-500 mb-3"/><h3 className="font-black text-slate-900">No placement assessment configured</h3><p className="text-sm text-slate-500 mt-1">This program can proceed without a placement assessment.</p><button onClick={onClose} className="mt-5 px-5 py-2.5 bg-slate-900 text-white rounded-xl font-bold">Close</button></div> : !attempt ? <div className="p-10 text-center flex-1 flex flex-col items-center justify-center"><Award className="w-12 h-12 text-indigo-600 mb-4"/><h3 className="font-black text-xl text-slate-900">Ready to assess {visitor.fullName}</h3><p className="text-sm text-slate-500 mt-2 max-w-lg">{profile.required ? 'This assessment is required for this program before enrollment.' : 'This assessment is optional for this program.'} You will complete all configured sections in one candidate workspace.</p><div className="mt-5 flex items-center gap-2 text-xs text-slate-500"><span className="px-3 py-1.5 rounded-full bg-slate-100 font-bold">{profile.components.length} sections</span><span className="px-3 py-1.5 rounded-full bg-slate-100 font-bold">{profile.method.replace('_',' ')}</span></div><button onClick={startAssessment} disabled={!canStart||starting} className="mt-7 px-6 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-black text-sm shadow-lg shadow-indigo-200 disabled:opacity-50">{starting ? 'Starting…' : 'Start Assessment'}</button></div> : <div className="flex-1 min-h-0 grid lg:grid-cols-[300px_1fr]">
        <aside className="border-r border-slate-100 bg-slate-50/70 p-4 overflow-y-auto"><div className="mb-4"><div className="flex justify-between text-[10px] font-black uppercase tracking-wider text-slate-400"><span>Assessment progress</span><span>{completedCount}/{totalCount}</span></div><div className="h-2 bg-slate-200 rounded-full mt-2 overflow-hidden"><div className="h-full bg-indigo-600 rounded-full transition-all" style={{width:`${progress}%`}}/></div></div><div className="space-y-2">{(profile.components||[]).map((c)=>{const r=attempt?.results?.find(x=>x.component_key===c.key);return <button key={c.key} onClick={()=>setActiveKey(c.key)} className={`w-full text-left p-3 rounded-2xl border transition-all ${activeComponent?.key===c.key?'bg-white border-indigo-200 shadow-sm':'border-transparent hover:bg-white hover:border-slate-200'}`}><div className="flex items-start gap-2"><div className={`w-8 h-8 rounded-xl flex items-center justify-center ${r?.status==='completed'?'bg-emerald-50 text-emerald-600':'bg-indigo-50 text-indigo-600'}`}>{r?.status==='completed'?<CheckCircle2 className="w-4 h-4"/>:componentIcon[c.type]}</div><div className="min-w-0 flex-1"><div className="text-xs font-black text-slate-800 truncate">{c.label}</div><div className="text-[10px] text-slate-400 mt-0.5">{c.required?'Required':'Optional'} · {c.weight}%</div></div><ChevronRight className="w-4 h-4 text-slate-300 mt-1"/></div></button>})}</div><div className="mt-5 p-3 rounded-2xl border border-slate-200 bg-white text-[10px] text-slate-500 leading-relaxed"><div className="flex items-center gap-1.5 font-black text-slate-700 mb-1"><Clock3 className="w-3.5 h-3.5"/> Single candidate workspace</div>All configured assessment sections stay under this candidate and are saved independently until the final submission.</div></aside>
        <main className="min-h-0 flex flex-col"><div className="flex-1 overflow-y-auto p-6"><div className="max-w-3xl mx-auto"><div className="flex items-start justify-between gap-4 mb-5"><div><div className="flex items-center gap-2 text-indigo-600 mb-1">{activeComponent && componentIcon[activeComponent.type]}<span className="text-[10px] uppercase tracking-wider font-black">Assessment section</span></div><h2 className="text-xl font-black text-slate-900">{activeComponent?.label}</h2><p className="text-xs text-slate-500 mt-1">{activeComponent?.instructions||profile.instructions||'Complete and save this section. The candidate record remains open until all required sections are finished.'}</p></div></div>{renderEditor()}</div></div><footer className="border-t border-slate-100 px-6 py-4 bg-white flex items-center justify-between gap-3"><div className="text-xs text-slate-500">{attempt?.status==='completed'?<span className="font-black text-emerald-700">Completed · {attempt.percentage}% · {attempt.recommendation_text}</span>:<span>Section {Math.max(1,(profile.components||[]).findIndex(c=>c.key===activeComponent?.key)+1)} of {profile.components.length}</span>}</div><div className="flex gap-2"><button onClick={()=>activeComponent&&saveComponent(activeComponent)} disabled={!activeComponent||!!savingKey||attempt?.status==='completed'} className="px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-black disabled:opacity-50 flex items-center gap-2">{savingKey?<Loader2 className="w-4 h-4 animate-spin"/>:<Save className="w-4 h-4"/>} Save section</button>{attempt?.status!=='completed'&&<button onClick={completeAttempt} disabled={completing||completedCount===0} className="px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-black disabled:opacity-50 flex items-center gap-2">{completing?<Loader2 className="w-4 h-4 animate-spin"/>:<CheckCircle2 className="w-4 h-4"/>} Complete assessment</button>}</div></footer></main>
      </div>}
    </div>
  </div>;
}
