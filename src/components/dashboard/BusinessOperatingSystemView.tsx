import React, { useState, useEffect , useCallback} from 'react';
import {Target, TrendingUp, AlertTriangle, AlertOctagon, Info, PiggyBank, Megaphone, GraduationCap, Wallet, DollarSign, ArrowUpRight, ArrowDownRight, CheckCircle2, Loader2, Sparkles, Clock, CalendarDays} from 'lucide-react';
import {formatAFN} from '../../utils/format';

interface ExecutiveDashboardData {
  period: string; todayRevenue: number; monthlyRevenue: number; monthlyExpense: number;
  breakEven: number; fixedCosts: number; variableCosts: number; profit: number; profitMargin: number;
  cashAvailable: number; cashBalance: number; reserveFundBalance: number; reserveFundTarget: number;
  reserveFundProgress: number; outstandingPayments: number; teacherCost: number; marketingCost: number;
  marketingROI: number | null; studentGrowth: number; newStudentsThisMonth: number; newStudentsLastMonth: number;
  averageClassSize: number;
}

interface MarketingFunnelData {
  funnel: { source: string; leads: number; placementTests: number; registrations: number; revenue: number; conversionRate: number }[];
  totalMarketingCost: number; totalRevenue: number; overallROI: number | null;
}

interface StudentAnalyticsData {
  newStudents: number; returningStudents: number; dropouts: number; graduates: number;
  totalStudents: number; activeStudents: number; completionRate: number; placementLevels: Record<string, number>;
}

interface DecisionWarning {
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
}

interface ProfitDistributionData {
  period: string; revenue: number; expense: number; profit: number; profitMargin: number; tierPercent: number;
  reserveFundTarget: number; reserveFundBalance: number; reserveFundMet: boolean; maxWithdrawable: number;
}

// NEW: Profitability interfaces
interface ClassRevenue { name: string; revenue: number; }
interface TimeSlotRevenue { slot: string; revenue: number; }

interface BusinessOperatingSystemViewProps {
  getExecutiveDashboard: (period?: string) => Promise<ExecutiveDashboardData>;
  getMarketingFunnel: (period?: string) => Promise<MarketingFunnelData>;
  getStudentAnalytics: (period?: string) => Promise<StudentAnalyticsData>;
  getDecisionWarnings: () => Promise<{ warnings: DecisionWarning[] }>;
  getProfitDistribution: (period?: string) => Promise<ProfitDistributionData>;
  withdrawProfitDistribution: (amount: number, recipientPartnerId?: string, notes?: string) => Promise<void>;
  isOwner: boolean;
  triggerToast: (message: string, type: 'success' | 'error' | 'info') => void;
  // NEW Props
  revenueByClass?: ClassRevenue[];
  revenueByTimeSlot?: TimeSlotRevenue[];
}

const severityStyles: Record<string, { bg: string; icon: React.ElementType; text: string; border: string }> = {
  critical: { bg: 'bg-rose-500/10', border: 'border-rose-500/20', icon: AlertOctagon, text: 'text-rose-600' },
  warning: { bg: 'bg-amber-500/10', border: 'border-amber-500/20', icon: AlertTriangle, text: 'text-amber-600' },
  info: { bg: 'bg-indigo-500/10', border: 'border-indigo-500/20', icon: Info, text: 'text-indigo-600' },
};

