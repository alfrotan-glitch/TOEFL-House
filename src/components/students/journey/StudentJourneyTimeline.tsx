/**
 * Student Journey Timeline — lifecycle facts projected from the append-only event store.
 * Redesigned for a premium UI/UX experience with visual cues and chips.
 */
import React, { useEffect, useState , useCallback} from 'react';
import {Route, Wallet, Loader2, RefreshCw, UserPlus, CreditCard, GraduationCap, BookOpen, AlertCircle, CheckCircle2, ArrowRightCircle, XCircle, PauseCircle, PlayCircle} from 'lucide-react';
import {api} from '../../../api/client';
import {formatAFN} from '../../../utils/format';
import { formatJalaliDateTime } from '../../../utils/jalali';

export interface JourneyTimelineItem {
  id: string;
  eventType: string;
  label: string;
  occurredAt: string;
  branchId: string | null;
  enrollmentId: string | null;
  payload: Record<string, unknown>;
  actorName: string | null;
}

export interface JourneyState {
  studentId: string;
  lifecycleStatus: string;
  currentProgram: string | null;
  currentLevel: string | null;
  currentSemester: string | null;
  currentClassId: string | null;
  currentEnrollmentId: string | null;
  enrollmentType: string | null;
  skillsFocus: string[] | null;
  placement: {
    overall: number | null;
    recommendedLevel: string | null;
    passed: boolean | null;
  };
  finance: {
    invoicedTotal: number;
    paidTotal: number;
    remaining: number;
    lastPaymentAt: string | null;
  };
  idCard: { issued: boolean; lastIssuedAt: string | null; reprints: number };
  eventCount: number;
}

interface Props {
  studentId: string;
}

// Helper to map event types to icons and colors
function getEventVisuals(eventType: string): { Icon: React.ElementType, color: string, bg: string } {
  switch (eventType) {
    case 'STUDENT_REGISTERED': return { Icon: UserPlus, color: 'text-indigo-600', bg: 'bg-indigo-50' };
    case 'PAYMENT_RECORDED': return { Icon: CreditCard, color: 'text-emerald-600', bg: 'bg-emerald-50' };
    case 'INVOICE_ISSUED': return { Icon: Wallet, color: 'text-amber-600', bg: 'bg-amber-50' };
    case 'STUDENT_ENROLLED': return { Icon: ArrowRightCircle, color: 'text-sky-600', bg: 'bg-sky-50' };
    case 'ID_CARD_ISSUED': return { Icon: BookOpen, color: 'text-purple-600', bg: 'bg-purple-50' };
    case 'GRADUATED': return { Icon: GraduationCap, color: 'text-rose-600', bg: 'bg-rose-50' };
    case 'PLACEMENT_PASSED': return { Icon: CheckCircle2, color: 'text-emerald-600', bg: 'bg-emerald-50' };
    case 'PLACEMENT_FAILED': return { Icon: XCircle, color: 'text-rose-600', bg: 'bg-rose-50' };
    case 'STATUS_CHANGED': return { Icon: AlertCircle, color: 'text-slate-600', bg: 'bg-slate-100' };
    case 'ENROLLMENT_SUSPENDED': return { Icon: PauseCircle, color: 'text-amber-600', bg: 'bg-amber-50' };
    case 'ENROLLMENT_RESUMED': return { Icon: PlayCircle, color: 'text-emerald-600', bg: 'bg-emerald-50' };
    default: return { Icon: Route, color: 'text-slate-500', bg: 'bg-slate-100' };
  }
}

