/**
 * Academic Setup — Premium 3-Phase Wizard Hub
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  BookOpen, Clock, DoorOpen, Layers, Plus, RefreshCw, CalendarRange,
  ChevronDown, ChevronRight, Pencil, Trash2, Power, X, Check, Building2,
  GitBranch, Wand2, Lock, CheckCircle2, Settings, Package, Loader2
} from 'lucide-react';
import { api } from '../../api/client';
import { formatAFN } from '../../utils/format';
import ProgramVersionsPanel from './ProgramVersionsPanel';
import ClassGenerationWizard from './ClassGenerationWizard';
import OfferingsPanel from './OfferingsPanel';
import { ShamsiDateInput } from '../common/ShamsiDateInput';

type Tab = 'catalog' | 'versions' | 'offerings' | 'generate' | 'slots' | 'rooms' | 'terms';

function NavButton({ t, label, icon, isLocked, tab, setTab }: { t: Tab; label: string; icon: React.ReactNode; isLocked: boolean; tab: Tab; setTab: React.Dispatch<React.SetStateAction<Tab>> }) {
  return (
    <button type="button" disabled={isLocked} title={isLocked ? 'Complete the previous phase to unlock this step.' : label}
      onClick={() => !isLocked && setTab(t)}
      className={`flex items-center gap-2 text-xs font-bold px-4 py-2.5 rounded-xl border transition-all w-full ${isLocked ? 'opacity-50 border-slate-100 bg-slate-50 cursor-not-allowed' : tab === t ? 'bg-slate-900 text-white border-slate-900 shadow-sm' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>
      {isLocked ? <Lock className="w-3.5 h-3.5" /> : icon} {label}
    </button>
  );
}

interface Program { id: string; name: string; code?: string | null; description?: string | null; durationMonths?: number; isActive: boolean; }
interface Level { id: string; programId: string; name: string; code?: string | null; order: number; durationMonths: number; defaultFee: number; passMark: number; minViableSize?: number; isActive: boolean; }
interface TimeSlot { id: string; code: string; label: string; startTime: string; endTime: string; isActive: boolean; sortOrder?: number; }
interface Room { id: string; code: string; name: string; capacity: number; isActive: boolean; notes?: string | null; }
interface Term { id: string; year: number; code: string; name: string; startDate?: string | null; endDate?: string | null; isActive: boolean; }
interface FeeRow { id: string; levelId: string; fee: number; }

function ToggleActive({ active, onToggle, disabled }: { active: boolean; onToggle: () => void; disabled?: boolean }) {
  return (
    <button type="button" disabled={disabled} onClick={onToggle} title={active ? 'Deactivate' : 'Activate'}
      className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-lg border ${active ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-100 text-slate-500 border-slate-200'} disabled:opacity-50 cursor-pointer transition-colors`}>
      <Power className="w-3 h-3" /> {active ? 'Active' : 'Inactive'}
    </button>
  );
}

export default function AcademicSetupView({ branchId }: { branchId?: string } = {}) {
  const [tab, setTab] = useState<Tab>('terms');
  // Tracks which heavy panels have been opened at least once, so each mounts
  // lazily but then STAYS mounted instead of refetching on every revisit.
  const [visited, setVisited] = useState<Record<string, boolean>>({});
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  useEffect(() => { setVisited((seen) => (seen[tab] ? seen : { ...seen, [tab]: true })); }, [tab]);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [levels, setLevels] = useState<Level[]>([]);
  const [slots, setSlots] = useState<TimeSlot[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [terms, setTerms] = useState<Term[]>([]);
  const [, setFees] = useState<FeeRow[]>([]);
  const [offeringCount, setOfferingCount] = useState(0);
  const [versionCount, setVersionCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  type AcademicDefaults = { levelDurationMonths: number; levelDefaultFee: number; levelPassMark: number; levelMinViableSize: number };
  const [, setAcademicDefaults] = useState<AcademicDefaults>({ levelDurationMonths: 1, levelDefaultFee: 0, levelPassMark: 70, levelMinViableSize: 5 });
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const [progName, setProgName] = useState(''); const [progCode, setProgCode] = useState(''); const [progDesc, setProgDesc] = useState('');
  const [editProgId, setEditProgId] = useState<string | null>(null); const [editProgName, setEditProgName] = useState(''); const [editProgCode, setEditProgCode] = useState(''); const [editProgDesc, setEditProgDesc] = useState('');
  const [levelFormProgramId, setLevelFormProgramId] = useState<string | null>(null);
  const [lvlName, setLvlName] = useState(''); const [lvlCode, setLvlCode] = useState(''); const [lvlOrder, setLvlOrder] = useState(1); const [lvlMonths, setLvlMonths] = useState(0); const [lvlFee, setLvlFee] = useState(0); const [lvlPass, setLvlPass] = useState(0); const [lvlMinViable, setLvlMinViable] = useState(0);
  const [editLvlId, setEditLvlId] = useState<string | null>(null); const [editLvl, setEditLvl] = useState({ name: '', code: '', order: 1, durationMonths: 0, defaultFee: 0, passMark: 0, minViableSize: 0 });
  const [feeDraft, setFeeDraft] = useState<Record<string, number>>({});
  const [slotForm, setSlotForm] = useState({ code: '', label: '', startTime: '08:00', endTime: '09:30' }); const [editSlotId, setEditSlotId] = useState<string | null>(null); const [editSlot, setEditSlot] = useState({ code: '', label: '', startTime: '', endTime: '' });
  const [roomForm, setRoomForm] = useState({ code: '', name: '', capacity: 20 }); const [editRoomId, setEditRoomId] = useState<string | null>(null); const [editRoom, setEditRoom] = useState({ code: '', name: '', capacity: 20 });
  const [termForm, setTermForm] = useState({ year: new Date().getFullYear(), code: 'FALL', name: 'Fall', startDate: '', endDate: '' }); const [editTermId, setEditTermId] = useState<string | null>(null); const [editTerm, setEditTerm] = useState({ year: 2026, code: '', name: '', startDate: '', endDate: '' });

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [defaults, p, l, s, r, tm, f] = await Promise.all([
        api.get<AcademicDefaults>('/academic/defaults'),
        api.get<Program[]>('/academic/programs'), api.get<Level[]>('/academic/levels'),
        api.get<TimeSlot[]>('/academic/time-slots'), api.get<Room[]>('/academic/rooms'),
        api.get<Term[]>('/academic/terms'), api.get<FeeRow[]>('/academic/level-fees'),
      ]);
      setAcademicDefaults(defaults);
      setLvlMonths(defaults.levelDurationMonths); setLvlFee(defaults.levelDefaultFee); setLvlPass(defaults.levelPassMark); setLvlMinViable(defaults.levelMinViableSize);
      setEditLvl((current) => ({ ...current, durationMonths: defaults.levelDurationMonths, defaultFee: defaults.levelDefaultFee, passMark: defaults.levelPassMark, minViableSize: defaults.levelMinViableSize }));
      setPrograms(Array.isArray(p) ? p : []); setLevels(Array.isArray(l) ? l : []); setSlots(Array.isArray(s) ? s : []); setRooms(Array.isArray(r) ? r : []); setTerms(Array.isArray(tm) ? tm : []); setFees(Array.isArray(f) ? f : []);
      try { const [offs, vers] = await Promise.all([api.get<any[]>('/offerings'), api.get<any[]>('/catalog/program-versions')]); setOfferingCount(Array.isArray(offs) ? offs.length : 0); setVersionCount(Array.isArray(vers) ? vers.length : 0); } catch { setOfferingCount(0); setVersionCount(0); }
      const draft: Record<string, number> = {}; for (const fee of f) draft[fee.levelId] = fee.fee; setFeeDraft(draft);
      setExpanded((prev) => { const next = { ...prev }; for (const prog of p) { if (next[prog.id] === undefined) next[prog.id] = true; } return next; });
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to load configuration'); }
    finally { setLoading(false); setHasLoadedOnce(true); }
  }, []);

  useEffect(() => { void (async () => { await reload(); })(); }, [reload]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); await reload(); } catch (err) { setError(err instanceof Error ? err.message : 'Operation failed'); } finally { setBusy(false); }
  };

  const levelsOf = (programId: string) => levels.filter((l) => l.programId === programId).sort((a, b) => a.order - b.order);
  const feeFor = (levelId: string, defaultFee: number) => feeDraft[levelId] !== undefined ? feeDraft[levelId] : defaultFee;

  const phase1Complete = terms.length > 0 && slots.length > 0 && rooms.length > 0;
  const phase2Complete = programs.length > 0 && versionCount > 0;
  const phase3Complete = phase2Complete && offeringCount > 0;

  // Only the FIRST load replaces the page. `run()` calls reload() after every
  // mutation, and this branch used to blank the whole screen each time —
  // adding one term made the entire Control Center disappear and re-appear.
  // Subsequent reloads keep the page on screen; `busy` drives a local
  // indicator instead.
  if (loading && !hasLoadedOnce) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-slate-400 gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
        <span className="text-xs font-semibold uppercase tracking-wide">Loading Academic Setup...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6 font-sans text-left bg-slate-50 min-h-screen p-4 md:p-8" dir="ltr">
      
      {/* Header */}
      <div className="bg-white p-6 rounded-3xl shadow-sm border border-slate-200 flex flex-col md:flex-row justify-between items-center gap-4">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-2xl flex items-center justify-center shadow-lg shadow-indigo-200">
            <Settings className="w-7 h-7 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">Academic Configuration Center</h1>
            <p className="text-sm text-slate-500 mt-1">Follow the steps in order to set up your branch's academic infrastructure.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="hidden md:flex items-center gap-1.5 text-[11px] font-bold text-slate-500 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2">
            {phase3Complete ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" /> : phase2Complete ? <span className="text-amber-600">Next: create a Course Offering</span> : phase1Complete ? <span className="text-amber-600">Next: add a Program</span> : <span className="text-amber-600">Next: add Terms, Time Slots, Rooms</span>}
          </div>
          <button type="button" onClick={() => reload()} className="text-xs font-bold text-indigo-600 flex items-center gap-1 hover:underline shrink-0 bg-indigo-50 px-3 py-2 rounded-xl cursor-pointer">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh Data
          </button>
        </div>
      </div>

      {error && <div className="bg-rose-50 border border-rose-200 text-rose-700 text-sm font-semibold rounded-xl p-4 flex items-center gap-2">{error}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        {/* Left Navigation (Wizard Hub) */}
        <div className="lg:col-span-4 space-y-6">
          <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
            <h3 className="text-xs font-extrabold text-slate-800 uppercase tracking-wider mb-3 flex items-center gap-1.5"><span className="w-6 h-6 rounded-full bg-indigo-600 text-white flex items-center justify-center text-[10px]">1</span> Infrastructure</h3>
            <div className="space-y-2">
              <NavButton tab={tab} setTab={setTab} t="terms" label="1.1 Academic Terms" icon={<CalendarRange className="w-3.5 h-3.5" />} isLocked={false} />
              <NavButton tab={tab} setTab={setTab} t="slots" label="1.2 Time Slots" icon={<Clock className="w-3.5 h-3.5" />} isLocked={false} />
              <NavButton tab={tab} setTab={setTab} t="rooms" label="1.3 Physical Rooms" icon={<DoorOpen className="w-3.5 h-3.5" />} isLocked={false} />
            </div>
            {phase1Complete && <p className="text-[10px] text-emerald-600 font-bold mt-2 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Phase 1 Complete</p>}
          </div>

          <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
            <h3 className="text-xs font-extrabold text-slate-800 uppercase tracking-wider mb-3 flex items-center gap-1.5"><span className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] ${phase1Complete ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-400'}`}>2</span> Curriculum</h3>
            <div className="space-y-2">
              <NavButton tab={tab} setTab={setTab} t="catalog" label="2.1 Programs & Levels" icon={<Layers className="w-3.5 h-3.5" />} isLocked={!phase1Complete} />
              <NavButton tab={tab} setTab={setTab} t="versions" label="2.2 Versions & Rules" icon={<GitBranch className="w-3.5 h-3.5" />} isLocked={!phase1Complete} />
            </div>
            {!phase1Complete && <p className="text-[10px] text-amber-600 font-bold mt-2">Set up terms, slots, and rooms above to unlock curriculum steps.</p>}
          </div>

          <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
            <h3 className="text-xs font-extrabold text-slate-800 uppercase tracking-wider mb-3 flex items-center gap-1.5"><span className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] ${phase2Complete ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-400'}`}>3</span> Course Delivery</h3>
            <div className="space-y-2">
              <NavButton tab={tab} setTab={setTab} t="offerings" label="3.1 Course Offerings" icon={<Package className="w-3.5 h-3.5" />} isLocked={!phase2Complete} />
              <NavButton tab={tab} setTab={setTab} t="generate" label="3.2 Generate Classes" icon={<Wand2 className="w-3.5 h-3.5" />} isLocked={!phase3Complete} />
            </div>
            {!phase2Complete && <p className="text-[10px] text-amber-600 font-bold mt-2">Add a program and publish a version to unlock course delivery.</p>}
            {phase2Complete && !phase3Complete && <p className="text-[10px] text-amber-600 font-bold mt-2">Create at least one Course Offering before generating classes.</p>}
          </div>
        </div>

        {/* Right Content Area */}
        <div className="lg:col-span-8 bg-white p-6 rounded-2xl border border-slate-200 shadow-sm min-h-[400px]">
          
          {tab === 'terms' && (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-extrabold text-slate-900">Academic Terms & Calendar</h2>
                <p className="text-xs text-slate-500 mt-1">Define semesters (e.g., Fall 2026) and their start/end dates. Sessions are auto-generated only within these dates.</p>
              </div>
              <form className="bg-slate-50 border border-slate-200 rounded-xl p-4 grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs items-end"
                onSubmit={(e) => { e.preventDefault(); run(async () => { await api.post('/academic/terms', termForm); }); }}>
                <p className="col-span-2 sm:col-span-5 font-extrabold text-slate-800">New academic term</p>
                <input type="number" required value={termForm.year} onChange={(e) => setTermForm({ ...termForm, year: Number(e.target.value) })} className="border border-slate-200 rounded-lg px-2 py-1.5" placeholder="Year" />
                <input required value={termForm.code} onChange={(e) => setTermForm({ ...termForm, code: e.target.value })} placeholder="Code" className="border border-slate-200 rounded-lg px-2 py-1.5 font-mono" />
                <input required value={termForm.name} onChange={(e) => setTermForm({ ...termForm, name: e.target.value })} placeholder="Name" className="border border-slate-200 rounded-lg px-2 py-1.5" />
                <ShamsiDateInput value={termForm.startDate} onChange={(v) => setTermForm({ ...termForm, startDate: v })} />
                <button type="submit" disabled={busy} className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-bold disabled:opacity-50 flex items-center justify-center gap-1">{busy && <Loader2 className="w-3 h-3 animate-spin" />} Create</button>
              </form>
              <div className="space-y-2">
                {terms.length === 0 ? <p className="text-xs text-slate-400 italic text-center py-8">No academic terms yet.</p> : terms.map((tm) => (
                  <div key={tm.id} className={`border rounded-xl px-3 py-2.5 text-xs flex flex-wrap items-center gap-2 ${tm.isActive ? 'border-slate-200' : 'opacity-60'}`}>
                    {editTermId === tm.id ? (
                      <>
                        <input type="number" value={editTerm.year} onChange={(e) => setEditTerm({ ...editTerm, year: Number(e.target.value) })} className="border rounded-lg px-2 py-1 w-20" />
                        <input value={editTerm.code} onChange={(e) => setEditTerm({ ...editTerm, code: e.target.value })} className="border rounded-lg px-2 py-1 font-mono w-24" />
                        <input value={editTerm.name} onChange={(e) => setEditTerm({ ...editTerm, name: e.target.value })} className="border rounded-lg px-2 py-1 flex-1" />
                        <button type="button" disabled={busy} className="p-1.5 bg-emerald-600 text-white rounded-lg" onClick={() => run(async () => { await api.put(`/academic/terms/${tm.id}`, editTerm); setEditTermId(null); })}><Check className="w-3.5 h-3.5" /></button>
                        <button type="button" className="p-1.5 bg-slate-100 rounded-lg" onClick={() => setEditTermId(null)}><X className="w-3.5 h-3.5" /></button>
                      </>
                    ) : (
                      <>
                        <div className="flex-1"><p className="font-bold">{tm.name} <span className="font-mono text-indigo-600">({tm.code})</span></p><p className="text-[10px] text-slate-500">Year {tm.year}{tm.startDate ? ` · ${tm.startDate}` : ''}</p></div>
                        <ToggleActive active={tm.isActive} disabled={busy} onToggle={() => run(async () => { await api.put(`/academic/terms/${tm.id}`, { isActive: !tm.isActive }); })} />
                        <button type="button" className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-lg" onClick={() => { setEditTermId(tm.id); setEditTerm({ year: tm.year, code: tm.code, name: tm.name, startDate: tm.startDate || '', endDate: tm.endDate || '' }); }}><Pencil className="w-3.5 h-3.5" /></button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'slots' && (
            <div className="space-y-4">
              <div><h2 className="text-lg font-extrabold text-slate-900">Timetable Slots</h2><p className="text-xs text-slate-500 mt-1">Define class time slots (e.g., Sat-Wed 08:00-10:00) used for scheduling.</p></div>
              <form className="bg-slate-50 border border-slate-200 rounded-xl p-4 grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs items-end"
                onSubmit={(e) => { e.preventDefault(); run(async () => { await api.post('/academic/time-slots', slotForm); setSlotForm({ code: '', label: '', startTime: '08:00', endTime: '09:30' }); }); }}>
                <p className="col-span-2 sm:col-span-5 font-extrabold text-slate-800">New time slot</p>
                <input required value={slotForm.code} onChange={(e) => setSlotForm({ ...slotForm, code: e.target.value })} placeholder="Code *" className="border border-slate-200 rounded-lg px-2 py-1.5 font-mono" />
                <input required value={slotForm.label} onChange={(e) => setSlotForm({ ...slotForm, label: e.target.value })} placeholder="Label *" className="border border-slate-200 rounded-lg px-2 py-1.5" />
                <input required type="time" value={slotForm.startTime} onChange={(e) => setSlotForm({ ...slotForm, startTime: e.target.value })} className="border border-slate-200 rounded-lg px-2 py-1.5" />
                <input required type="time" value={slotForm.endTime} onChange={(e) => setSlotForm({ ...slotForm, endTime: e.target.value })} className="border border-slate-200 rounded-lg px-2 py-1.5" />
                <button type="submit" disabled={busy} className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-bold disabled:opacity-50 flex items-center justify-center gap-1">{busy && <Loader2 className="w-3 h-3 animate-spin" />} Create</button>
              </form>
              <div className="space-y-2">
                {slots.length === 0 ? <p className="text-xs text-slate-400 italic text-center py-8">No time slots for this branch.</p> : slots.map((s) => (
                  <div key={s.id} className={`border rounded-xl px-3 py-2.5 text-xs flex flex-wrap items-center gap-2 ${s.isActive ? 'border-slate-200' : 'opacity-60'}`}>
                    {editSlotId === s.id ? (
                      <>
                        <input value={editSlot.code} onChange={(e) => setEditSlot({ ...editSlot, code: e.target.value })} className="border rounded-lg px-2 py-1 font-mono w-20" />
                        <input value={editSlot.label} onChange={(e) => setEditSlot({ ...editSlot, label: e.target.value })} className="border rounded-lg px-2 py-1 flex-1 min-w-[100px]" />
                        <input type="time" value={editSlot.startTime} onChange={(e) => setEditSlot({ ...editSlot, startTime: e.target.value })} className="border rounded-lg px-2 py-1" />
                        <input type="time" value={editSlot.endTime} onChange={(e) => setEditSlot({ ...editSlot, endTime: e.target.value })} className="border rounded-lg px-2 py-1" />
                        <button type="button" disabled={busy} className="p-1.5 bg-emerald-600 text-white rounded-lg" onClick={() => run(async () => { await api.put(`/academic/time-slots/${s.id}`, editSlot); setEditSlotId(null); })}><Check className="w-3.5 h-3.5" /></button>
                        <button type="button" className="p-1.5 bg-slate-100 rounded-lg" onClick={() => setEditSlotId(null)}><X className="w-3.5 h-3.5" /></button>
                      </>
                    ) : (
                      <>
                        <div className="flex-1 min-w-[200px]"><p className="font-bold break-words">{s.label} <span className="font-mono text-indigo-600">({s.code})</span></p><p className="text-[10px] text-slate-500">{s.startTime} – {s.endTime}</p></div>
                        <ToggleActive active={s.isActive} disabled={busy} onToggle={() => run(async () => { await api.put(`/academic/time-slots/${s.id}`, { isActive: !s.isActive }); })} />
                        <button type="button" className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-lg" onClick={() => { setEditSlotId(s.id); setEditSlot({ code: s.code, label: s.label, startTime: s.startTime, endTime: s.endTime }); }}><Pencil className="w-3.5 h-3.5" /></button>
                        <button type="button" className="p-1.5 text-rose-500 hover:bg-rose-50 rounded-lg" disabled={busy} onClick={() => { if (!window.confirm('Deactivate this time slot?')) return; run(async () => { await api.delete(`/academic/time-slots/${s.id}`); }); }}><Trash2 className="w-3.5 h-3.5" /></button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'rooms' && (
            <div className="space-y-4">
              <div><h2 className="text-lg font-extrabold text-slate-900">Physical Rooms</h2><p className="text-xs text-slate-500 mt-1">Define classrooms and their capacity. Classes are assigned to these rooms automatically.</p></div>
              <form className="bg-slate-50 border border-slate-200 rounded-xl p-4 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs items-end"
                onSubmit={(e) => { e.preventDefault(); run(async () => { await api.post('/academic/rooms', roomForm); setRoomForm({ code: '', name: '', capacity: 20 }); }); }}>
                <p className="col-span-2 sm:col-span-4 font-extrabold text-slate-800">New room</p>
                <input required value={roomForm.code} onChange={(e) => setRoomForm({ ...roomForm, code: e.target.value })} placeholder="Code *" className="border border-slate-200 rounded-lg px-2 py-1.5 font-mono" />
                <input required value={roomForm.name} onChange={(e) => setRoomForm({ ...roomForm, name: e.target.value })} placeholder="Name *" className="border border-slate-200 rounded-lg px-2 py-1.5" />
                <input type="number" value={roomForm.capacity} onChange={(e) => setRoomForm({ ...roomForm, capacity: Number(e.target.value) })} className="border border-slate-200 rounded-lg px-2 py-1.5" placeholder="Capacity" />
                <button type="submit" disabled={busy} className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-bold disabled:opacity-50 flex items-center justify-center gap-1">{busy && <Loader2 className="w-3 h-3 animate-spin" />} Create</button>
              </form>
              <div className="space-y-2">
                {rooms.length === 0 ? <p className="text-xs text-slate-400 italic text-center py-8">No rooms for this branch.</p> : rooms.map((r) => (
                  <div key={r.id} className={`border rounded-xl px-3 py-2.5 text-xs flex flex-wrap items-center gap-2 ${r.isActive ? 'border-slate-200' : 'opacity-60'}`}>
                    {editRoomId === r.id ? (
                      <>
                        <input value={editRoom.code} onChange={(e) => setEditRoom({ ...editRoom, code: e.target.value })} className="border rounded-lg px-2 py-1 font-mono w-20" />
                        <input value={editRoom.name} onChange={(e) => setEditRoom({ ...editRoom, name: e.target.value })} className="border rounded-lg px-2 py-1 flex-1" />
                        <input type="number" value={editRoom.capacity} onChange={(e) => setEditRoom({ ...editRoom, capacity: Number(e.target.value) })} className="border rounded-lg px-2 py-1 w-20" />
                        <button type="button" disabled={busy} className="p-1.5 bg-emerald-600 text-white rounded-lg" onClick={() => run(async () => { await api.put(`/academic/rooms/${r.id}`, editRoom); setEditRoomId(null); })}><Check className="w-3.5 h-3.5" /></button>
                        <button type="button" className="p-1.5 bg-slate-100 rounded-lg" onClick={() => setEditRoomId(null)}><X className="w-3.5 h-3.5" /></button>
                      </>
                    ) : (
                      <>
                        <div className="flex-1"><p className="font-bold">{r.name} <span className="font-mono text-indigo-600">({r.code})</span></p><p className="text-[10px] text-slate-500">Capacity {r.capacity}</p></div>
                        <ToggleActive active={r.isActive} disabled={busy} onToggle={() => run(async () => { await api.put(`/academic/rooms/${r.id}`, { isActive: !r.isActive }); })} />
                        <button type="button" className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-lg" onClick={() => { setEditRoomId(r.id); setEditRoom({ code: r.code, name: r.name, capacity: r.capacity }); }}><Pencil className="w-3.5 h-3.5" /></button>
                        <button type="button" className="p-1.5 text-rose-500 hover:bg-rose-50 rounded-lg" disabled={busy} onClick={() => { if (!window.confirm('Deactivate this room?')) return; run(async () => { await api.delete(`/academic/rooms/${r.id}`); }); }}><Trash2 className="w-3.5 h-3.5" /></button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'catalog' && (
            <div className="space-y-4">
              <div><h2 className="text-lg font-extrabold text-slate-900">Programs & Levels</h2><p className="text-xs text-slate-500 mt-1">Create educational programs (e.g., TOEFL Prep) and their levels (Beginner, Advanced).</p></div>
              <form className="bg-slate-50 border border-slate-200 rounded-xl p-4 grid grid-cols-1 sm:grid-cols-4 gap-2 text-xs items-end"
                onSubmit={(e) => { e.preventDefault(); run(async () => { await api.post('/academic/programs', { name: progName, code: progCode || undefined, description: progDesc || undefined }); setProgName(''); setProgCode(''); setProgDesc(''); }); }}>
                <div className="sm:col-span-4 font-extrabold text-slate-800 flex items-center gap-1.5"><Plus className="w-3.5 h-3.5 text-indigo-600" /> New program</div>
                <input required value={progName} onChange={(e) => setProgName(e.target.value)} placeholder="Name *" className="border border-slate-200 rounded-lg px-2 py-1.5" />
                <input value={progCode} onChange={(e) => setProgCode(e.target.value)} placeholder="Code" className="border border-slate-200 rounded-lg px-2 py-1.5 font-mono" />
                <input value={progDesc} onChange={(e) => setProgDesc(e.target.value)} placeholder="Description" className="border border-slate-200 rounded-lg px-2 py-1.5" />
                <button type="submit" disabled={busy} className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-bold disabled:opacity-50 flex items-center justify-center gap-1">{busy && <Loader2 className="w-3 h-3 animate-spin" />} Create program</button>
              </form>

              {programs.length === 0 ? (
                <div className="text-center py-12 bg-slate-50 border border-dashed border-slate-200 rounded-2xl">
                  <BookOpen className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                  <p className="text-sm font-bold text-slate-600">No programs yet</p>
                  <p className="text-xs text-slate-400 mt-1">Create General English, TOEFL Prep, etc.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {programs.map((p) => {
                    const open = !!expanded[p.id]; const childLevels = levelsOf(p.id);
                    return (
                      <div key={p.id} className={`bg-white border rounded-2xl overflow-hidden ${p.isActive ? 'border-slate-200' : 'opacity-70'}`}>
                        <div className="flex flex-wrap items-center gap-2 px-4 py-3 bg-gradient-to-r from-slate-50 to-white border-b border-slate-100">
                          <button type="button" className="text-slate-500 hover:text-indigo-600" onClick={() => setExpanded((prev) => ({ ...prev, [p.id]: !prev[p.id] }))}>
                            {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                          </button>
                          <div className="flex-1 min-w-0">
                            {editProgId === p.id ? (
                              <div className="flex flex-wrap gap-1.5 text-xs">
                                <input value={editProgName} onChange={(e) => setEditProgName(e.target.value)} className="border border-slate-200 rounded-lg px-2 py-1 font-bold flex-1 min-w-[180px]" placeholder="Program name" />
                                <input value={editProgCode} onChange={(e) => setEditProgCode(e.target.value)} className="border border-slate-200 rounded-lg px-2 py-1 font-mono w-24" placeholder="Code" />
                                <input value={editProgDesc} onChange={(e) => setEditProgDesc(e.target.value)} className="border border-slate-200 rounded-lg px-2 py-1 flex-1 min-w-[120px]" placeholder="Description" />
                                <button type="button" disabled={busy} className="p-1.5 rounded-lg bg-emerald-600 text-white" onClick={() => run(async () => { await api.put(`/academic/programs/${p.id}`, { name: editProgName, code: editProgCode || null, description: editProgDesc || null }); setEditProgId(null); })}><Check className="w-3.5 h-3.5" /></button>
                                <button type="button" className="p-1.5 rounded-lg bg-slate-100 text-slate-600" onClick={() => setEditProgId(null)}><X className="w-3.5 h-3.5" /></button>
                              </div>
                            ) : (
                              <><p className="font-extrabold text-slate-900 text-sm break-words">{p.name} {p.code ? <span className="font-mono text-indigo-600 text-xs">({p.code})</span> : null}</p>{p.description && <p className="text-[10px] text-slate-500 break-words leading-relaxed mt-0.5">{p.description}</p>}</>
                            )}
                          </div>
                          <span className="text-[10px] font-bold text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">{childLevels.length} level{childLevels.length === 1 ? '' : 's'}</span>
                          <ToggleActive active={p.isActive} disabled={busy} onToggle={() => run(async () => { await api.put(`/academic/programs/${p.id}`, { isActive: !p.isActive }); })} />
                          {editProgId !== p.id && <button type="button" className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100" onClick={() => { setEditProgId(p.id); setEditProgName(p.name); setEditProgCode(p.code || ''); setEditProgDesc(p.description || ''); }}><Pencil className="w-3.5 h-3.5" /></button>}
                          <button type="button" className="p-1.5 rounded-lg text-rose-500 hover:bg-rose-50" disabled={busy} onClick={() => { if (!window.confirm(`Remove or deactivate program "${p.name}"?`)) return; run(async () => { await api.delete(`/academic/programs/${p.id}`); }); }}><Trash2 className="w-3.5 h-3.5" /></button>
                        </div>

                        {open && (
                          <div className="p-3 space-y-2 bg-slate-50/50">
                            {childLevels.length === 0 && <p className="text-[11px] text-slate-400 italic px-1">No levels yet.</p>}
                            {childLevels.map((l) => (
                              <div key={l.id} className={`bg-white border rounded-xl px-3 py-2.5 text-xs ${l.isActive ? 'border-slate-150' : 'opacity-60'}`}>
                                {editLvlId === l.id ? (
                                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                                    <input value={editLvl.name} onChange={(e) => setEditLvl({ ...editLvl, name: e.target.value })} className="border border-slate-200 rounded-lg px-2 py-1" placeholder="Name" />
                                    <input value={editLvl.code} onChange={(e) => setEditLvl({ ...editLvl, code: e.target.value })} className="border border-slate-200 rounded-lg px-2 py-1 font-mono" placeholder="Code" />
                                    <input type="number" value={editLvl.order} onChange={(e) => setEditLvl({ ...editLvl, order: Number(e.target.value) })} className="border border-slate-200 rounded-lg px-2 py-1" placeholder="Order" />
                                    <input type="number" value={editLvl.durationMonths} onChange={(e) => setEditLvl({ ...editLvl, durationMonths: Number(e.target.value) })} className="border border-slate-200 rounded-lg px-2 py-1" placeholder="Months" />
                                    <input type="number" value={editLvl.defaultFee} onChange={(e) => setEditLvl({ ...editLvl, defaultFee: Number(e.target.value) })} className="border border-slate-200 rounded-lg px-2 py-1" placeholder="Default fee" />
                                    <input type="number" value={editLvl.passMark} onChange={(e) => setEditLvl({ ...editLvl, passMark: Number(e.target.value) })} className="border border-slate-200 rounded-lg px-2 py-1" placeholder="Pass %" />
                                    <input type="number" value={(editLvl as any).minViableSize ?? 5} onChange={(e) => setEditLvl({ ...editLvl, minViableSize: Number(e.target.value) } as any)} className="border border-slate-200 rounded-lg px-2 py-1" placeholder="Min size" />
                                    <div className="col-span-2 sm:col-span-3 flex gap-1.5">
                                      <button type="button" disabled={busy} className="px-2 py-1 rounded-lg bg-emerald-600 text-white font-bold flex items-center gap-1" onClick={() => run(async () => { await api.put(`/academic/levels/${l.id}`, editLvl); setEditLvlId(null); })}><Check className="w-3 h-3" /> Save</button>
                                      <button type="button" className="px-2 py-1 rounded-lg bg-slate-100" onClick={() => setEditLvlId(null)}>Cancel</button>
                                    </div>
                                  </div>
                                ) : (
                                  <div className="flex flex-wrap items-center gap-2">
                                    <div className="flex-1 min-w-[220px]">
                                      <p className="font-bold text-slate-900 break-words"><span className="text-slate-400 mr-1">{l.order}.</span>{l.name} {l.code ? <span className="font-mono text-indigo-600">({l.code})</span> : null}</p>
                                      <p className="text-[10px] text-slate-500 mt-0.5 break-words leading-relaxed">{l.durationMonths} mo · catalog {formatAFN(l.defaultFee)} · pass {l.passMark}% · min class {(l as any).minViableSize ?? 5}</p>
                                    </div>
                                    <div className="flex items-center gap-1.5 bg-emerald-50/80 border border-emerald-100 rounded-lg px-2 py-1">
                                      <Building2 className="w-3 h-3 text-emerald-600" />
                                      <span className="text-[10px] text-emerald-800 font-bold">Branch fee</span>
                                      <input aria-label="Branch fee override" type="number" className="w-28 border border-emerald-200 rounded px-2 py-0.5 text-[11px] font-mono" value={feeFor(l.id, l.defaultFee)} onChange={(e) => setFeeDraft((d) => ({ ...d, [l.id]: Number(e.target.value) }))} />
                                      <button title="Save branch-specific fee override" type="button" disabled={busy} className="text-[10px] font-bold text-emerald-700 hover:underline" onClick={() => run(async () => { await api.put('/academic/level-fees', { levelId: l.id, fee: feeFor(l.id, l.defaultFee) }); })}>Save</button>
                                    </div>
                                    <ToggleActive active={l.isActive} disabled={busy} onToggle={() => run(async () => { await api.put(`/academic/levels/${l.id}`, { isActive: !l.isActive }); })} />
                                    <button type="button" className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100" onClick={() => { setEditLvlId(l.id); setEditLvl({ name: l.name, code: l.code || '', order: l.order, durationMonths: l.durationMonths, defaultFee: l.defaultFee, passMark: l.passMark, minViableSize: (l as any).minViableSize ?? 5 }); }}><Pencil className="w-3.5 h-3.5" /></button>
                                    <button type="button" className="p-1.5 rounded-lg text-rose-500 hover:bg-rose-50" disabled={busy} onClick={() => { if (!window.confirm(`Remove level "${l.name}"?`)) return; run(async () => { await api.delete(`/academic/levels/${l.id}`); }); }}><Trash2 className="w-3.5 h-3.5" /></button>
                                  </div>
                                )}
                              </div>
                            ))}
                            {levelFormProgramId === p.id ? (
                              <form className="bg-indigo-50/50 border border-indigo-100 rounded-xl p-3 grid grid-cols-2 sm:grid-cols-3 gap-1.5 text-xs"
                                onSubmit={(e) => { e.preventDefault(); run(async () => { await api.post('/academic/levels', { programId: p.id, name: lvlName, code: lvlCode || undefined, order: lvlOrder, durationMonths: lvlMonths, defaultFee: lvlFee, passMark: lvlPass, minViableSize: lvlMinViable }); setLvlName(''); setLvlCode(''); setLevelFormProgramId(null); }); }}>
                                <input required value={lvlName} onChange={(e) => setLvlName(e.target.value)} placeholder="Level name *" className="border border-slate-200 rounded-lg px-2 py-1.5 bg-white" />
                                <input value={lvlCode} onChange={(e) => setLvlCode(e.target.value)} placeholder="Code" className="border border-slate-200 rounded-lg px-2 py-1.5 bg-white font-mono" />
                                <input type="number" value={lvlOrder} onChange={(e) => setLvlOrder(Number(e.target.value))} className="border border-slate-200 rounded-lg px-2 py-1.5 bg-white" title="Order" />
                                <input type="number" value={lvlMonths} onChange={(e) => setLvlMonths(Number(e.target.value))} className="border border-slate-200 rounded-lg px-2 py-1.5 bg-white" title="Months" />
                                <input type="number" value={lvlFee} onChange={(e) => setLvlFee(Number(e.target.value))} className="border border-slate-200 rounded-lg px-2 py-1.5 bg-white" title="Default fee" />
                                <input type="number" value={lvlPass} onChange={(e) => setLvlPass(Number(e.target.value))} className="border border-slate-200 rounded-lg px-2 py-1.5 bg-white" title="Pass mark" />
                                <input type="number" value={lvlMinViable} onChange={(e) => setLvlMinViable(Number(e.target.value))} className="border border-slate-200 rounded-lg px-2 py-1.5 bg-white" title="Min viable class size" placeholder="Min capacity" />
                                <div className="col-span-2 sm:col-span-3 flex gap-1.5">
                                  <button type="submit" disabled={busy} className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-bold disabled:opacity-50 flex items-center gap-1">{busy && <Loader2 className="w-3 h-3 animate-spin" />} Save level</button>
                                  <button type="button" className="px-3 py-1.5 rounded-lg bg-white border border-slate-200" onClick={() => setLevelFormProgramId(null)}>Cancel</button>
                                </div>
                              </form>
                            ) : (
                              <button type="button" className="text-[11px] font-bold text-indigo-600 flex items-center gap-1 hover:underline px-1" onClick={() => { setLevelFormProgramId(p.id); setLvlOrder(childLevels.length + 1); }}><Plus className="w-3.5 h-3.5" /> Add level under {p.name}</button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* These three panels each load their own data on mount. Rendering
              them with `tab === x && <Panel/>` UNMOUNTED them on every tab
              switch, so returning to a tab refetched everything from scratch —
              the flash and reload the operators reported. Keeping them mounted
              once visited preserves their state and their fetched data, so a
              return visit costs zero requests. They are still not mounted until
              first opened, so the initial page load is unchanged. */}
          <div hidden={tab !== 'versions'}>{visited.versions && <ProgramVersionsPanel />}</div>
          <div hidden={tab !== 'offerings'}>{visited.offerings && <OfferingsPanel branchId={branchId} onChange={() => setOfferingCount((count) => count + 1)} />}</div>
          <div hidden={tab !== 'generate'}>{visited.generate && <ClassGenerationWizard branchId={branchId} />}</div>

        </div>
      </div>
    </div>
  );
}