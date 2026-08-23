import React, { useMemo, useState, useEffect } from 'react';
import { formatJalaliAxis, formatJalali, toPersianDigits } from '../../utils/jalali';
import {TrendingUp, TrendingDown, Users, Wallet, PiggyBank, Eye, EyeOff, UserCheck, Clock, Zap, AlertTriangle, BookOpen, Activity, GraduationCap, Loader2, CheckCircle2, CalendarDays, BarChart3, Sparkles} from 'lucide-react';
import {AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, Legend, RadialBarChart, RadialBar} from 'recharts';
import { AuditLog, BudgetLine, Class, DashboardSummary, FinanceDashboard, Invoice, Student, UserRole, Visitor } from '../../types';
import { isLeadOpen } from '../../config/leadLifecycle';
import BusinessOperatingSystemView from './BusinessOperatingSystemView';
import OperationsWorkQueue from './OperationsWorkQueue';
import {useAuth} from '../../contexts/useAuth';
import {formatAFN} from '../../utils/format';
import { BRAND_NAME } from '../../config/branding';

interface DashboardViewProps {
  /** Server-computed period totals. The authoritative source for money tiles. */
  financeDashboard: FinanceDashboard | null;
  /**
   * Server-computed KPIs — the authoritative source for EVERY population
   * metric and for the cash-flow series. Counting the entity arrays below
   * instead produced audit findings D-1..D-5: those arrays are paginated
   * (visitors are hard-capped at 100 server-side), so client-side counts
   * silently described a page rather than the population.
   */
  dashboardSummary: DashboardSummary | null;
  students: Student[];
  invoices: Invoice[];
  classes: Class[];
  visitors: Visitor[];
  budgetLines: BudgetLine[];
  savingBalance: number;
  mainAccountBalance: number;
  auditLogs: AuditLog[];
  activeRole: UserRole;
  registerVisitorToStudent: (visitorId: string, classId: string, amountPaid: number, discountPercent: number) => Promise<any>;
  runSavingEngine: () => void;
  savingPercent: number;
  getExecutiveDashboard: (period?: string) => Promise<any>;
  getMarketingFunnel: (period?: string) => Promise<any>;
  getStudentAnalytics: (period?: string) => Promise<any>;
  getDecisionWarnings: () => Promise<any>;
  getProfitDistribution: (period?: string) => Promise<any>;
  withdrawProfitDistribution: (amount: number, recipientPartnerId?: string, notes?: string) => Promise<void>;
  revenueByClass?: { name: string; revenue: number }[];
  revenueByTimeSlot?: { slot: string; revenue: number }[];
  onNavigate?: (tab: string) => void;
}

const formatCompact = (value: number) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);

// Premium Glass Card Class
const glassCard = "relative bg-white/70 backdrop-blur-xl border border-slate-200/60 shadow-[0_8px_30px_rgb(0,0,0,0.04)] rounded-3xl overflow-hidden transition-all duration-500 ease-out hover:shadow-[0_12px_40px_rgb(0,0,0,0.08)] hover:-translate-y-0.5";

// Custom Glass Tooltip for Charts
const ChartTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-slate-800/50 bg-slate-900/90 backdrop-blur-xl px-4 py-3 text-xs text-white shadow-2xl">
      <p className="mb-2 border-b border-slate-700/50 pb-1.5 font-bold text-slate-200">{label}</p>
      {payload.map((item: any, i: number) => (
        <div key={i} className="flex items-center justify-between gap-8 py-0.5">
          <span className="flex items-center gap-2 text-slate-400">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: item.color }} />
            {item.name}
          </span>
          <span className="font-mono font-bold text-white tabular-nums">{formatAFN(item.value)}</span>
        </div>
      ))}
    </div>
  );
};

