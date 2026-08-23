import React, { useCallback, useMemo, useState } from 'react';
import {
  BadgeCheck, CalendarDays, CircleDollarSign, HandCoins, HeartHandshake,
  LockKeyhole, Plus, ReceiptText, Target, Users,
} from 'lucide-react';
import {
  Donation, DonationRestriction, Donor, FundingCampaign, FundingSourcePosition,
  FundingSummary, Scholarship, ScholarshipAward, SponsorshipAgreement, Student,
} from '../../types';
import { api } from '../../api/client';
import { useAuth } from '../../contexts/useAuth';
import { useInvalidate } from '../../state/serverStateFreshness';
import { formatAFN } from '../../utils/format';
import { ShamsiDateInput } from '../common/ShamsiDateInput';
import Toast from '../common/Toast';

type Tab = 'donors' | 'campaigns' | 'donations' | 'scholarships' | 'sponsorships';
type ToastState = { message: string; type: 'success' | 'error' | 'info' } | null;
type RestrictionKind = '' | DonationRestriction['kind'];

interface FundingViewProps {
  donors: Donor[];
  campaigns: FundingCampaign[];
  donations: Donation[];
  scholarships: Scholarship[];
  scholarshipAwards: ScholarshipAward[];
  sponsorships: SponsorshipAgreement[];
  students: Student[];
  fundingSummary: FundingSummary | null;
  activeBranchId: string;
  addDonor: (data: Pick<Donor, 'fullName' | 'type'> & Partial<Pick<Donor, 'phone' | 'email' | 'country' | 'notes'>>) => Promise<void>;
  addFundingCampaign: (data: Pick<FundingCampaign, 'name' | 'targetAmount'> & Partial<Pick<FundingCampaign, 'description' | 'donorId' | 'startDate' | 'endDate'>>) => Promise<void>;
  recordDonation: (data: { donorId: string; amount: number; date?: string; campaignId?: string | null; restriction?: DonationRestriction | null }) => Promise<void>;
  addScholarship: (data: Pick<Scholarship, 'name' | 'totalBudget'> & Partial<Pick<Scholarship, 'donorId' | 'campaignId' | 'criteria'>>) => Promise<void>;
  awardScholarship: (data: Pick<ScholarshipAward, 'scholarshipId' | 'studentId' | 'amount'> & Partial<Pick<ScholarshipAward, 'awardDate' | 'notes'>>) => Promise<void>;
  addSponsorship: (data: Pick<SponsorshipAgreement, 'donorId' | 'monthlyAmount' | 'startDate' | 'endDate'> & Partial<Pick<SponsorshipAgreement, 'studentId' | 'programId' | 'campaignId'>>) => Promise<void>;
  refreshFundingWorkspace: () => Promise<void>;
}

interface SourceChoice extends FundingSourcePosition {
  kind: 'donation' | 'campaignFundingEntry';
  label: string;
}

interface FundPositionResponse {
  received: number;
  committed: number;
  available: number;
  declaredTarget: number;
  fundings: Array<{
    id: string;
    amount: number;
    donationId?: string | null;
    campaignFundingEntryId?: string | null;
    source: FundingSourcePosition;
  }>;
}

interface AwardResponse {
  awardId: string;
  scholarshipId: string;
  studentId: string;
  amount: number;
  allocated: number;
  remaining: number;
  status: 'active' | 'closed';
  allocations: Array<{ id: string; amount: number; status: 'active' | 'reversed'; semesterName?: string | null; scholarshipFundingId?: string | null }>;
}

interface SponsorshipResponse {
  agreementId: string;
  received: number;
  applied: number;
  returned: number;
  available: number;
  status: SponsorshipAgreement['status'];
  receipts: Array<{
    id: string;
    amount: number;
    date: string;
    source: FundingSourcePosition;
  }>;
  allocations: Array<{ id: string; amount: number; status: 'active' | 'reversed'; semesterName?: string | null }>;
}

interface ObligationRow {
  id: string;
  semesterName: string;
  outstanding: number;
  netAmount: number;
}

const field = 'w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 shadow-xs outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100';
const label = 'mb-1 block text-xs font-bold text-slate-600';
const primary = 'inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-3 py-2 text-xs font-bold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300';
const secondary = 'inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 transition hover:border-emerald-300 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50';

