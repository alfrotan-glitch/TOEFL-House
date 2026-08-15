import React, { useMemo } from 'react';
import { AlertCircle, ArrowRight, CalendarClock, ClipboardCheck, CreditCard, GraduationCap } from 'lucide-react';
import type { Class, Invoice, Visitor, Student } from '../../types';

type QueueItem = {
  id: string;
  title: string;
  detail: string;
  priority: 'critical' | 'high' | 'normal';
  tab: string;
  icon: React.ElementType;
};

interface Props {
  visitors: Visitor[];
  invoices: Invoice[];
  classes: Class[];
  students: Student[];
  onNavigate?: (tab: string) => void;
}

function isoToday() { return new Date().toISOString().slice(0, 10); }

export default function OperationsWorkQueue({ visitors, invoices, classes, students, onNavigate }: Props) {
  const items = useMemo<QueueItem[]>(() => {
    const today = isoToday();
    const next: QueueItem[] = [];
    for (const v of visitors) {
      if (v.status === 'registered' || v.stage === 'lost') continue;
      if (v.nextContactDate && v.nextContactDate <= today) {
        next.push({ id: `fu-${v.id}`, title: `Follow up ${v.fullName}`, detail: v.nextContactDate < today ? `Overdue since ${v.nextContactDate}` : 'Due today', priority: v.nextContactDate < today ? 'high' : 'normal', tab: 'visitors', icon: CalendarClock });
      }
      if (v.placementStatus === 'in_progress') next.push({ id: `pl-${v.id}`, title: `Finish placement for ${v.fullName}`, detail: 'An assessment is currently in progress', priority: 'high', tab: 'visitors', icon: ClipboardCheck });
    }
    for (const invoice of invoices) {
      if (invoice.status === 'overdue') next.push({ id: `inv-${invoice.id}`, title: `Collect ${invoice.invoiceNumber || invoice.id}`, detail: `${invoice.studentName || 'Student'} · ${invoice.netAmount.toLocaleString()} AFN`, priority: 'critical', tab: 'finance', icon: CreditCard });
    }
    for (const c of classes) {
      if (c.status === 'active' && c.startDate && c.startDate >= today && c.lifecycleStage !== 'in_progress') {
        next.push({ id: `class-${c.id}`, title: `Prepare ${c.name}`, detail: `Starts ${c.startDate}`, priority: 'normal', tab: 'classes', icon: GraduationCap });
      }
    }
    const suspended = students.filter(s => s.status === 'suspended').slice(0, 3);
    for (const s of suspended) next.push({ id: `std-${s.id}`, title: `Review ${s.fullName}`, detail: 'Student is suspended', priority: 'high', tab: 'students', icon: AlertCircle });
    const rank = { critical: 0, high: 1, normal: 2 } as const;
    return next.sort((a, b) => rank[a.priority] - rank[b.priority]).slice(0, 10);
  }, [visitors, invoices, classes, students]);

  return (
    <section className="rounded-3xl bg-white/80 backdrop-blur-xl border border-slate-200/70 shadow-sm p-5 lg:p-6">
      <div className="flex items-center justify-between gap-4 mb-4">
        <div>
          <p className="text-[10px] font-black tracking-[0.18em] uppercase text-indigo-600">Daily work queue</p>
          <h3 className="mt-1 text-lg font-black text-slate-900">What needs attention next?</h3>
        </div>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-black text-slate-600">{items.length} actions</span>
      </div>
      {items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 p-6 text-center">
          <p className="text-sm font-bold text-slate-700">Everything is under control.</p>
          <p className="mt-1 text-xs text-slate-500">No overdue follow-ups, invoices, or operational blockers were detected.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-2">
          {items.map(item => {
            const Icon = item.icon;
            return (
              <button key={item.id} onClick={() => onNavigate?.(item.tab)} className="flex items-center gap-3 rounded-2xl border border-slate-200/70 bg-white px-3.5 py-3 text-left hover:border-indigo-200 hover:bg-indigo-50/40 transition-colors">
                <span className="h-9 w-9 rounded-xl bg-slate-100 flex items-center justify-center shrink-0"><Icon className="w-4 h-4 text-slate-600" /></span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-extrabold text-slate-900 truncate">{item.title}</span>
                  <span className="block mt-0.5 text-[11px] text-slate-500 truncate">{item.detail}</span>
                </span>
                <span className={item.priority === 'critical' ? 'text-rose-500' : item.priority === 'high' ? 'text-amber-500' : 'text-slate-300'}><ArrowRight className="w-4 h-4" /></span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