export default function DashboardView({
  students, invoices, classes, visitors, budgetLines, mainAccountBalance,
  financeDashboard, dashboardSummary,
  auditLogs, activeRole, registerVisitorToStudent, runSavingEngine, savingPercent,
  getExecutiveDashboard, getMarketingFunnel, getStudentAnalytics, getDecisionWarnings,
  getProfitDistribution, withdrawProfitDistribution, revenueByClass = [], revenueByTimeSlot = [], onNavigate
}: DashboardViewProps) {
  const { user } = useAuth();
  const canViewExecutive = !!user?.isGlobalOwner || !!user?.permissions?.has('Dashboard.Executive');

  const [mainTab, setMainTab] = useState<'overview' | 'bos' | 'analytics'>('overview');
  const [timeframe, setTimeframe] = useState<'today' | 'month' | 'year'>('month');
  const [hideBalances, setHideBalances] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [isEnrolling, setIsEnrolling] = useState(false);
  const [isRunningEngine, setIsRunningEngine] = useState(false);
  
  const [quickRegVisitorId, setQuickRegVisitorId] = useState('');
  const [quickClassId, setQuickClassId] = useState('');
  const [quickAmount, setQuickAmount] = useState(0);
  const [quickDiscount, setQuickDiscount] = useState(0);

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  useEffect(() => {
    if (!canViewExecutive && mainTab === 'bos') setMainTab('overview');
  }, [canViewExecutive, mainTab]);

  const triggerToast = (message: string, type: 'success' | 'error' | 'info') => setToast({ message, type });

  // Per-period intake comes from the server, which counts the whole population
  // in SQL over server-local date boundaries. The previous implementation
  // filtered the loaded arrays, so "New Visitors" could never exceed the
  // 100-row visitor page (audit D-1 class).
  const timeStats = useMemo(() => {
    const p = dashboardSummary?.periods?.[timeframe];
    return { visitors: p?.newVisitors ?? 0, students: p?.newStudents ?? 0 };
  }, [dashboardSummary, timeframe]);

  /**
   * The period label states the window the SERVER actually summed. "This month"
   * is the Shamsi month (اسد ۱۴۰۵), which does not share boundaries with the
   * Gregorian one — naming it removes the ambiguity that made audit finding
   * D-6 invisible to the reader.
   */
  const timeframeLabel = useMemo(() => {
    const b = dashboardSummary?.boundaries?.[timeframe];
    if (!b) return timeframe === 'today' ? 'Today' : `This ${timeframe}`;
    if (timeframe === 'today') return formatJalali(b.from, 'long');
    if (timeframe === 'month') return formatJalali(b.from, 'month-year');
    return toPersianDigits(String(b.periodKey ?? ''));
  }, [dashboardSummary, timeframe]);

  const metrics = useMemo(() => {
    // Money totals come from the server, which sums the whole period in SQL.
    // Reducing the loaded `transactions` array understated these tiles as soon
    // as a period exceeded one page (the endpoint returns 500 rows by default);
    // a 700-row day was reported 99,311 AFN short. The client array is still
    // used for the sparkline shape and for non-financial counts.
    const todayIncome = financeDashboard?.today?.income ?? 0;
    const todayExpense = financeDashboard?.today?.expense ?? 0;
    const monthIncome = financeDashboard?.month?.income ?? 0;
    const monthExpense = financeDashboard?.month?.expense ?? 0;

    // POPULATION METRICS — server-computed (SQL COUNT over the whole scoped
    // table). Counting the loaded arrays instead is audit findings D-1/D-3/D-5:
    // visitors are hard-capped at 100 rows server-side, so the conversion rate
    // reported 50% against a true 20%, and pending leads 50 against a true 200.
    // `activeStudents` had the same latent bug above 2,000 students per branch.
    const pop = dashboardSummary?.population;
    const activeStudents = pop?.activeStudents ?? 0;
    const activeClasses = pop?.activeClasses ?? 0;
    const activeTeachers = pop?.activeTeachers ?? 0;
    const totalStudents = pop?.totalStudents ?? 0;
    const conversionRate = pop?.conversionRate ?? 0;
    const pendingLeads = pop?.pendingLeads ?? 0;

    // The quick-registration dropdown still needs actual visitor RECORDS, not a
    // count. It is explicitly a "recent leads" picker over the loaded page, and
    // is labelled as such — it never claims to be the full pending population.
    //
    // It must, however, agree with the tile above it about what "pending"
    // MEANS. The old inline test (status 'visited' or 'follow_up') was the
    // allow-list the server no longer uses, so a closed-lost lead — excluded
    // from the count — was still offered here for quick registration.
    const pendingLeadsList = visitors.filter(isLeadOpen);

    // CASH FLOW — server-computed daily aggregate. This chart renders exact AFN
    // in its tooltip, so it must reconcile with the ledger. Reducing the loaded
    // `transactions` page understated a 700-row day by 39,540 AFN (45%) while
    // the KPI tile beside it showed the correct figure — audit finding D-2.
    const chartData = (dashboardSummary?.cashFlow ?? []).map((row) => ({
      name: formatJalaliAxis(row.date),
      Income: row.income,
      Expense: row.expense,
    }));

    const budgetChartData = budgetLines.filter((b) => b.allocatedAmount > 0 || b.currentAmount > 0).slice(0, 8).map((b) => ({
      name: b.name.length > 12 ? `${b.name.slice(0, 12)}…` : b.name,
      Remaining: b.currentAmount,
      Allocated: b.allocatedAmount,
    }));

    return {
      todayIncome, todayExpense, netToday: todayIncome - todayExpense,
      monthIncome, monthExpense, monthNet: monthIncome - monthExpense,
      activeStudents, activeClasses, activeTeachers, totalStudents,
      pendingLeads, conversionRate, budgetChartData,
      chartData, pendingLeadsList
    };
  }, [
    dashboardSummary, visitors, budgetLines,
    financeDashboard?.today?.income, financeDashboard?.today?.expense,
    financeDashboard?.month?.income, financeDashboard?.month?.expense,
  ]);

  const { activeClassOptions } = useMemo(() => {
    const qVisitor = visitors.find((v) => v.id === quickRegVisitorId);
    const qClasses = classes.filter((c) => {
      if (c.status !== 'active') return false;
      const pol = c.genderPolicy || 'mixed';
      if (pol === 'mixed') return true;
      if (!qVisitor?.gender) return true;
      return pol === qVisitor.gender;
    });
    return { activeClassOptions: qClasses };
  }, [visitors, classes, quickRegVisitorId]);

  const money = (n: number) => (hideBalances ? '••••••' : formatAFN(n));

  const handleQuickRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickRegVisitorId || !quickClassId) return triggerToast('Select a visitor and a target class.', 'error');
    setIsEnrolling(true);
    try {
      await registerVisitorToStudent(quickRegVisitorId, quickClassId, quickAmount, quickDiscount);
      setQuickRegVisitorId(''); setQuickClassId(''); setQuickDiscount(0); setQuickAmount(0);
      triggerToast('Visitor enrolled successfully.', 'success');
    } catch (err: any) {
      triggerToast(err?.message || 'Enrollment failed', 'error');
    } finally {
      setIsEnrolling(false);
    }
  };

  const handleRunSavings = () => {
    setIsRunningEngine(true);
    try { runSavingEngine(); triggerToast('Savings engine executed.', 'success'); } 
    catch { triggerToast('Failed to run engine.', 'error'); } 
    finally { setIsRunningEngine(false); }
  };

  return (
    <div className="relative min-h-screen p-6 lg:p-10 font-sans text-slate-800">
      {/* Ambient Background */}
      <div className="fixed inset-0 -z-10 bg-gradient-to-br from-slate-50 via-indigo-50/30 to-slate-100"></div>
      
      <div className="mx-auto max-w-[1600px] space-y-6">
        <section className="rounded-3xl bg-slate-950 text-white p-5 lg:p-6 shadow-2xl shadow-slate-900/10 overflow-hidden relative">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(99,102,241,.28),transparent_34%),radial-gradient(circle_at_bottom_left,rgba(16,185,129,.16),transparent_28%)]" />
          <div className="relative flex flex-col xl:flex-row xl:items-end xl:justify-between gap-5">
            <div>
              <div className="flex items-center gap-2 text-[10px] font-black tracking-[0.18em] uppercase text-indigo-300"><Sparkles className="w-3.5 h-3.5" /> {BRAND_NAME} Command Center</div>
              <h2 className="mt-2 text-2xl lg:text-3xl font-black tracking-tight">Run the school from one place.</h2>
              <p className="mt-2 max-w-2xl text-sm text-slate-300">Admissions, academic operations and finance are surfaced together so the next action is obvious—not buried inside modules.</p>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 min-w-0">
              {([
                { label: 'New lead', tab: 'visitors', icon: UserCheck },
                { label: 'Students', tab: 'students', icon: Users },
                { label: 'Finance', tab: 'finance', icon: Wallet },
                { label: 'Academic setup', tab: 'academic-setup', icon: GraduationCap },
              ] as const).map(({ label, tab, icon: Icon }) => (
                <button key={tab} type="button" onClick={() => onNavigate?.(tab)} className="group rounded-2xl border border-white/10 bg-white/[0.07] hover:bg-white/[0.13] px-3 py-3 text-start transition-colors">
                  <Icon className="w-4 h-4 text-indigo-300 group-hover:text-white" />
                  <span className="mt-2 block text-[11px] font-extrabold">{label}</span>
                </button>
              ))}
            </div>
          </div>
        </section>
        
        <OperationsWorkQueue visitors={visitors} invoices={invoices} classes={classes} students={students} serverToday={dashboardSummary?.today} onNavigate={onNavigate} />
        
        {/* Premium Header */}
        <header className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight bg-gradient-to-r from-slate-900 to-slate-500 bg-clip-text text-transparent">
              Operations Dashboard
            </h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-slate-500 font-medium">
              <span className="flex items-center gap-2">
                <CalendarDays className="w-4 h-4 text-slate-400" />
                {formatJalali(new Date().toLocaleDateString('en-CA'), 'long')}
              </span>
              <span className="rounded-full border border-slate-200 bg-white/70 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.12em] text-slate-500">
                {String(activeRole).replace(/_/g, ' ')}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button 
              onClick={() => setHideBalances(!hideBalances)} 
              className="p-3 rounded-xl bg-white/70 backdrop-blur-md border border-slate-200/60 shadow-sm text-slate-600 hover:bg-white hover:text-slate-900 transition-all"
              title={hideBalances ? "Show balances" : "Hide balances"}
            >
              {hideBalances ? <Eye className="w-4 h-4" strokeWidth={2.5} /> : <EyeOff className="w-4 h-4" strokeWidth={2.5} />}
            </button>
            
            {/* Premium Tab Switcher */}
            <div className="inline-flex p-1 bg-slate-200/60 backdrop-blur-md border border-slate-300/50 rounded-xl shadow-sm">
              {[
                { id: 'overview', label: 'Overview', icon: Activity },
                { id: 'analytics', label: 'Analytics', icon: BarChart3 },
                ...(canViewExecutive ? [{ id: 'bos', label: 'Business OS', icon: Zap }] : []),
              ].map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setMainTab(tab.id as 'overview' | 'analytics' | 'bos')}
                  className={`flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-bold transition-all duration-300 ${
                    mainTab === tab.id ? 'bg-white text-indigo-600 shadow-sm scale-105' : 'text-slate-500 hover:text-slate-900'
                  }`}
                >
                  <tab.icon className="w-4 h-4" strokeWidth={2.5} />
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
        </header>

        {mainTab === 'bos' && canViewExecutive ? (
          <BusinessOperatingSystemView
            getExecutiveDashboard={getExecutiveDashboard} getMarketingFunnel={getMarketingFunnel}
            getStudentAnalytics={getStudentAnalytics} getDecisionWarnings={getDecisionWarnings}
            getProfitDistribution={getProfitDistribution} withdrawProfitDistribution={withdrawProfitDistribution}
            isOwner={!!user?.isGlobalOwner} triggerToast={triggerToast}
            revenueByClass={revenueByClass} revenueByTimeSlot={revenueByTimeSlot}
          />
        ) : mainTab === 'analytics' ? (
          <div className="space-y-6 animate-in fade-in duration-500">
             {/* Time-based Analytics Section */}
            <div className={`${glassCard} p-8`}>
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-8 gap-4">
                <div>
                  <h2 className="text-xl font-extrabold text-slate-900 tracking-tight">Growth Metrics</h2>
                  <p className="text-sm text-slate-500 font-medium mt-1">Registrations and visitors tracking</p>
                </div>
                {/* Premium Timeframe Switcher */}
                <div className="inline-flex p-1 bg-slate-200/60 backdrop-blur-md border border-slate-300/50 rounded-xl shadow-sm">
                  {[
                    { id: 'today', label: 'Today' },
                    { id: 'month', label: 'This Month' },
                    { id: 'year', label: 'This Year' },
                  ].map((tf) => (
                    <button
                      key={tf.id}
                      onClick={() => setTimeframe(tf.id as any)}
                      className={`rounded-lg px-5 py-2 text-xs font-bold transition-all duration-300 ${
                        timeframe === tf.id ? 'bg-white text-indigo-600 shadow-sm scale-105' : 'text-slate-500 hover:text-slate-800'
                      }`}
                    >
                      {tf.label}
                    </button>
                  ))}
                </div>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="bg-gradient-to-br from-indigo-500/10 to-transparent p-6 rounded-2xl border border-indigo-500/20">
                  <div className="flex justify-between items-center mb-4">
                    <p className="text-[11px] font-bold text-indigo-700 uppercase tracking-widest">New Visitors</p>
                    <div className="p-2 bg-indigo-500/10 rounded-lg">
                      <Users className="w-4 h-4 text-indigo-600" strokeWidth={2.5} />
                    </div>
                  </div>
                  <p className="text-5xl font-black text-slate-900 tracking-tight tabular-nums">{timeStats.visitors}</p>
                  <p className="text-xs text-slate-500 mt-2 font-medium">{timeframeLabel}</p>
                </div>
                <div className="bg-gradient-to-br from-emerald-500/10 to-transparent p-6 rounded-2xl border border-emerald-500/20">
                  <div className="flex justify-between items-center mb-4">
                    <p className="text-[11px] font-bold text-emerald-700 uppercase tracking-widest">New Students</p>
                    <div className="p-2 bg-emerald-500/10 rounded-lg">
                      <GraduationCap className="w-4 h-4 text-emerald-600" strokeWidth={2.5} />
                    </div>
                  </div>
                  <p className="text-5xl font-black text-slate-900 tracking-tight tabular-nums">{timeStats.students}</p>
                  <p className="text-xs text-slate-500 mt-2 font-medium">{timeframeLabel}</p>
                </div>
              </div>
            </div>

            {/* Profitability Analytics */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className={`${glassCard} p-8`}>
                <h3 className="text-lg font-extrabold text-slate-900 mb-6 flex items-center gap-3 tracking-tight">
                  <div className="p-2 bg-amber-500/10 rounded-lg">
                    <Sparkles className="w-5 h-5 text-amber-600" strokeWidth={2.5} />
                  </div>
                  Top Performing Classes
                </h3>
                {revenueByClass.length === 0 ? (
                  <div className="text-center py-12">
                    <BookOpen className="w-10 h-10 text-slate-300 mx-auto mb-3" strokeWidth={1.5} />
                    <p className="text-slate-400 text-sm">No revenue data linked to classes yet.</p>
                  </div>
                ) : (
                  <div className="space-y-5">
                    {revenueByClass.slice(0, 5).map((c, i) => (
                      <div key={i} className="flex items-center gap-4 group">
                        <div className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center text-slate-500 font-bold text-xs group-hover:bg-indigo-100 group-hover:text-indigo-600 transition-colors">
                          {i + 1}
                        </div>
                        <div className="flex-1">
                          <p className="font-bold text-slate-800 text-sm mb-1.5">{c.name}</p>
                          <div className="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
                            <div className="bg-gradient-to-r from-indigo-500 to-violet-500 h-1.5 rounded-full transition-all duration-700 ease-out" style={{ width: `${revenueByClass[0].revenue > 0 ? (c.revenue / revenueByClass[0].revenue) * 100 : 0}%` }} />
                          </div>
                        </div>
                        <p className="font-mono font-bold text-slate-900 text-sm tabular-nums">{formatAFN(c.revenue)}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className={`${glassCard} p-8`}>
                <h3 className="text-lg font-extrabold text-slate-900 mb-6 flex items-center gap-3 tracking-tight">
                  <div className="p-2 bg-sky-500/10 rounded-lg">
                    <Clock className="w-5 h-5 text-sky-600" strokeWidth={2.5} />
                  </div>
                  Revenue by Time Slot
                </h3>
                {revenueByTimeSlot.length === 0 ? (
                  <div className="text-center py-12">
                    <Clock className="w-10 h-10 text-slate-300 mx-auto mb-3" strokeWidth={1.5} />
                    <p className="text-slate-400 text-sm">No time slot revenue data available.</p>
                  </div>
                ) : (
                  <div className="h-72 mt-4">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={revenueByTimeSlot} layout="vertical" margin={{ left: 10, right: 10 }}>
                        <defs>
                          <linearGradient id="barGradient" x1="0" y1="0" x2="1" y2="0">
                            <stop offset="0%" stopColor="#0ea5e9" />
                            <stop offset="100%" stopColor="#3b82f6" />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                        <XAxis type="number" tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} tickFormatter={formatCompact} />
                        <YAxis type="category" dataKey="slot" tick={{ fontSize: 11, fill: '#64748b', fontWeight: 600 }} axisLine={false} tickLine={false} width={80} />
                        <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(241, 245, 249, 0.5)' }} />
                        <Bar dataKey="revenue" name="Revenue" fill="url(#barGradient)" radius={[0, 6, 6, 0]} barSize={16} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-6 animate-in fade-in duration-500">
            {/* Primary KPIs */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
              <div className={`${glassCard} p-6 group`}>
                <div className="flex justify-between items-center mb-4">
                  <div className="w-11 h-11 rounded-2xl bg-indigo-500/10 flex items-center justify-center group-hover:scale-110 transition-transform">
                    <Wallet className="w-5 h-5 text-indigo-600" strokeWidth={2.5} />
                  </div>
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Main Account</span>
                </div>
                <p className="text-3xl font-extrabold tracking-tight text-slate-900 font-mono tabular-nums">{money(mainAccountBalance)}</p>
                <p className="text-xs text-slate-500 mt-1 font-medium">Available balance</p>
              </div>

              <div className={`${glassCard} p-6 group`}>
                <div className="flex justify-between items-center mb-4">
                  <div className={`w-11 h-11 rounded-2xl flex items-center justify-center group-hover:scale-110 transition-transform ${metrics.netToday >= 0 ? 'bg-emerald-500/10' : 'bg-rose-500/10'}`}>
                    {metrics.netToday >= 0 ? <TrendingUp className="w-5 h-5 text-emerald-600" strokeWidth={2.5} /> : <TrendingDown className="w-5 h-5 text-rose-600" strokeWidth={2.5} />}
                  </div>
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Today's Net</span>
                </div>
                <p className={`text-3xl font-extrabold tracking-tight font-mono tabular-nums ${metrics.netToday >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                  {money(metrics.netToday)}
                </p>
                <p className="text-xs text-slate-500 mt-1 font-medium">In: {formatCompact(metrics.todayIncome)} · Out: {formatCompact(metrics.todayExpense)}</p>
              </div>

              <div className={`${glassCard} p-6 group`}>
                <div className="flex justify-between items-center mb-4">
                  <div className="w-11 h-11 rounded-2xl bg-violet-500/10 flex items-center justify-center group-hover:scale-110 transition-transform">
                    <Users className="w-5 h-5 text-violet-600" strokeWidth={2.5} />
                  </div>
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Active Students</span>
                </div>
                <p className="text-3xl font-extrabold tracking-tight text-slate-900 tabular-nums">{metrics.activeStudents}</p>
                <p className="text-xs text-slate-500 mt-1 font-medium">{metrics.totalStudents} total records</p>
              </div>

              <div className={`${glassCard} p-6 group`}>
                <div className="flex justify-between items-center mb-4">
                  <div className="w-11 h-11 rounded-2xl bg-amber-500/10 flex items-center justify-center group-hover:scale-110 transition-transform">
                    <UserCheck className="w-5 h-5 text-amber-600" strokeWidth={2.5} />
                  </div>
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Lead Conversion</span>
                </div>
                <p className="text-3xl font-extrabold tracking-tight text-slate-900 tabular-nums">{metrics.conversionRate}%</p>
                <p className="text-xs text-slate-500 mt-1 font-medium">{metrics.pendingLeads} pending leads</p>
              </div>
            </div>

            {/* Charts Section */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Cashflow Chart */}
              <div className={`${glassCard} lg:col-span-2 p-8`}>
                <div className="flex justify-between items-center mb-6">
                  <div>
                    <h3 className="text-lg font-extrabold text-slate-900 tracking-tight">Cash Flow Analytics</h3>
                    <p className="text-xs text-slate-500 font-medium mt-1">Last 7 days performance</p>
                  </div>
                  <div className="flex gap-4 text-xs font-medium">
                    <span className="flex items-center gap-2 text-slate-600"><span className="w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-sm shadow-emerald-500/50"></span> Income</span>
                    <span className="flex items-center gap-2 text-slate-600"><span className="w-2.5 h-2.5 rounded-full bg-rose-500 shadow-sm shadow-rose-500/50"></span> Expense</span>
                  </div>
                </div>
                <div className="h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={metrics.chartData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                      <defs>
                        <linearGradient id="gInc" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#10b981" stopOpacity={0.3} />
                          <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="gExp" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#f43f5e" stopOpacity={0.25} />
                          <stop offset="100%" stopColor="#f43f5e" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#94a3b8', fontWeight: 500 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 11, fill: '#94a3b8', fontWeight: 500 }} axisLine={false} tickLine={false} tickFormatter={formatCompact} />
                      <Tooltip content={<ChartTooltip />} cursor={{ stroke: '#cbd5e1', strokeWidth: 2, strokeDasharray: '4 4' }} />
                      <Area type="monotone" dataKey="Income" stroke="#10b981" strokeWidth={3} fill="url(#gInc)" />
                      <Area type="monotone" dataKey="Expense" stroke="#f43f5e" strokeWidth={3} fill="url(#gExp)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Budget Utilization */}
              <div className={`${glassCard} p-8`}>
                <h3 className="text-lg font-extrabold text-slate-900 tracking-tight">Budget Health</h3>
                <p className="text-xs text-slate-500 font-medium mt-1 mb-6">Top 5 allocations</p>
                {metrics.budgetChartData.length === 0 ? (
                  <div className="h-72 flex flex-col items-center justify-center text-center">
                    <Wallet className="w-10 h-10 mb-3 text-slate-200" strokeWidth={1.5} />
                    <p className="text-slate-400 text-xs font-medium">No active budgets yet.</p>
                  </div>
                ) : (
                  <div className="h-72">
                    <ResponsiveContainer width="100%" height="100%">
                      <RadialBarChart innerRadius="20%" outerRadius="100%" data={metrics.budgetChartData.slice(0, 5)} startAngle={90} endAngle={-270}>
                        <RadialBar background dataKey="Allocated" cornerRadius={10} fill="#e2e8f0" />
                        <RadialBar dataKey="Remaining" cornerRadius={10} fill="#6366f1" />
                        <Legend iconSize={10} layout="vertical" verticalAlign="middle" align="right" wrapperStyle={{ fontSize: 10, fontWeight: 600 }} />
                        <Tooltip content={<ChartTooltip />} />
                      </RadialBarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
            </div>

            {/* Quick Actions & Audit */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className={`${glassCard} p-8`}>
                <h3 className="text-lg font-extrabold text-slate-900 mb-6 flex items-center gap-3 tracking-tight">
                  <div className="p-2 bg-indigo-500/10 rounded-lg">
                    <Zap className="w-5 h-5 text-indigo-600" strokeWidth={2.5} />
                  </div>
                  Quick Actions
                </h3>
                <form onSubmit={handleQuickRegister} className="space-y-3 mb-6">
                  <select value={quickRegVisitorId} onChange={(e) => setQuickRegVisitorId(e.target.value)} className="w-full rounded-xl border border-slate-200/80 bg-white/50 backdrop-blur-sm px-4 py-3 text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none transition-all font-medium">
                    <option value="">Select a Visitor to Enroll...</option>
                    {metrics.pendingLeadsList.map((v) => <option key={v.id} value={v.id}>{v.fullName} ({v.phone || 'No Phone'})</option>)}
                  </select>
                  <select value={quickClassId} onChange={(e) => setQuickClassId(e.target.value)} className="w-full rounded-xl border border-slate-200/80 bg-white/50 backdrop-blur-sm px-4 py-3 text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none transition-all font-medium">
                    <option value="">Assign to Class...</option>
                    {activeClassOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <div className="grid grid-cols-2 gap-3">
                    <input type="number" placeholder="Amount Paid" value={quickAmount || ''} onChange={(e) => setQuickAmount(Number(e.target.value) || 0)} className="rounded-xl border border-slate-200/80 bg-white/50 backdrop-blur-sm px-4 py-3 text-sm font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none transition-all tabular-nums" />
                    <input type="number" placeholder="Discount %" value={quickDiscount || ''} onChange={(e) => setQuickDiscount(Number(e.target.value) || 0)} className="rounded-xl border border-slate-200/80 bg-white/50 backdrop-blur-sm px-4 py-3 text-sm font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none transition-all tabular-nums" />
                  </div>
                  <button type="submit" disabled={isEnrolling} className="w-full bg-gradient-to-r from-indigo-600 to-violet-600 text-white font-bold py-3 rounded-xl shadow-md hover:shadow-lg hover:from-indigo-700 hover:to-violet-700 transition-all flex items-center justify-center gap-2 disabled:opacity-50">
                    {isEnrolling ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                    {isEnrolling ? 'Processing...' : 'Confirm Enrollment'}
                  </button>
                </form>
                <div className="border-t border-slate-200/50 pt-6">
                  <p className="text-xs text-slate-600 mb-3 font-medium">Automatically transfer {savingPercent}% of income to savings reserve.</p>
                  <button onClick={handleRunSavings} disabled={isRunningEngine} className="w-full bg-emerald-50 text-emerald-700 font-bold py-3 rounded-xl hover:bg-emerald-100 transition-colors flex items-center justify-center gap-2 border border-emerald-200/50">
                    {isRunningEngine ? <Loader2 className="w-4 h-4 animate-spin" /> : <PiggyBank className="w-4 h-4" />}
                    Run Savings Engine
                  </button>
                </div>
              </div>

              <div className={`${glassCard} p-8`}>
                <h3 className="text-lg font-extrabold text-slate-900 mb-6 flex items-center gap-3 tracking-tight">
                  <div className="p-2 bg-slate-500/10 rounded-lg">
                    <Activity className="w-5 h-5 text-slate-600" strokeWidth={2.5} />
                  </div>
                  Recent System Activity
                </h3>
                <div className="space-y-4 max-h-[400px] overflow-y-auto pe-2 custom-scrollbar">
                  {auditLogs.length === 0 ? <p className="text-slate-400 text-center py-8 text-sm font-medium">No recent activity logged.</p> :
                    auditLogs.slice(0, 10).map((log) => (
                      <div key={log.id} className="flex items-start gap-4 pb-4 border-b border-slate-100/80 last:border-0">
                        <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center text-slate-500 text-xs font-bold border border-slate-200/50">
                          {log.operatorName?.charAt(0) || 'S'}
                        </div>
                        <div className="flex-1">
                          <p className="text-sm font-bold text-slate-800">{log.operatorName}</p>
                          <p className="text-sm text-slate-500">{log.action}</p>
                          <p className="text-[11px] text-slate-400 mt-1 font-mono tabular-nums">{log.date} at {log.time}</p>
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Premium Toast Notification */}
        {toast && (
          <div className={`fixed bottom-8 start-1/2 -translate-x-1/2 z-50 rounded-2xl px-6 py-4 text-white shadow-2xl flex items-center gap-3 animate-in fade-in slide-in-from-bottom-8 duration-500 backdrop-blur-md ${
            toast.type === 'success' ? 'bg-emerald-600/90 border border-emerald-400/30' : toast.type === 'error' ? 'bg-rose-600/90 border border-rose-400/30' : 'bg-indigo-600/90 border border-indigo-400/30'
          }`}>
            {toast.type === 'success' ? <CheckCircle2 className="w-5 h-5" strokeWidth={2.5} /> : toast.type === 'error' ? <AlertTriangle className="w-5 h-5" strokeWidth={2.5} /> : <Activity className="w-5 h-5" strokeWidth={2.5} />}
            <span className="font-bold text-sm tracking-wide">{toast.message}</span>
          </div>
        )}
      </div>
    </div>
  );
}