function Dialog({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/45 p-4 sm:items-center" role="dialog" aria-modal="true" aria-label={title}>
      <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white shadow-2xl">
        <div className="sticky top-0 flex items-center justify-between border-b border-slate-100 bg-white px-5 py-4">
          <h2 className="text-base font-black text-slate-900">{title}</h2>
          <button className="rounded-lg px-2 py-1 text-sm font-bold text-slate-500 hover:bg-slate-100" onClick={onClose}>Close</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function Stat({ label: metricLabel, value, tone = 'text-slate-900' }: { label: string; value: string; tone?: string }) {
  return <div className="rounded-xl border border-white/10 bg-white/5 p-3"><p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{metricLabel}</p><p className={`mt-1 font-mono text-xl font-black tabular-nums ${tone}`}>{value}</p></div>;
}

function Status({ value }: { value: string }) {
  const cls = value === 'active' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : value === 'closed' || value === 'terminated' || value === 'cancelled' ? 'bg-slate-100 text-slate-600 border-slate-200' : 'bg-amber-50 text-amber-700 border-amber-200';
  return <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold capitalize ${cls}`}>{value}</span>;
}

export default function FundingView(props: FundingViewProps) {
  const {
    donors, campaigns, donations, scholarships, scholarshipAwards, sponsorships, students, fundingSummary, activeBranchId,
    addDonor, addFundingCampaign, recordDonation, addScholarship, awardScholarship, addSponsorship, refreshFundingWorkspace,
  } = props;
  const { user } = useAuth();
  const invalidate = useInvalidate();
  const canEdit = !!user?.isGlobalOwner || !!user?.permissions?.has('Funding.Edit');
  const canRecordDonation = canEdit || !!user?.permissions?.has('Funding.RecordDonation');
  const [tab, setTab] = useState<Tab>('donors');
  const [toast, setToast] = useState<ToastState>(null);
  const announce = useCallback((message: string, type: 'success' | 'error' | 'info' = 'success') => setToast({ message, type }), []);
  const [dialog, setDialog] = useState<'donor' | 'campaign' | 'donation' | 'scholarship' | 'sponsorship' | null>(null);

  const [donorForm, setDonorForm] = useState({ fullName: '', type: 'individual' as Donor['type'], phone: '', email: '', country: '', notes: '' });
  const [campaignForm, setCampaignForm] = useState({ name: '', donorId: '', targetAmount: 0, description: '', startDate: '', endDate: '' });
  const [donationForm, setDonationForm] = useState({ donorId: '', campaignId: '', amount: 0, date: '', restrictionKind: '' as RestrictionKind, restrictionTargetId: '' });
  const [scholarshipForm, setScholarshipForm] = useState({ name: '', donorId: '', campaignId: '', totalBudget: 0, criteria: '' });
  const [sponsorshipForm, setSponsorshipForm] = useState({ donorId: '', studentId: '', campaignId: '', monthlyAmount: 0, startDate: '', endDate: '' });

  const [fundingScholarship, setFundingScholarship] = useState<Scholarship | null>(null);
  const [fundingSources, setFundingSources] = useState<SourceChoice[]>([]);
  const [fundingForm, setFundingForm] = useState({ sourceKey: '', amount: 0 });
  const [awardingScholarship, setAwardingScholarship] = useState<Scholarship | null>(null);
  const [awardForm, setAwardForm] = useState({ studentId: '', amount: 0, awardDate: '', notes: '' });
  const [managingAward, setManagingAward] = useState<ScholarshipAward | null>(null);
  const [awardPosition, setAwardPosition] = useState<AwardResponse | null>(null);
  const [awardFundings, setAwardFundings] = useState<FundPositionResponse['fundings']>([]);
  const [awardObligations, setAwardObligations] = useState<ObligationRow[]>([]);
  const [awardApply, setAwardApply] = useState({ obligationId: '', scholarshipFundingId: '', amount: 0 });

  const [managingSponsorship, setManagingSponsorship] = useState<SponsorshipAgreement | null>(null);
  const [sponsorshipPosition, setSponsorshipPosition] = useState<SponsorshipResponse | null>(null);
  const [sponsorshipSources, setSponsorshipSources] = useState<SourceChoice[]>([]);
  const [sponsorshipObligations, setSponsorshipObligations] = useState<ObligationRow[]>([]);
  const [sponsorReceipt, setSponsorReceipt] = useState({ sourceKey: '', amount: 0 });
  const [sponsorApply, setSponsorApply] = useState({ studentId: '', obligationId: '', sponsorshipReceiptId: '', amount: 0 });

  const donorName = useCallback((donorId?: string | null) => donors.find((entry) => entry.id === donorId)?.fullName ?? '—', [donors]);
  const campaignName = useCallback((campaignId?: string | null) => campaigns.find((entry) => entry.id === campaignId)?.name ?? 'General fund', [campaigns]);
  const studentName = useCallback((studentId?: string | null) => students.find((entry) => entry.id === studentId)?.fullName ?? '—', [students]);
  const selectedRestrictionTargets = donationForm.restrictionKind === 'campaign' ? campaigns : donationForm.restrictionKind === 'scholarship' ? scholarships : sponsorships;

  const tabs = useMemo(() => [
    { id: 'donors' as const, label: 'Donors', icon: Users, count: donors.length },
    { id: 'campaigns' as const, label: 'Campaigns', icon: Target, count: campaigns.length },
    { id: 'donations' as const, label: 'Donations', icon: ReceiptText, count: donations.length },
    { id: 'scholarships' as const, label: 'Scholarships', icon: BadgeCheck, count: scholarships.length },
    { id: 'sponsorships' as const, label: 'Sponsorships', icon: HeartHandshake, count: sponsorships.length },
  ], [campaigns.length, donations.length, donors.length, scholarships.length, sponsorships.length]);

  const sourceFromKey = (key: string): { donationId?: string; campaignFundingEntryId?: string } => {
    const [kind, id] = key.split(':', 2);
    return kind === 'donation' ? { donationId: id } : { campaignFundingEntryId: id };
  };

  const loadAward = useCallback(async (award: ScholarshipAward) => {
    const [position, obligations, scholarshipPosition] = await Promise.all([
      api.get<AwardResponse>(`/funding/scholarship-awards/${award.id}`),
      api.get<ObligationRow[]>(`/funding/students/${award.studentId}/tuition-obligations`),
      api.get<FundPositionResponse>(`/funding/scholarships/${award.scholarshipId}/position`),
    ]);
    setAwardPosition(position);
    setAwardObligations(obligations);
    setAwardFundings(scholarshipPosition.fundings);
  }, []);

  const loadSponsorship = useCallback(async (agreement: SponsorshipAgreement, studentId = agreement.studentId ?? '') => {
    const [position, sourceResult] = await Promise.all([
      api.get<SponsorshipResponse>(`/funding/sponsorships/${agreement.id}/position`),
      api.get<{ donations: SourceChoice[]; campaignFundingEntries: SourceChoice[] }>(`/funding/sponsorships/${agreement.id}/funding-sources`),
    ]);
    setSponsorshipPosition(position);
    setSponsorshipSources([
      ...sourceResult.donations.map((source) => ({ ...source, kind: 'donation' as const, label: `Donation · ${formatAFN(source.available)} available` })),
      ...sourceResult.campaignFundingEntries.map((source) => ({ ...source, kind: 'campaignFundingEntry' as const, label: `Campaign balance · ${formatAFN(source.available)} available` })),
    ]);
    setSponsorshipObligations(studentId ? await api.get<ObligationRow[]>(`/funding/students/${studentId}/tuition-obligations`) : []);
  }, []);

  const run = async (work: () => Promise<void>, success: string, datasets: string[] = ['funding']) => {
    try {
      await work();
      datasets.forEach((dataset) => invalidate(dataset));
      announce(success);
    } catch (error) {
      announce(error instanceof Error ? error.message : 'The operation could not be completed.', 'error');
    }
  };

  const submitDonation = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!donationForm.donorId || donationForm.amount <= 0) return announce('Choose a donor and enter a positive amount.', 'error');
    if (donationForm.restrictionKind && !donationForm.restrictionTargetId) return announce('A restricted donation requires one structured target.', 'error');
    const restriction = donationForm.restrictionKind
      ? { kind: donationForm.restrictionKind, targetId: donationForm.restrictionTargetId } as DonationRestriction
      : null;
    await run(async () => {
      await recordDonation({
        donorId: donationForm.donorId, campaignId: donationForm.restrictionKind === 'campaign' ? donationForm.restrictionTargetId : donationForm.campaignId || null,
        amount: donationForm.amount, date: donationForm.date || undefined, restriction,
      });
      setDialog(null);
      setDonationForm({ donorId: '', campaignId: '', amount: 0, date: '', restrictionKind: '', restrictionTargetId: '' });
    }, restriction ? 'Restricted donation recorded in its named target.' : 'Donation recorded and linked to income.', ['funding', 'finance']);
  };

  const openFunding = async (scholarship: Scholarship) => {
    try {
      const result = await api.get<{ donations: SourceChoice[]; campaignFundingEntries: SourceChoice[] }>(`/funding/scholarships/${scholarship.id}/funding-sources`);
      setFundingScholarship(scholarship);
      setFundingSources([
        ...result.donations.map((source) => ({ ...source, kind: 'donation' as const, label: `Donation · ${formatAFN(source.available)} available` })),
        ...result.campaignFundingEntries.map((source) => ({ ...source, kind: 'campaignFundingEntry' as const, label: `Campaign balance · ${formatAFN(source.available)} available` })),
      ]);
      setFundingForm({ sourceKey: '', amount: 0 });
    } catch (error) {
      announce(error instanceof Error ? error.message : 'Could not load funding sources.', 'error');
    }
  };

  const selectedAwardReceipt = sponsorshipPosition?.receipts.find((receipt) => receipt.id === sponsorApply.sponsorshipReceiptId);

  return (
    <div className="space-y-6 text-start" id="funding-view-root">
      <section className="overflow-hidden rounded-2xl bg-slate-950 text-white shadow-sm">
        <div className="grid gap-5 px-6 py-6 lg:grid-cols-[1.2fr,1fr] lg:px-8">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-300">Funding workspace</p>
            <h1 className="mt-2 flex items-center gap-3 text-2xl font-black"><HandCoins className="h-7 w-7 text-amber-300" /> Donor funding with source proof</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">Every donation is linked to cash income. Restricted money names one target, and aid applications retain the source that funded them.</p>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-2">
            <Stat label="Donations received" value={formatAFN(fundingSummary?.donationsReceived ?? 0)} tone="text-emerald-300" />
            <Stat label="Restricted" value={formatAFN(fundingSummary?.restrictedDonations ?? 0)} tone="text-amber-300" />
            <Stat label="Active campaigns" value={String(fundingSummary?.activeCampaigns ?? 0)} />
            <Stat label="Active sponsorships" value={String(fundingSummary?.activeSponsorships ?? 0)} />
          </div>
        </div>
        <div className="grid border-t border-white/10 px-6 py-4 text-xs text-slate-300 md:grid-cols-2 md:px-8">
          <p>Campaign progress: <strong className="font-mono text-white">{formatAFN(fundingSummary?.campaignRaised ?? 0)}</strong> of <strong className="font-mono text-white">{formatAFN(fundingSummary?.campaignTarget ?? 0)}</strong></p>
          <p>Scholarship sources: <strong className="font-mono text-white">{formatAFN(fundingSummary?.scholarshipReceived ?? 0)}</strong> received; <strong className="font-mono text-white">{formatAFN(fundingSummary?.scholarshipCommitted ?? 0)}</strong> committed.</p>
        </div>
      </section>

      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-xs">
          {tabs.map((entry) => {
            const Icon = entry.icon;
            return <button key={entry.id} onClick={() => setTab(entry.id)} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold ${tab === entry.id ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-50'}`}><Icon className="h-3.5 w-3.5" />{entry.label}<span className="rounded-full bg-black/10 px-1.5 py-0.5 font-mono text-[10px]">{entry.count}</span></button>;
          })}
        </div>
        <div className="flex flex-wrap gap-2">
          {canEdit && tab === 'donors' && <button className={primary} onClick={() => setDialog('donor')}><Plus className="h-4 w-4" />New donor</button>}
          {canEdit && tab === 'campaigns' && <button className={primary} onClick={() => setDialog('campaign')}><Plus className="h-4 w-4" />New campaign</button>}
          {canRecordDonation && tab === 'donations' && <button className={primary} onClick={() => setDialog('donation')}><ReceiptText className="h-4 w-4" />Record donation</button>}
          {canEdit && tab === 'scholarships' && <button className={primary} onClick={() => setDialog('scholarship')}><Plus className="h-4 w-4" />New scholarship</button>}
          {canEdit && tab === 'sponsorships' && <button className={primary} onClick={() => setDialog('sponsorship')}><Plus className="h-4 w-4" />New sponsorship</button>}
        </div>
      </div>

      {tab === 'donors' && <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><table className="w-full text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="px-4 py-3 text-start">Donor</th><th className="px-4 py-3 text-start">Type</th><th className="px-4 py-3 text-start">Contact</th></tr></thead><tbody className="divide-y divide-slate-100">{donors.map((donor) => <tr key={donor.id}><td className="px-4 py-3 font-bold text-slate-800">{donor.fullName}</td><td className="px-4 py-3 capitalize text-slate-600">{donor.type}</td><td className="px-4 py-3 text-slate-600">{donor.email || donor.phone || '—'}</td></tr>)}{donors.length === 0 && <tr><td colSpan={3} className="px-4 py-12 text-center text-slate-400">No donor appears in this branch scope.</td></tr>}</tbody></table></section>}

      {tab === 'campaigns' && <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{campaigns.map((campaign) => <article key={campaign.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex items-start justify-between gap-3"><div><h2 className="font-black text-slate-900">{campaign.name}</h2><p className="mt-1 text-xs text-slate-500">Lead donor: {donorName(campaign.donorId)}</p></div><Status value={campaign.status} /></div><div className="mt-5"><div className="flex justify-between text-xs text-slate-500"><span>Raised</span><span className="font-mono font-bold text-slate-800">{formatAFN(campaign.raisedAmount)} / {formatAFN(campaign.targetAmount)}</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.min(100, campaign.progressPercent)}%` }} /></div></div><p className="mt-4 text-xs text-slate-500"><CalendarDays className="me-1 inline h-3.5 w-3.5" />{campaign.startDate} → {campaign.endDate || 'ongoing'}</p></article>)}{campaigns.length === 0 && <p className="rounded-2xl border border-dashed border-slate-300 p-12 text-center text-sm text-slate-500 md:col-span-2 xl:col-span-3">No campaigns in this branch.</p>}</section>}

      {tab === 'donations' && <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><table className="w-full text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="px-4 py-3 text-start">Receipt</th><th className="px-4 py-3 text-start">Donor</th><th className="px-4 py-3 text-start">Restriction / campaign</th><th className="px-4 py-3 text-start">Remaining source</th><th className="px-4 py-3 text-end">Amount</th></tr></thead><tbody className="divide-y divide-slate-100">{donations.map((donation) => <tr key={donation.id}><td className="px-4 py-3 font-mono text-xs text-slate-500">{donation.receiptNo}</td><td className="px-4 py-3 font-bold text-slate-800">{donorName(donation.donorId)}</td><td className="px-4 py-3 text-xs text-slate-600">{donation.restrictionKind ? <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-1 font-bold text-amber-800"><LockKeyhole className="h-3 w-3" />Restricted · {donation.restrictionKind}</span> : campaignName(donation.campaignId)}</td><td className="px-4 py-3 font-mono text-xs text-slate-600">{formatAFN(donation.allocation?.unallocated ?? 0)}</td><td className="px-4 py-3 text-end font-mono font-black text-emerald-700">{formatAFN(donation.amount)}</td></tr>)}{donations.length === 0 && <tr><td colSpan={5} className="px-4 py-12 text-center text-slate-400">No donations in this branch.</td></tr>}</tbody></table></section>}

      {tab === 'scholarships' && <section className="space-y-5"><div className="grid gap-4 md:grid-cols-2">{scholarships.map((scholarship) => <article key={scholarship.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex justify-between gap-3"><div><h2 className="font-black text-slate-900">{scholarship.name}</h2><p className="mt-1 text-xs text-slate-500">Campaign: {campaignName(scholarship.campaignId)}</p></div><Status value={scholarship.status} /></div><div className="mt-4 grid grid-cols-3 gap-2 text-xs"><div><p className="text-slate-400">Received</p><p className="font-mono font-bold text-emerald-700">{formatAFN(scholarship.received)}</p></div><div><p className="text-slate-400">Committed</p><p className="font-mono font-bold text-slate-700">{formatAFN(scholarship.committed)}</p></div><div><p className="text-slate-400">Available</p><p className="font-mono font-bold text-indigo-700">{formatAFN(scholarship.available)}</p></div></div><p className="mt-3 text-xs text-slate-500">Declared target: {formatAFN(scholarship.totalBudget)}</p>{canEdit && <div className="mt-4 flex flex-wrap gap-2"><button className={secondary} onClick={() => void openFunding(scholarship)}><CircleDollarSign className="h-3.5 w-3.5" />Fund source</button><button className={secondary} disabled={scholarship.available <= 0 || scholarship.status !== 'active'} onClick={() => { setAwardingScholarship(scholarship); setAwardForm({ studentId: '', amount: 0, awardDate: '', notes: '' }); }}><BadgeCheck className="h-3.5 w-3.5" />Award student</button></div>}</article>)}{scholarships.length === 0 && <p className="rounded-2xl border border-dashed border-slate-300 p-12 text-center text-sm text-slate-500 md:col-span-2">No scholarships in this branch.</p>}</div><div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="border-b border-slate-100 px-5 py-4"><h2 className="font-black text-slate-900">Scholarship awards</h2></div><table className="w-full text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="px-4 py-3 text-start">Student</th><th className="px-4 py-3 text-start">Scholarship</th><th className="px-4 py-3 text-end">Award</th><th className="px-4 py-3 text-end">Action</th></tr></thead><tbody className="divide-y divide-slate-100">{scholarshipAwards.map((award) => <tr key={award.id}><td className="px-4 py-3 font-bold text-slate-800">{studentName(award.studentId)}</td><td className="px-4 py-3 text-slate-600">{scholarships.find((entry) => entry.id === award.scholarshipId)?.name ?? '—'}</td><td className="px-4 py-3 text-end font-mono font-bold">{formatAFN(award.amount)}</td><td className="px-4 py-3 text-end">{canEdit && <button className={secondary} onClick={() => { setManagingAward(award); setAwardPosition(null); void loadAward(award).catch((error) => announce(error instanceof Error ? error.message : 'Could not load award.', 'error')); }}>Manage</button>}</td></tr>)}{scholarshipAwards.length === 0 && <tr><td colSpan={4} className="px-4 py-10 text-center text-slate-400">No awards issued.</td></tr>}</tbody></table></div></section>}

      {tab === 'sponsorships' && <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><table className="w-full text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="px-4 py-3 text-start">Sponsor</th><th className="px-4 py-3 text-start">Student</th><th className="px-4 py-3 text-start">Campaign</th><th className="px-4 py-3 text-end">Received</th><th className="px-4 py-3 text-end">Available</th><th className="px-4 py-3 text-end">Action</th></tr></thead><tbody className="divide-y divide-slate-100">{sponsorships.map((agreement) => <tr key={agreement.id}><td className="px-4 py-3 font-bold text-slate-800">{donorName(agreement.donorId)}</td><td className="px-4 py-3 text-slate-600">{studentName(agreement.studentId)}</td><td className="px-4 py-3 text-slate-600">{campaignName(agreement.campaignId)}</td><td className="px-4 py-3 text-end font-mono">{formatAFN(agreement.received)}</td><td className="px-4 py-3 text-end font-mono text-indigo-700">{formatAFN(agreement.available)}</td><td className="px-4 py-3 text-end">{canEdit && <button className={secondary} onClick={() => { setManagingSponsorship(agreement); setSponsorshipPosition(null); setSponsorApply({ studentId: agreement.studentId ?? '', obligationId: '', sponsorshipReceiptId: '', amount: 0 }); void loadSponsorship(agreement).catch((error) => announce(error instanceof Error ? error.message : 'Could not load sponsorship.', 'error')); }}>Manage</button>}</td></tr>)}{sponsorships.length === 0 && <tr><td colSpan={6} className="px-4 py-12 text-center text-slate-400">No sponsorships in this branch.</td></tr>}</tbody></table></section>}

      {dialog === 'donor' && <Dialog title="Create donor" onClose={() => setDialog(null)}><form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void run(async () => { await addDonor(donorForm); setDialog(null); setDonorForm({ fullName: '', type: 'individual', phone: '', email: '', country: '', notes: '' }); }, 'Donor created.'); }}><div><label className={label}>Full name</label><input required className={field} value={donorForm.fullName} onChange={(event) => setDonorForm({ ...donorForm, fullName: event.target.value })} /></div><div><label className={label}>Type</label><select className={field} value={donorForm.type} onChange={(event) => setDonorForm({ ...donorForm, type: event.target.value as Donor['type'] })}>{(['individual', 'organization', 'ngo', 'government'] as Donor['type'][]).map((type) => <option key={type} value={type}>{type}</option>)}</select></div><div className="grid gap-3 sm:grid-cols-2"><div><label className={label}>Email</label><input className={field} value={donorForm.email} onChange={(event) => setDonorForm({ ...donorForm, email: event.target.value })} /></div><div><label className={label}>Phone</label><input className={field} value={donorForm.phone} onChange={(event) => setDonorForm({ ...donorForm, phone: event.target.value })} /></div></div><button className={primary}>Create donor</button></form></Dialog>}

      {dialog === 'campaign' && <Dialog title="Create campaign" onClose={() => setDialog(null)}><form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void run(async () => { await addFundingCampaign({ name: campaignForm.name, donorId: campaignForm.donorId || null, targetAmount: campaignForm.targetAmount, description: campaignForm.description || null, startDate: campaignForm.startDate || undefined, endDate: campaignForm.endDate || null }); setDialog(null); setCampaignForm({ name: '', donorId: '', targetAmount: 0, description: '', startDate: '', endDate: '' }); }, 'Campaign created.'); }}><div><label className={label}>Campaign name</label><input required className={field} value={campaignForm.name} onChange={(event) => setCampaignForm({ ...campaignForm, name: event.target.value })} /></div><div><label className={label}>Lead donor</label><select className={field} value={campaignForm.donorId} onChange={(event) => setCampaignForm({ ...campaignForm, donorId: event.target.value })}><option value="">No lead donor</option>{donors.map((donor) => <option key={donor.id} value={donor.id}>{donor.fullName}</option>)}</select></div><div><label className={label}>Target (AFN)</label><input required min={0} step={1} type="number" className={field} value={campaignForm.targetAmount || ''} onChange={(event) => setCampaignForm({ ...campaignForm, targetAmount: Number(event.target.value) })} /></div><div className="grid gap-3 sm:grid-cols-2"><ShamsiDateInput label="Start date" value={campaignForm.startDate} onChange={(startDate) => setCampaignForm({ ...campaignForm, startDate })} /><ShamsiDateInput label="End date" value={campaignForm.endDate} onChange={(endDate) => setCampaignForm({ ...campaignForm, endDate })} /></div><button className={primary}>Create campaign</button></form></Dialog>}

      {dialog === 'donation' && <Dialog title="Record donation" onClose={() => setDialog(null)}><form className="space-y-4" onSubmit={submitDonation}><div><label className={label}>Donor</label><select required className={field} value={donationForm.donorId} onChange={(event) => setDonationForm({ ...donationForm, donorId: event.target.value })}><option value="">Choose donor</option>{donors.map((donor) => <option key={donor.id} value={donor.id}>{donor.fullName}</option>)}</select></div><div><label className={label}>Campaign provenance (optional)</label><select className={field} value={donationForm.campaignId} onChange={(event) => setDonationForm({ ...donationForm, campaignId: event.target.value })}><option value="">No campaign</option>{campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}</select></div><div className="grid gap-3 sm:grid-cols-2"><div><label className={label}>Amount (AFN)</label><input required min={1} step={1} type="number" className={field} value={donationForm.amount || ''} onChange={(event) => setDonationForm({ ...donationForm, amount: Number(event.target.value) })} /></div><ShamsiDateInput label="Donation date" value={donationForm.date} onChange={(date) => setDonationForm({ ...donationForm, date })} /></div><fieldset className="rounded-xl border border-amber-200 bg-amber-50 p-3"><legend className="px-1 text-xs font-black text-amber-900">Restriction</legend><label className={label}>Structured target</label><select className={field} value={donationForm.restrictionKind} onChange={(event) => setDonationForm({ ...donationForm, restrictionKind: event.target.value as RestrictionKind, restrictionTargetId: '' })}><option value="">Unrestricted donation</option><option value="campaign">Campaign</option><option value="scholarship">Scholarship</option><option value="sponsorship">Sponsorship</option></select>{donationForm.restrictionKind && <div className="mt-3"><label className={label}>Required target</label><select required className={field} value={donationForm.restrictionTargetId} onChange={(event) => setDonationForm({ ...donationForm, restrictionTargetId: event.target.value })}><option value="">Choose {donationForm.restrictionKind}</option>{selectedRestrictionTargets.map((target: any) => <option key={target.id} value={target.id}>{target.name ?? `${donorName(target.donorId)} sponsorship`}</option>)}</select><p className="mt-2 text-xs text-amber-800">The system posts this donation only into this named target. A note cannot override the target.</p></div>}</fieldset><button className={primary}>Record donation</button></form></Dialog>}

      {dialog === 'scholarship' && <Dialog title="Create scholarship" onClose={() => setDialog(null)}><form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void run(async () => { await addScholarship({ name: scholarshipForm.name, donorId: scholarshipForm.donorId || null, campaignId: scholarshipForm.campaignId || null, totalBudget: scholarshipForm.totalBudget, criteria: scholarshipForm.criteria || null }); setDialog(null); setScholarshipForm({ name: '', donorId: '', campaignId: '', totalBudget: 0, criteria: '' }); }, 'Scholarship created.'); }}><div><label className={label}>Name</label><input required className={field} value={scholarshipForm.name} onChange={(event) => setScholarshipForm({ ...scholarshipForm, name: event.target.value })} /></div><div className="grid gap-3 sm:grid-cols-2"><div><label className={label}>Donor</label><select className={field} value={scholarshipForm.donorId} onChange={(event) => setScholarshipForm({ ...scholarshipForm, donorId: event.target.value })}><option value="">No donor</option>{donors.map((donor) => <option key={donor.id} value={donor.id}>{donor.fullName}</option>)}</select></div><div><label className={label}>Campaign</label><select className={field} value={scholarshipForm.campaignId} onChange={(event) => setScholarshipForm({ ...scholarshipForm, campaignId: event.target.value })}><option value="">No campaign</option>{campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}</select></div></div><div><label className={label}>Declared target (AFN)</label><input required min={0} step={1} type="number" className={field} value={scholarshipForm.totalBudget || ''} onChange={(event) => setScholarshipForm({ ...scholarshipForm, totalBudget: Number(event.target.value) })} /></div><div><label className={label}>Criteria</label><textarea className={field} value={scholarshipForm.criteria} onChange={(event) => setScholarshipForm({ ...scholarshipForm, criteria: event.target.value })} /></div><button className={primary}>Create scholarship</button></form></Dialog>}

      {dialog === 'sponsorship' && <Dialog title="Create sponsorship agreement" onClose={() => setDialog(null)}><form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void run(async () => { await addSponsorship({ donorId: sponsorshipForm.donorId, studentId: sponsorshipForm.studentId || null, campaignId: sponsorshipForm.campaignId || null, monthlyAmount: sponsorshipForm.monthlyAmount, startDate: sponsorshipForm.startDate, endDate: sponsorshipForm.endDate }); setDialog(null); setSponsorshipForm({ donorId: '', studentId: '', campaignId: '', monthlyAmount: 0, startDate: '', endDate: '' }); }, 'Sponsorship agreement created.'); }}><div><label className={label}>Donor</label><select required className={field} value={sponsorshipForm.donorId} onChange={(event) => setSponsorshipForm({ ...sponsorshipForm, donorId: event.target.value })}><option value="">Choose donor</option>{donors.map((donor) => <option key={donor.id} value={donor.id}>{donor.fullName}</option>)}</select></div><div className="grid gap-3 sm:grid-cols-2"><div><label className={label}>Student (optional)</label><select className={field} value={sponsorshipForm.studentId} onChange={(event) => setSponsorshipForm({ ...sponsorshipForm, studentId: event.target.value })}><option value="">Any eligible student</option>{students.map((student) => <option key={student.id} value={student.id}>{student.fullName}</option>)}</select></div><div><label className={label}>Campaign for terminal returns</label><select className={field} value={sponsorshipForm.campaignId} onChange={(event) => setSponsorshipForm({ ...sponsorshipForm, campaignId: event.target.value })}><option value="">No campaign (cannot close with a balance)</option>{campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}</select></div></div><div><label className={label}>Monthly promise (AFN)</label><input required min={0} step={1} type="number" className={field} value={sponsorshipForm.monthlyAmount || ''} onChange={(event) => setSponsorshipForm({ ...sponsorshipForm, monthlyAmount: Number(event.target.value) })} /></div><div className="grid gap-3 sm:grid-cols-2"><ShamsiDateInput required label="Start date" value={sponsorshipForm.startDate} onChange={(startDate) => setSponsorshipForm({ ...sponsorshipForm, startDate })} /><ShamsiDateInput required label="End date" value={sponsorshipForm.endDate} onChange={(endDate) => setSponsorshipForm({ ...sponsorshipForm, endDate })} /></div><button className={primary}>Create sponsorship</button></form></Dialog>}

      {fundingScholarship && <Dialog title={`Fund ${fundingScholarship.name}`} onClose={() => setFundingScholarship(null)}><form className="space-y-3" onSubmit={(event) => { event.preventDefault(); const source = sourceFromKey(fundingForm.sourceKey); void run(async () => { await api.post(`/funding/scholarships/${fundingScholarship.id}/fundings`, { ...source, amount: fundingForm.amount }); await refreshFundingWorkspace(); setFundingScholarship(null); }, 'Funding source allocated to scholarship.'); }}><div><label className={label}>Source</label><select required className={field} value={fundingForm.sourceKey} onChange={(event) => setFundingForm({ ...fundingForm, sourceKey: event.target.value })}><option value="">Choose available source</option>{fundingSources.map((source) => <option key={`${source.kind}:${source.id}`} value={`${source.kind}:${source.id}`}>{source.label}</option>)}</select></div><div><label className={label}>Amount (AFN)</label><input required min={1} step={1} type="number" className={field} value={fundingForm.amount || ''} onChange={(event) => setFundingForm({ ...fundingForm, amount: Number(event.target.value) })} /></div><button className={primary}>Allocate source</button></form></Dialog>}

      {awardingScholarship && <Dialog title={`Award ${awardingScholarship.name}`} onClose={() => setAwardingScholarship(null)}><form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void run(async () => { await awardScholarship({ scholarshipId: awardingScholarship.id, studentId: awardForm.studentId, amount: awardForm.amount, awardDate: awardForm.awardDate || undefined, notes: awardForm.notes || null }); setAwardingScholarship(null); }, 'Scholarship award created.', ['funding', 'students']); }}><p className="rounded-lg bg-emerald-50 p-3 text-xs text-emerald-800">The available figure is server-derived: {formatAFN(awardingScholarship.available)}.</p><div><label className={label}>Student</label><select required className={field} value={awardForm.studentId} onChange={(event) => setAwardForm({ ...awardForm, studentId: event.target.value })}><option value="">Choose student</option>{students.map((student) => <option key={student.id} value={student.id}>{student.fullName}</option>)}</select></div><div><label className={label}>Amount (AFN)</label><input required min={1} step={1} type="number" className={field} value={awardForm.amount || ''} onChange={(event) => setAwardForm({ ...awardForm, amount: Number(event.target.value) })} /></div><ShamsiDateInput label="Award date" value={awardForm.awardDate} onChange={(awardDate) => setAwardForm({ ...awardForm, awardDate })} /><button className={primary}>Create award</button></form></Dialog>}

      {managingAward && <Dialog title="Apply scholarship award" onClose={() => setManagingAward(null)}>{!awardPosition ? <p className="py-8 text-center text-sm text-slate-400">Loading award…</p> : <div className="space-y-5"><div className="grid grid-cols-3 gap-3 rounded-xl bg-slate-50 p-3 text-xs"><div><p className="text-slate-400">Award</p><p className="font-mono font-bold">{formatAFN(awardPosition.amount)}</p></div><div><p className="text-slate-400">Applied</p><p className="font-mono font-bold">{formatAFN(awardPosition.allocated)}</p></div><div><p className="text-slate-400">Remaining</p><p className="font-mono font-bold text-indigo-700">{formatAFN(awardPosition.remaining)}</p></div></div><form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void run(async () => { await api.post(`/funding/scholarship-awards/${managingAward.id}/allocations`, awardApply); await Promise.all([loadAward(managingAward), refreshFundingWorkspace()]); setAwardApply({ obligationId: '', scholarshipFundingId: '', amount: 0 }); }, 'Scholarship application recorded.', ['funding', 'students', 'payments']); }}><div><label className={label}>Tuition obligation</label><select required className={field} value={awardApply.obligationId} onChange={(event) => setAwardApply({ ...awardApply, obligationId: event.target.value })}><option value="">Choose outstanding term</option>{awardObligations.filter((obligation) => obligation.outstanding > 0).map((obligation) => <option key={obligation.id} value={obligation.id}>{obligation.semesterName} · {formatAFN(obligation.outstanding)} outstanding</option>)}</select></div><div><label className={label}>Exact received scholarship source</label><select required className={field} value={awardApply.scholarshipFundingId} onChange={(event) => setAwardApply({ ...awardApply, scholarshipFundingId: event.target.value })}><option value="">Choose source</option>{awardFundings.filter((funding) => funding.source.available > 0).map((funding) => <option key={funding.id} value={funding.id}>{formatAFN(funding.source.available)} available</option>)}</select></div><div><label className={label}>Amount (AFN)</label><input required min={1} step={1} type="number" className={field} value={awardApply.amount || ''} onChange={(event) => setAwardApply({ ...awardApply, amount: Number(event.target.value) })} /></div><button className={primary} disabled={awardPosition.status !== 'active'}>Apply to tuition</button></form><div className="border-t border-slate-100 pt-4"><p className="mb-2 text-xs font-black text-slate-700">Applications</p>{awardPosition.allocations.map((allocation) => <div key={allocation.id} className="flex items-center justify-between py-2 text-xs"><span>{allocation.semesterName || 'Term'} · {formatAFN(allocation.amount)} · {allocation.status}</span>{allocation.status === 'active' && awardPosition.status === 'active' && <button className="text-rose-700 hover:underline" onClick={() => { const reason = window.prompt('Reason for reversal (at least 8 characters)'); if (!reason) return; void run(async () => { await api.post(`/funding/scholarship-awards/${managingAward.id}/allocations/${allocation.id}/reverse`, { reason }); await Promise.all([loadAward(managingAward), refreshFundingWorkspace()]); }, 'Scholarship application reversed.', ['funding', 'students', 'payments']); }}>Reverse</button>}</div>)}{awardPosition.status === 'active' && <button className={secondary} onClick={() => { const reason = window.prompt('Reason for closing this award (at least 8 characters)'); if (!reason) return; void run(async () => { await api.post(`/funding/scholarship-awards/${managingAward.id}/close`, { reason }); await Promise.all([loadAward(managingAward), refreshFundingWorkspace()]); }, 'Award closed; unapplied money returned to the fund.'); }}>Close award</button>}</div></div>}</Dialog>}

      {managingSponsorship && <Dialog title="Manage sponsorship" onClose={() => setManagingSponsorship(null)}>{!sponsorshipPosition ? <p className="py-8 text-center text-sm text-slate-400">Loading sponsorship…</p> : <div className="space-y-5"><div className="grid grid-cols-4 gap-2 rounded-xl bg-slate-50 p-3 text-xs"><div><p className="text-slate-400">Received</p><p className="font-mono font-bold">{formatAFN(sponsorshipPosition.received)}</p></div><div><p className="text-slate-400">Applied</p><p className="font-mono font-bold">{formatAFN(sponsorshipPosition.applied)}</p></div><div><p className="text-slate-400">Returned</p><p className="font-mono font-bold">{formatAFN(sponsorshipPosition.returned)}</p></div><div><p className="text-slate-400">Available</p><p className="font-mono font-bold text-indigo-700">{formatAFN(sponsorshipPosition.available)}</p></div></div><form className="space-y-3 border-t border-slate-100 pt-4" onSubmit={(event) => { event.preventDefault(); const source = sourceFromKey(sponsorReceipt.sourceKey); void run(async () => { await api.post(`/funding/sponsorships/${managingSponsorship.id}/receipts`, { ...source, amount: sponsorReceipt.amount }); await Promise.all([loadSponsorship(managingSponsorship, sponsorApply.studentId), refreshFundingWorkspace()]); setSponsorReceipt({ sourceKey: '', amount: 0 }); }, 'Funding source received by sponsorship.'); }}><p className="text-xs font-black text-slate-800">Receive exact funding source</p><select required className={field} value={sponsorReceipt.sourceKey} onChange={(event) => setSponsorReceipt({ ...sponsorReceipt, sourceKey: event.target.value })}><option value="">Choose source</option>{sponsorshipSources.map((source) => <option key={`${source.kind}:${source.id}`} value={`${source.kind}:${source.id}`}>{source.label}</option>)}</select><input required min={1} step={1} type="number" className={field} placeholder="Amount AFN" value={sponsorReceipt.amount || ''} onChange={(event) => setSponsorReceipt({ ...sponsorReceipt, amount: Number(event.target.value) })} /><button className={primary} disabled={sponsorshipPosition.status !== 'active'}>Record receipt</button></form><form className="space-y-3 border-t border-slate-100 pt-4" onSubmit={(event) => { event.preventDefault(); void run(async () => { await api.post(`/funding/sponsorships/${managingSponsorship.id}/allocations`, sponsorApply); await Promise.all([loadSponsorship(managingSponsorship, sponsorApply.studentId), refreshFundingWorkspace()]); setSponsorApply({ ...sponsorApply, obligationId: '', sponsorshipReceiptId: '', amount: 0 }); }, 'Sponsorship applied to tuition.', ['funding', 'students', 'payments']); }}><p className="text-xs font-black text-slate-800">Apply received source to tuition</p>{!managingSponsorship.studentId && <select required className={field} value={sponsorApply.studentId} onChange={(event) => { const studentId = event.target.value; setSponsorApply({ studentId, obligationId: '', sponsorshipReceiptId: '', amount: 0 }); void loadSponsorship(managingSponsorship, studentId).catch((error) => announce(error instanceof Error ? error.message : 'Could not load student obligations.', 'error')); }}><option value="">Choose student</option>{students.map((student) => <option key={student.id} value={student.id}>{student.fullName}</option>)}</select>}<select required className={field} value={sponsorApply.obligationId} onChange={(event) => setSponsorApply({ ...sponsorApply, obligationId: event.target.value })}><option value="">Choose outstanding term</option>{sponsorshipObligations.filter((obligation) => obligation.outstanding > 0).map((obligation) => <option key={obligation.id} value={obligation.id}>{obligation.semesterName} · {formatAFN(obligation.outstanding)} outstanding</option>)}</select><select required className={field} value={sponsorApply.sponsorshipReceiptId} onChange={(event) => setSponsorApply({ ...sponsorApply, sponsorshipReceiptId: event.target.value })}><option value="">Choose received source</option>{sponsorshipPosition.receipts.filter((receipt) => receipt.source.available > 0).map((receipt) => <option key={receipt.id} value={receipt.id}>{formatAFN(receipt.source.available)} available · {receipt.date}</option>)}</select><input required min={1} step={1} type="number" className={field} placeholder="Amount AFN" value={sponsorApply.amount || ''} onChange={(event) => setSponsorApply({ ...sponsorApply, amount: Number(event.target.value) })} /><button className={primary} disabled={!selectedAwardReceipt && sponsorshipPosition.receipts.length === 0}>Apply to tuition</button></form><div className="border-t border-slate-100 pt-4"><p className="mb-2 text-xs font-black text-slate-800">Lifecycle</p><p className="text-xs leading-5 text-slate-600">A terminal agreement returns every remaining receipt to its linked campaign as restricted funding. Without a campaign, a positive balance blocks termination.</p>{sponsorshipPosition.status === 'active' && <button className={`${secondary} mt-3`} onClick={() => { const reason = window.prompt('Reason for terminating this agreement (at least 8 characters)'); if (!reason) return; void run(async () => { await api.patch(`/funding/sponsorships/${managingSponsorship.id}`, { status: 'terminated', reason }); await Promise.all([loadSponsorship(managingSponsorship, sponsorApply.studentId), refreshFundingWorkspace()]); }, 'Sponsorship terminated with restricted campaign return.'); }}>Terminate agreement</button>}</div></div>}</Dialog>}

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      <p className="sr-only" aria-live="polite">Selected branch {activeBranchId}</p>
    </div>
  );
}