// Helper to extract payload data into visual chips
function payloadChips(item: JourneyTimelineItem): Array<{ label: string, value: string, type?: 'amount' | 'status' }> {
  const p = item.payload || {};
  const chips: Array<{ label: string, value: string, type?: 'amount' | 'status' }> = [];
  
  if (p.amount != null) chips.push({ label: 'Amount', value: formatAFN(Number(p.amount)), type: 'amount' });
  if (p.category) chips.push({ label: 'Category', value: String(p.category) });
  if (p.label) chips.push({ label: 'Label', value: String(p.label) });
  if (p.classId) chips.push({ label: 'Class', value: String(p.classId) });
  if (p.levelCode) chips.push({ label: 'Level', value: String(p.levelCode) });
  if (p.semesterName) chips.push({ label: 'Semester', value: String(p.semesterName) });
  if (p.enrollmentType) chips.push({ label: 'Type', value: String(p.enrollmentType) });
  if (p.status) chips.push({ label: 'Status', value: String(p.status), type: 'status' });
  if (Array.isArray(p.skillsFocus) && p.skillsFocus.length) chips.push({ label: 'Skills', value: p.skillsFocus.join(', ') });
  
  return chips;
}

export default function StudentJourneyTimeline({ studentId }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<JourneyState | null>(null);
  const [lifecycle, setLifecycle] = useState<JourneyTimelineItem[]>([]);
  const [finance, setFinance] = useState<JourneyTimelineItem[]>([]);
  const [tab, setTab] = useState<'lifecycle' | 'finance'>('lifecycle');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<{
        state: JourneyState;
        timeline: JourneyTimelineItem[];
        financialTimeline: JourneyTimelineItem[];
      }>(`/students/${studentId}/journey`);
      setState(data.state);
      setLifecycle(data.timeline || []);
      setFinance(data.financialTimeline || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load journey');
    } finally {
      setLoading(false);
    }
  }, [studentId]);

  useEffect(() => {
    void (async () => { await load(); })();
  }, [load]);

  const timeline = tab === 'finance' ? finance : lifecycle;

  if (loading) {
    return (
      <div className="flex flex-col items-center gap-2 text-xs text-slate-500 py-8 justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-indigo-500" />
        Loading student journey…
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-xl p-3 flex items-center gap-2">
        <AlertCircle className="w-4 h-4" />
        {error}
        <button type="button" onClick={load} className="ml-auto font-bold underline">Retry</button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 pb-2">
        <h4 className="text-xs font-extrabold text-slate-900 flex items-center gap-1.5">
          <Route className="w-4 h-4 text-indigo-600" />
          Student Journey Timeline
        </h4>
        <button type="button" onClick={load} className="text-[10px] font-bold text-slate-500 hover:text-indigo-600 flex items-center gap-1 bg-slate-100 px-2 py-1 rounded-lg cursor-pointer">
          <RefreshCw className="w-3 h-3" /> Refresh
        </button>
      </div>

      {/* Stats Grid */}
      {state && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[10px]">
          <div className="bg-indigo-50/50 border border-indigo-100 rounded-xl p-2">
            <p className="text-indigo-500 font-bold uppercase tracking-wide">Status</p>
            <p className="font-extrabold text-indigo-900 capitalize mt-0.5">{state.lifecycleStatus}</p>
          </div>
          <div className="bg-slate-50 border border-slate-100 rounded-xl p-2">
            <p className="text-slate-400 font-bold uppercase tracking-wide">Level</p>
            <p className="font-extrabold text-slate-900 mt-0.5">{state.currentLevel || '—'}</p>
          </div>
          <div className="bg-slate-50 border border-slate-100 rounded-xl p-2">
            <p className="text-slate-400 font-bold uppercase tracking-wide">Program</p>
            <p className="font-extrabold text-slate-900 mt-0.5 truncate">{state.currentProgram || '—'}</p>
          </div>
          <div className={`border rounded-xl p-2 ${state.finance.remaining > 0 ? 'bg-rose-50/50 border-rose-100' : 'bg-emerald-50/50 border-emerald-100'}`}>
            <p className={`font-bold uppercase tracking-wide ${state.finance.remaining > 0 ? 'text-rose-500' : 'text-emerald-500'}`}>Balance Due</p>
            <p className={`font-extrabold mt-0.5 font-mono ${state.finance.remaining > 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{formatAFN(state.finance.remaining)}</p>
          </div>
        </div>
      )}

      {/* Secondary Stats */}
      {state && (
        <div className="text-[10px] text-slate-500 flex flex-wrap gap-2 bg-slate-50 p-2 rounded-lg border border-slate-100">
          <span className="font-bold flex items-center gap-1"><Route className="w-3 h-3" /> {state.eventCount} Events</span>
          <span className="font-bold flex items-center gap-1"><Wallet className="w-3 h-3" /> Paid: {formatAFN(state.finance.paidTotal)}</span>
          <span className="font-bold flex items-center gap-1"><CreditCard className="w-3 h-3" /> Invoiced: {formatAFN(state.finance.invoicedTotal)}</span>
          <span className="font-bold flex items-center gap-1"><BookOpen className="w-3 h-3" /> ID: {state.idCard.issued ? 'Issued' : 'Not Issued'}</span>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 bg-slate-100 p-1 rounded-xl border border-slate-200 w-full max-w-xs mx-auto">
        <button
          type="button"
          onClick={() => setTab('lifecycle')}
          className={`flex-1 text-[10px] font-bold px-2 py-1.5 rounded-lg transition-all cursor-pointer ${tab === 'lifecycle' ? 'bg-white text-indigo-600 shadow-xs' : 'text-slate-500'}`}
        >
          Academic Timeline
        </button>
        <button
          type="button"
          onClick={() => setTab('finance')}
          className={`flex-1 text-[10px] font-bold px-2 py-1.5 rounded-lg transition-all cursor-pointer flex items-center justify-center gap-1 ${tab === 'finance' ? 'bg-white text-emerald-600 shadow-xs' : 'text-slate-500'}`}
        >
          <Wallet className="w-3 h-3" /> Financial
        </button>
      </div>

      {/* Timeline List */}
      {timeline.length === 0 ? (
        <div className="text-center py-6 bg-slate-50 rounded-xl border border-dashed border-slate-200">
          <Route className="w-8 h-8 text-slate-300 mx-auto mb-2" />
          <p className="text-xs text-slate-400 italic">No journey events yet.</p>
        </div>
      ) : (
        <ol className="relative border-s-2 border-slate-100 ms-3 space-y-0 max-h-96 overflow-y-auto pr-2 py-2">
          {timeline.map((item) => {
            const { Icon, color, bg } = getEventVisuals(item.eventType);
            const chips = payloadChips(item);
            const dateStr = item.occurredAt ? formatJalaliDateTime(item.occurredAt) : 'Unknown date';

            return (
              <li key={item.id} className="mb-6 ms-6">
                {/* Icon Dot */}
                <span className={`absolute -start-4 mt-0.5 flex h-7 w-7 items-center justify-center rounded-full ring-4 ring-white ${bg} ${color}`}>
                  <Icon className="w-3.5 h-3.5" />
                </span>
                
                {/* Content Card */}
                <div className="bg-white border border-slate-200 rounded-xl p-3 shadow-xs hover:shadow-sm transition-shadow">
                  <div className="flex justify-between items-start gap-2">
                    <p className="text-xs font-extrabold text-slate-900">{item.label}</p>
                    <time className="text-[9px] font-mono text-slate-400 shrink-0">{dateStr}</time>
                  </div>
                  
                  {/* Payload Chips */}
                  {chips.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {chips.map((chip, idx) => (
                        <span key={idx} className={`text-[9px] px-1.5 py-0.5 rounded-md font-bold ${
                          chip.type === 'amount' ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' :
                          chip.type === 'status' ? 'bg-indigo-50 text-indigo-700 border border-indigo-100' :
                          'bg-slate-50 text-slate-600 border border-slate-100'
                        }`}>
                          {chip.label}: <span className="font-mono">{chip.value}</span>
                        </span>
                      ))}
                    </div>
                  )}
                  
                  {item.actorName && (
                    <p className="text-[9px] text-slate-400 mt-2 border-t border-slate-100 pt-1.5">Action by: <span className="font-bold text-slate-500">{item.actorName}</span></p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}