export default function BusinessOperatingSystemView({
  getExecutiveDashboard, getMarketingFunnel, getStudentAnalytics, getDecisionWarnings,
  getProfitDistribution, withdrawProfitDistribution, isOwner, triggerToast, revenueByClass = [], revenueByTimeSlot = []
}: BusinessOperatingSystemViewProps) {
  const [loading, setLoading] = useState(true);
  const [isWithdrawing, setIsWithdrawing] = useState(false);
  const [exec, setExec] = useState<ExecutiveDashboardData | null>(null);
  const [funnel, setFunnel] = useState<MarketingFunnelData | null>(null);
  const [studentStats, setStudentStats] = useState<StudentAnalyticsData | null>(null);
  const [warnings, setWarnings] = useState<DecisionWarning[]>([]);
  const [profitDist, setProfitDist] = useState<ProfitDistributionData | null>(null);
  const [withdrawAmount, setWithdrawAmount] = useState<number>(0);
  const [showWithdrawForm, setShowWithdrawForm] = useState(false);
  
  // NEW: Timeframe state
  const [timeframe, setTimeframe] = useState<'today' | 'month' | 'year'>('month');

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [e, f, s, w, p] = await Promise.all([
        getExecutiveDashboard(timeframe), getMarketingFunnel(timeframe), getStudentAnalytics(timeframe), getDecisionWarnings(), getProfitDistribution(timeframe),
      ]);
      setExec(e);
      setFunnel(f);
      setStudentStats(s);
      setWarnings(w.warnings);
      setProfitDist(p);
      setWithdrawAmount(p.maxWithdrawable);
    } catch {
      triggerToast('Failed to load business operating system data.', 'error');
    } finally {
      setLoading(false);
    }
  }, [timeframe, getExecutiveDashboard, getMarketingFunnel, getStudentAnalytics, getDecisionWarnings, getProfitDistribution, triggerToast]);

  useEffect(() => {
    void (async () => { await loadAll(); })();
  }, [loadAll]); // Reload when timeframe changes

  const handleWithdraw = async () => {
    if (!profitDist || withdrawAmount <= 0 || withdrawAmount > profitDist.maxWithdrawable) {
      triggerToast('Invalid withdrawal amount.', 'error');
      return;
    }
    setIsWithdrawing(true);
    try {
      await withdrawProfitDistribution(withdrawAmount);
      triggerToast('Profit draw recorded successfully.', 'success');
      setShowWithdrawForm(false);
      await loadAll(); 
    } catch (err) {
      triggerToast(err instanceof Error ? err.message : 'Failed to record profit draw.', 'error');
    } finally {
      setIsWithdrawing(false);
    }
  };

  // Premium Glass Card Class (From your design)
  const glassCard = "relative bg-white/70 backdrop-blur-xl border border-slate-200/60 shadow-[0_8px_30px_rgb(0,0,0,0.04)] rounded-2xl overflow-hidden transition-all duration-500 ease-out hover:shadow-[0_12px_40px_rgb(0,0,0,0.08)] hover:-translate-y-0.5";

  if (loading || !exec || !funnel || !studentStats) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-4">
        <div className="relative">
          <div className="absolute inset-0 blur-xl bg-indigo-500/30 animate-pulse rounded-full"></div>
          <Loader2 className="w-8 h-8 animate-spin text-indigo-600 relative z-10" />
        </div>
        <span className="text-[11px] font-bold tracking-[0.2em] text-slate-400 uppercase">Calculating Business KPIs…</span>
      </div>
    );
  }

  const breakEvenGap = exec.monthlyRevenue - exec.breakEven;
  const isPastBreakEven = breakEvenGap >= 0;
  const breakEvenPct = exec.breakEven > 0 ? Math.min(150, Math.round((exec.monthlyRevenue / exec.breakEven) * 100)) : 0;

  const kpis = [
    { label: 'Income Today', value: exec.todayRevenue, icon: DollarSign, color: 'text-emerald-600 bg-emerald-500/10' },
    { label: 'Income This Month', value: exec.monthlyRevenue, icon: TrendingUp, color: 'text-indigo-600 bg-indigo-500/10' },
    { label: 'P&L This Month', value: exec.profit, icon: exec.profit >= 0 ? ArrowUpRight : ArrowDownRight, color: exec.profit >= 0 ? 'text-emerald-600 bg-emerald-500/10' : 'text-rose-600 bg-rose-500/10' },
    { label: 'Cash On Hand', value: exec.cashAvailable, icon: Wallet, color: 'text-slate-700 bg-slate-500/10' },
    { label: 'Student Arrears', value: exec.outstandingPayments, icon: AlertTriangle, color: 'text-amber-600 bg-amber-500/10' },
    { label: 'Teacher Salary Cost', value: exec.teacherCost, icon: GraduationCap, color: 'text-violet-600 bg-violet-500/10' },
    { label: 'Marketing Cost', value: exec.marketingCost, icon: Megaphone, color: 'text-pink-600 bg-pink-500/10' },
    { label: 'Reserve Fund Balance', value: exec.reserveFundBalance, icon: PiggyBank, color: 'text-teal-600 bg-teal-500/10' },
  ];

  return (
    <div className="space-y-6 text-start animate-in fade-in duration-500">
      
      {/* System Warnings */}
      {warnings.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {warnings.map((w, i) => {
            const style = severityStyles[w.severity];
            const Icon = style.icon;
            return (
              <div key={i} className={`flex items-start gap-3 border backdrop-blur-md rounded-xl px-4 py-3 text-xs ${style.bg} ${style.border}`}>
                <Icon className={`w-4 h-4 shrink-0 mt-0.5 ${style.text}`} strokeWidth={2.5} />
                <div>
                  <p className="font-bold tracking-wide text-slate-800">{w.title}</p>
                  <p className="mt-0.5 opacity-80 leading-relaxed text-slate-600">{w.message}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* NEW: Time-based Growth & Filtering Card */}
      <div className={`${glassCard} p-6`}>
        <div className="flex flex-col md:flex-row justify-between md:items-center mb-6 gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-500/10 rounded-lg">
              <CalendarDays className="w-5 h-5 text-indigo-600" strokeWidth={2.5} />
            </div>
            <div>
              <h3 className="text-sm font-extrabold text-slate-900 tracking-tight">Growth Metrics</h3>
              <p className="text-[10px] text-slate-500 font-medium uppercase tracking-wider">Visitors & Student Registrations</p>
            </div>
          </div>
          <div className="flex bg-slate-100/80 p-1 rounded-xl border border-slate-200/60 w-fit">
            {[
              { id: 'today', label: 'Today' },
              { id: 'month', label: 'This Month' },
              { id: 'year', label: 'This Year' },
            ].map((tf) => (
              <button
                key={tf.id}
                onClick={() => setTimeframe(tf.id as any)}
                className={`px-4 py-1.5 text-xs font-bold rounded-lg transition-all duration-300 ${
                  timeframe === tf.id ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                {tf.label}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-gradient-to-br from-indigo-500/10 to-indigo-500/5 border border-indigo-500/20 rounded-xl p-5">
            <p className="text-indigo-600 font-bold uppercase tracking-wider text-[9px]">New Visitors</p>
            <p className="font-black text-slate-800 text-3xl mt-2 tabular-nums">{studentStats.newStudents + studentStats.returningStudents}</p>
            <p className="text-[10px] text-slate-500 mt-1 capitalize">{timeframe === 'today' ? 'Today' : `This ${timeframe}`}</p>
          </div>
          <div className="bg-gradient-to-br from-emerald-500/10 to-emerald-500/5 border border-emerald-500/20 rounded-xl p-5">
            <p className="text-emerald-600 font-bold uppercase tracking-wider text-[9px]">New Students</p>
            <p className="font-black text-slate-800 text-3xl mt-2 tabular-nums">{studentStats.newStudents}</p>
            <p className="text-[10px] text-slate-500 mt-1 capitalize">{timeframe === 'today' ? 'Today' : `This ${timeframe}`}</p>
          </div>
        </div>
      </div>

      {/* Break-even Card */}
      <div className={`${glassCard} p-6`}>
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-500/10 rounded-lg">
              <Target className="w-5 h-5 text-indigo-600" strokeWidth={2.5} />
            </div>
            <h3 className="text-sm font-extrabold text-slate-900 tracking-tight">
              Break-even Progress <span className="text-slate-400 font-medium">({exec.period})</span>
            </h3>
          </div>
          <span className={`text-xs font-black px-3 py-1.5 rounded-full border ${
            isPastBreakEven 
              ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' 
              : 'bg-amber-500/10 text-amber-600 border-amber-500/20'
          }`}>
            {isPastBreakEven ? `${formatAFN(breakEvenGap)} Above Target` : `${formatAFN(Math.abs(breakEvenGap))} To Break-even`}
          </span>
        </div>
        
        <div className="relative w-full h-3 bg-slate-200/70 rounded-full overflow-hidden">
          <div
            className={`absolute top-0 start-0 h-full rounded-full transition-all duration-1000 ease-out ${
              isPastBreakEven 
                ? 'bg-gradient-to-r from-emerald-400 to-emerald-600 shadow-[0_0_10px_rgba(16,185,129,0.4)]' 
                : 'bg-gradient-to-r from-amber-400 to-amber-600 shadow-[0_0_10px_rgba(245,158,11,0.4)]'
            }`}
            style={{ width: `${Math.min(100, breakEvenPct)}%` }}
          />
        </div>
        
        <div className="flex justify-between text-[11px] text-slate-500 mt-3 font-mono tabular-nums">
          <span>Current: <span className="font-bold text-slate-700">{formatAFN(exec.monthlyRevenue)}</span></span>
          <span>Target: <span className="font-bold text-slate-700">{formatAFN(exec.breakEven)}</span></span>
        </div>
      </div>

      {/* KPI Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-5">
        {kpis.map((kpi, i) => (
          <div key={i} className={`${glassCard} p-5 group`}>
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-3 ${kpi.color} group-hover:scale-110 transition-transform duration-300`}>
              <kpi.icon className="w-5 h-5" strokeWidth={2.5} />
            </div>
            <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">{kpi.label}</p>
            <p className="text-xl font-extrabold text-slate-900 font-mono mt-1 tabular-nums">{formatAFN(kpi.value)}</p>
          </div>
        ))}
      </div>

      {/* NEW: Profitability Analytics (Classes & Time Slots) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className={`${glassCard} p-6`}>
          <div className="flex items-center gap-3 mb-5">
            <div className="p-2 bg-amber-500/10 rounded-lg">
              <Sparkles className="w-5 h-5 text-amber-600" strokeWidth={2.5} />
            </div>
            <h3 className="text-sm font-extrabold text-slate-900 tracking-tight">Top Performing Classes</h3>
          </div>
          {revenueByClass.length === 0 ? (
            <div className="text-center py-8 text-xs text-slate-400 font-medium">No revenue data linked to classes yet.</div>
          ) : (
            <div className="space-y-4">
              {revenueByClass.slice(0, 5).map((c, i) => (
                <div key={i} className="flex items-center gap-4">
                  <div className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center text-slate-500 font-bold text-xs">
                    {i + 1}
                  </div>
                  <div className="flex-1">
                    <p className="font-semibold text-slate-800 text-xs">{c.name}</p>
                    <div className="w-full bg-slate-100 rounded-full h-1.5 mt-2">
                      <div className="bg-gradient-to-r from-indigo-500 to-violet-500 h-1.5 rounded-full transition-all duration-700" style={{ width: `${(c.revenue / revenueByClass[0].revenue) * 100}%` }} />
                    </div>
                  </div>
                  <p className="font-mono font-bold text-slate-900 text-xs tabular-nums">{formatAFN(c.revenue)}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className={`${glassCard} p-6`}>
          <div className="flex items-center gap-3 mb-5">
            <div className="p-2 bg-sky-500/10 rounded-lg">
              <Clock className="w-5 h-5 text-sky-600" strokeWidth={2.5} />
            </div>
            <h3 className="text-sm font-extrabold text-slate-900 tracking-tight">Revenue by Time Slot</h3>
          </div>
          {revenueByTimeSlot.length === 0 ? (
            <div className="text-center py-8 text-xs text-slate-400 font-medium">No time slot revenue data available.</div>
          ) : (
            <div className="space-y-3">
              {revenueByTimeSlot.map((t, i) => (
                <div key={i} className="flex items-center justify-between border-b border-slate-100/80 pb-2 last:border-0">
                  <span className="text-xs font-semibold text-slate-700">{t.slot}</span>
                  <span className="font-mono font-bold text-slate-900 text-xs tabular-nums">{formatAFN(t.revenue)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Small Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
        {[
          { label: 'Monthly Profit Margin', value: `${exec.profitMargin}%`, color: exec.profitMargin >= 0 ? 'text-emerald-600' : 'text-rose-600' },
          { label: 'Student Growth', value: `${exec.studentGrowth >= 0 ? '+' : ''}${exec.studentGrowth}`, sub: 'vs last month', color: exec.studentGrowth >= 0 ? 'text-emerald-600' : 'text-rose-600' },
          { label: 'Average Class Fill', value: `${exec.averageClassSize}`, sub: 'students per class', color: 'text-slate-800' },
        ].map((stat, i) => (
          <div key={i} className={`${glassCard} p-5 text-center`}>
            <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">{stat.label}</p>
            <p className={`text-3xl font-extrabold mt-2 tabular-nums ${stat.color}`}>{stat.value}</p>
            {stat.sub && <p className="text-[10px] text-slate-400 font-medium mt-1">{stat.sub}</p>}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Reserve Fund */}
        <div className={`${glassCard} p-6 bg-gradient-to-br from-teal-500/5 to-white/70`}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-teal-500/10 rounded-lg">
                <PiggyBank className="w-5 h-5 text-teal-600" strokeWidth={2.5} />
              </div>
              <h3 className="text-sm font-extrabold text-slate-900 tracking-tight">Contingency Reserve</h3>
            </div>
            <span className="text-xs font-black text-teal-700 bg-teal-100 px-2.5 py-1 rounded-full border border-teal-200/50">
              {exec.reserveFundProgress}%
            </span>
          </div>
          <div className="relative w-full h-3 bg-slate-200/70 rounded-full overflow-hidden border border-slate-200/50">
            <div 
              className="h-full bg-gradient-to-r from-teal-400 to-emerald-500 rounded-full transition-all duration-1000 ease-out shadow-[0_0_10px_rgba(20,184,166,0.4)]" 
              style={{ width: `${exec.reserveFundProgress}%` }} 
            />
          </div>
          <div className="flex justify-between text-[11px] text-slate-600 mt-3 font-mono tabular-nums">
            <span>Current: <span className="font-bold text-slate-800">{formatAFN(exec.reserveFundBalance)}</span></span>
            <span>Target: <span className="font-bold text-slate-800">{formatAFN(exec.reserveFundTarget)}</span></span>
          </div>
        </div>

        {/* Profit Withdrawal (Owner Only) */}
        {isOwner && profitDist && (
          <div className={`${glassCard} p-6 flex flex-col justify-between`}>
            <div>
              <div className="flex items-center gap-3 mb-5">
                <div className="p-2 bg-indigo-500/10 rounded-lg">
                  <DollarSign className="w-5 h-5 text-indigo-600" strokeWidth={2.5} />
                </div>
                <h3 className="text-sm font-extrabold text-slate-900 tracking-tight">Profit Withdrawal</h3>
              </div>
              
              <div className="grid grid-cols-3 gap-3 mb-4">
                <div className="bg-slate-50/80 rounded-xl p-3 text-center border border-slate-200/60">
                  <p className="text-slate-500 font-bold uppercase tracking-wider text-[9px]">Margin</p>
                  <p className="font-black text-slate-800 mt-1 text-sm tabular-nums">{profitDist.profitMargin}%</p>
                </div>
                <div className="bg-slate-50/80 rounded-xl p-3 text-center border border-slate-200/60">
                  <p className="text-slate-500 font-bold uppercase tracking-wider text-[9px]">Allowed %</p>
                  <p className="font-black text-slate-800 mt-1 text-sm tabular-nums">{profitDist.tierPercent}%</p>
                </div>
                <div className={`rounded-xl p-3 text-center border ${profitDist.reserveFundMet ? 'bg-emerald-50/80 border-emerald-200/60' : 'bg-rose-50/80 border-rose-200/60'}`}>
                  <p className={`font-bold uppercase tracking-wider text-[9px] ${profitDist.reserveFundMet ? 'text-emerald-600' : 'text-rose-600'}`}>Fund</p>
                  <p className={`font-black mt-1 text-sm ${profitDist.reserveFundMet ? 'text-emerald-700' : 'text-rose-700'}`}>
                    {profitDist.reserveFundMet ? 'Unlocked' : 'Locked'}
                  </p>
                </div>
              </div>
            </div>

            {profitDist.reserveFundMet && profitDist.maxWithdrawable > 0 ? (
              <div>
                {!showWithdrawForm ? (
                  <button
                    onClick={() => setShowWithdrawForm(true)}
                    className="w-full bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold py-3 rounded-xl cursor-pointer transition-all shadow-sm flex items-center justify-center gap-2"
                  >
                    <DollarSign className="w-4 h-4" />
                    Withdraw up to {formatAFN(profitDist.maxWithdrawable)}
                  </button>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="number"
                      value={withdrawAmount}
                      onChange={(e) => setWithdrawAmount(Number(e.target.value))}
                      max={profitDist.maxWithdrawable}
                      className="bg-white border border-slate-300 rounded-xl px-4 py-2.5 font-mono w-full mb-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none tabular-nums"
                      placeholder="Amount to withdraw"
                    />
                    <div className="flex gap-2 w-full">
                      <button 
                        onClick={handleWithdraw} 
                        disabled={isWithdrawing}
                        className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold py-2.5 rounded-xl cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50 transition-colors shadow-sm"
                      >
                        {isWithdrawing ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                        Confirm
                      </button>
                      <button onClick={() => setShowWithdrawForm(false)} className="px-4 bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs font-bold py-2.5 rounded-xl cursor-pointer transition-colors">
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-[11px] text-rose-600 bg-rose-50 border border-rose-200/50 rounded-xl px-4 py-3 flex items-center gap-2 font-medium">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                Withdrawal locked until reserve fund reaches 6-month target.
              </div>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
        {/* Marketing Funnel */}
        <div className={`${glassCard} p-6 lg:col-span-3`}>
          <div className="flex items-center gap-3 mb-5">
            <div className="p-2 bg-pink-500/10 rounded-lg">
              <Megaphone className="w-5 h-5 text-pink-600" strokeWidth={2.5} />
            </div>
            <h3 className="text-sm font-extrabold text-slate-900 tracking-tight">Marketing Funnel</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[400px]">
              <thead>
                <tr className="text-slate-500 border-b border-slate-200/70">
                  <th className="text-start font-bold pb-3 ps-2 uppercase tracking-wider text-[10px]">Source</th>
                  <th className="text-center font-bold pb-3 uppercase tracking-wider text-[10px]">Leads</th>
                  <th className="text-center font-bold pb-3 uppercase tracking-wider text-[10px]">Tests</th>
                  <th className="text-center font-bold pb-3 uppercase tracking-wider text-[10px]">Enrolls</th>
                  <th className="text-end font-bold pb-3 pe-2 uppercase tracking-wider text-[10px]">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {funnel.funnel.map((f) => (
                  <tr key={f.source} className="border-b border-slate-100/80 hover:bg-slate-50/50 transition-colors group">
                    <td className="py-3 ps-2 font-bold text-slate-800">{f.source}</td>
                    <td className="text-center font-mono text-slate-600 tabular-nums">{f.leads}</td>
                    <td className="text-center font-mono text-slate-600 tabular-nums">{f.placementTests}</td>
                    <td className="text-center font-mono font-bold text-indigo-600 tabular-nums">{f.registrations}</td>
                    <td className="text-end font-mono font-bold text-emerald-600 pe-2 tabular-nums">{formatAFN(f.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-between items-center mt-5 pt-4 border-t border-slate-200/70 text-xs">
            <span className="text-slate-500 font-medium">Total Spend: <span className="font-bold text-slate-800 font-mono tabular-nums">{formatAFN(funnel.totalMarketingCost)}</span></span>
            <span className={`px-3 py-1 rounded-full font-mono font-bold tabular-nums ${
              funnel.overallROI == null ? 'bg-slate-100 text-slate-500' 
              : funnel.overallROI >= 0 ? 'bg-emerald-100 text-emerald-700' 
              : 'bg-rose-100 text-rose-700'
            }`}>
              ROI: {funnel.overallROI == null ? 'N/A' : `${funnel.overallROI}%`}
            </span>
          </div>
        </div>

        {/* Student Analytics */}
        <div className={`${glassCard} p-6 lg:col-span-2`}>
          <div className="flex items-center gap-3 mb-5">
            <div className="p-2 bg-indigo-500/10 rounded-lg">
              <GraduationCap className="w-5 h-5 text-indigo-600" strokeWidth={2.5} />
            </div>
            <h3 className="text-sm font-extrabold text-slate-900 tracking-tight">Student Population</h3>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-gradient-to-br from-emerald-500/10 to-emerald-500/5 border border-emerald-500/20 rounded-xl p-4">
              <p className="text-emerald-600 font-bold uppercase tracking-wider text-[9px]">New</p>
              <p className="font-black text-emerald-700 text-2xl mt-1 tabular-nums">{studentStats.newStudents}</p>
            </div>
            <div className="bg-gradient-to-br from-indigo-500/10 to-indigo-500/5 border border-indigo-500/20 rounded-xl p-4">
              <p className="text-indigo-600 font-bold uppercase tracking-wider text-[9px]">Active</p>
              <p className="font-black text-indigo-700 text-2xl mt-1 tabular-nums">{studentStats.activeStudents}</p>
            </div>
            <div className="bg-gradient-to-br from-rose-500/10 to-rose-500/5 border border-rose-500/20 rounded-xl p-4">
              <p className="text-rose-600 font-bold uppercase tracking-wider text-[9px]">Dropouts</p>
              <p className="font-black text-rose-700 text-2xl mt-1 tabular-nums">{studentStats.dropouts}</p>
            </div>
            <div className="bg-gradient-to-br from-amber-500/10 to-amber-500/5 border border-amber-500/20 rounded-xl p-4">
              <p className="text-amber-600 font-bold uppercase tracking-wider text-[9px]">Graduates</p>
              <p className="font-black text-amber-700 text-2xl mt-1 tabular-nums">{studentStats.graduates}</p>
            </div>
          </div>
          <div className="mt-4 pt-4 border-t border-slate-200/70 flex justify-between items-center text-[11px] text-slate-500">
            <span className="font-medium">Completion Rate:</span>
            <span className="font-bold text-slate-800 font-mono tabular-nums">{studentStats.completionRate}%</span>
          </div>
        </div>
      </div>
    </div>
  );
}