import React, { useMemo, useState } from 'react';
import { FileText, Heart, Landmark, Plus, ShieldCheck } from 'lucide-react';
import { Donor, FundingCampaign, ImpactReport } from '../../types';
import { useAuth } from '../../contexts/useAuth';
import { recentJalaliPeriods, jalaliPeriodLabel } from '../../utils/jalali';
import { formatAFN } from '../../utils/format';
import Toast from '../common/Toast';

interface ImpactViewProps {
  reports: ImpactReport[];
  donors: Donor[];
  campaigns: FundingCampaign[];
  generateReport: (input: { period: string; scopeKind: 'branch' | 'donor' | 'campaign'; scopeId?: string | null }) => Promise<ImpactReport>;
}

function scopeLabel(report: ImpactReport, donors: Donor[], campaigns: FundingCampaign[]) {
  if (report.scopeKind === 'branch') return 'Branch-wide source-traceable impact';
  if (report.scopeKind === 'donor') return `Donor · ${donors.find((donor) => donor.id === report.scopeId)?.fullName ?? report.scopeId}`;
  return `Campaign · ${campaigns.find((campaign) => campaign.id === report.scopeId)?.name ?? report.scopeId}`;
}

export default function ImpactView({ reports, donors, campaigns, generateReport }: ImpactViewProps) {
  const { user } = useAuth();
  const canGenerate = !!user?.isGlobalOwner || !!user?.permissions?.has('Impact.Edit');
  const periodOptions = useMemo(() => recentJalaliPeriods(12, 0), []);
  const [period, setPeriod] = useState(periodOptions[0] ?? '');
  const [scopeKind, setScopeKind] = useState<'branch' | 'donor' | 'campaign'>('branch');
  const [scopeId, setScopeId] = useState('');
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);

  const submit = async () => {
    if (scopeKind !== 'branch' && !scopeId) {
      setToast({ message: `Choose a ${scopeKind} before generating this report.`, type: 'error' });
      return;
    }
    setCreating(true);
    try {
      await generateReport({ period, scopeKind, scopeId: scopeKind === 'branch' ? null : scopeId });
      setToast({ message: 'Derived impact snapshot generated.', type: 'success' });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : 'Could not generate impact report.', type: 'error' });
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-6 text-start">
      <section className="rounded-2xl border border-rose-100 bg-gradient-to-br from-rose-50 via-white to-amber-50 p-6 shadow-sm">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-rose-600">Derived impact reporting</p>
            <h1 className="mt-2 flex items-center gap-3 text-2xl font-black text-slate-900"><Heart className="h-7 w-7 text-rose-600" /> Proof before attribution</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">A donor or campaign report contains only funding and tuition outcomes whose source graph proves the connection. It never borrows branch-wide impact to make an unsupported claim.</p>
          </div>
          <div className="flex items-center gap-3 rounded-xl border border-rose-100 bg-white/80 px-4 py-3 text-xs text-slate-600"><ShieldCheck className="h-5 w-5 text-emerald-600" /><span>Manual metrics and stories are not reporting authorities.</span></div>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end">
          <div className="min-w-48 flex-1"><label className="mb-1 block text-xs font-bold text-slate-600" htmlFor="impact-period">Shamsi period</label><select id="impact-period" className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm" value={period} onChange={(event) => setPeriod(event.target.value)}>{periodOptions.map((key) => <option key={key} value={key}>{jalaliPeriodLabel(key)}</option>)}</select></div>
          <div className="min-w-48 flex-1"><label className="mb-1 block text-xs font-bold text-slate-600" htmlFor="impact-scope">Report scope</label><select id="impact-scope" className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm" value={scopeKind} onChange={(event) => { setScopeKind(event.target.value as typeof scopeKind); setScopeId(''); }}><option value="branch">Branch</option><option value="donor">One donor</option><option value="campaign">One campaign</option></select></div>
          {scopeKind !== 'branch' && <div className="min-w-56 flex-1"><label className="mb-1 block text-xs font-bold text-slate-600" htmlFor="impact-scope-id">{scopeKind === 'donor' ? 'Donor' : 'Campaign'}</label><select id="impact-scope-id" className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm" value={scopeId} onChange={(event) => setScopeId(event.target.value)}><option value="">Choose {scopeKind}</option>{scopeKind === 'donor' ? donors.map((donor) => <option key={donor.id} value={donor.id}>{donor.fullName}</option>) : campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}</select></div>}
          {canGenerate && <button onClick={() => void submit()} disabled={creating} className="inline-flex items-center justify-center gap-2 rounded-xl bg-rose-600 px-4 py-2 text-sm font-bold text-white shadow-sm transition hover:bg-rose-700 disabled:bg-slate-300"><Plus className="h-4 w-4" />{creating ? 'Generating…' : 'Generate snapshot'}</button>}
        </div>
        {!canGenerate && <p className="mt-3 text-xs text-slate-500">You may view authorized snapshots but do not hold Impact.Edit to generate one.</p>}
      </section>

      <section className="space-y-4">
        {reports.map((report) => <article key={report.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex flex-col gap-3 border-b border-slate-100 pb-4 sm:flex-row sm:items-start sm:justify-between"><div><h2 className="flex items-center gap-2 font-black text-slate-900"><FileText className="h-5 w-5 text-rose-600" />{report.title}</h2><p className="mt-1 text-xs text-slate-500">{scopeLabel(report, donors, campaigns)} · {report.periodFrom} → {report.periodTo}</p></div><span className="rounded-full bg-slate-100 px-2 py-1 font-mono text-xs font-bold text-slate-600">{report.period}</span></div><p className="mt-4 text-sm leading-6 text-slate-600">{report.narrative}</p><div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{report.metrics.map((metric) => <div key={metric.id} className="rounded-xl bg-slate-50 p-3"><p className="text-[11px] font-bold leading-4 text-slate-500">{metric.label}</p><p className="mt-2 font-mono text-lg font-black text-slate-900">{metric.unit === 'afn' ? formatAFN(metric.value) : metric.value.toLocaleString('en-US')}</p><p className="mt-1 text-[10px] text-slate-400">{metric.source}</p></div>)}</div></article>)}
        {reports.length === 0 && <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center"><Landmark className="mx-auto h-7 w-7 text-slate-400" /><h2 className="mt-3 font-black text-slate-800">No impact snapshots</h2><p className="mt-1 text-sm text-slate-500">Generate a branch, donor, or campaign report when its source evidence is ready.</p></div>}
      </section>
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}
