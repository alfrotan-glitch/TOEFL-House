/**
 * @license SPDX-License-Identifier: Apache-2.0
 *
 * TOEFL House ERP — Funding & Development Treasury (BC #11)
 * --------------------------------------------------------------
 * A complete development-finance workspace: donors, funding campaigns,
 * donations, scholarships, and sponsorships. Opens on a live treasury
 * command band, then splits into five working tabs with full CRUD.
 *
 * Design notes:
 *  - Opens with the money (total raised, live pulse), not a generic header.
 *  - Tabular-monospace figures against Vazirmatn body type for a ledger feel.
 *  - Emerald = money in, amber = in-flight campaigns, rose = restricted funds.
 *  - Animated progress, hover lift, staggered tab reveals, live pulse.
 */
import React, { useState, useMemo } from 'react';
import {HandCoins, Users, Target, ReceiptText, GraduationCap, HeartHandshake, Plus, Search, Landmark, Building2, Globe2, User, Lock, Unlock, Calendar, Edit, X, Info, BadgeCheck} from 'lucide-react';
import {Donor, FundingCampaign, Donation, Scholarship, ScholarshipAward, SponsorshipAgreement, Student, UserRole} from '../../types';
import Toast from '../common/Toast';
import { ShamsiDateInput } from '../common/ShamsiDateInput';

// ============================================================================
// Props
// ============================================================================
interface FundingViewProps {
  donors: Donor[];
  campaigns: FundingCampaign[];
  donations: Donation[];
  scholarships: Scholarship[];
  scholarshipAwards: ScholarshipAward[];
  sponsorships: SponsorshipAgreement[];
  students: Student[];
  activeRole: UserRole;
  addDonor: (data: Partial<Donor>) => void | Promise<void>;
  editDonor: (id: string, data: Partial<Donor>) => void | Promise<void>;
  addFundingCampaign: (data: Partial<FundingCampaign>) => void | Promise<void>;
  recordDonation: (data: Partial<Donation>) => void | Promise<void>;
  addScholarship: (data: Partial<Scholarship>) => void | Promise<void>;
  awardScholarship: (data: Partial<ScholarshipAward>) => void | Promise<void>;
  addSponsorship: (data: Partial<SponsorshipAgreement>) => void | Promise<void>;
}

type FundingTab = 'donors' | 'campaigns' | 'donations' | 'scholarships' | 'sponsorships';

// ============================================================================
// Presentation metadata
// ============================================================================
const DONOR_TYPE_META: Record<Donor['type'], { label: string; icon: React.ElementType; cls: string }> = {
  individual:   { label: 'Individual',   icon: User,       cls: 'bg-sky-50 text-sky-700 border-sky-200' },
  organization: { label: 'Organization', icon: Building2,  cls: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
  ngo:          { label: 'NGO',          icon: Globe2,     cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  government:   { label: 'Government',   icon: Landmark,   cls: 'bg-amber-50 text-amber-700 border-amber-200' },
};

const fmt = (n: number) => `${(n ?? 0).toLocaleString('en-US')} AFN`;

// ============================================================================
// Small presentational pieces
// ============================================================================
function DonorTypeBadge({ type }: { type: Donor['type'] }) {
  const meta = DONOR_TYPE_META[type] || DONOR_TYPE_META.individual;
  const Icon = meta.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold border ${meta.cls}`}>
      <Icon className="w-3 h-3" /> {meta.label}
    </span>
  );
}

function RestrictedBadge({ restricted }: { restricted: boolean }) {
  return restricted ? (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold bg-rose-50 text-rose-700 border border-rose-200">
      <Lock className="w-3 h-3" /> Restricted
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
      <Unlock className="w-3 h-3" /> Unrestricted
    </span>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    active: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    completed: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    cancelled: 'bg-slate-100 text-slate-500 border-slate-200',
    exhausted: 'bg-amber-50 text-amber-700 border-amber-200',
    closed: 'bg-slate-100 text-slate-500 border-slate-200',
    terminated: 'bg-rose-50 text-rose-700 border-rose-200',
  };
  return (
    <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold border ${map[status] || map.active}`}>
      {status}
    </span>
  );
}

/** Animated goal-progress bar with a shimmering head while in flight. */
function GoalBar({ raised, target }: { raised: number; target: number }) {
  const pct = target > 0 ? Math.min(100, Math.round((raised / target) * 100)) : 0;
  const done = pct >= 100;
  return (
    <div className="space-y-1.5">
      <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ease-out ${done ? 'bg-emerald-500' : 'bg-gradient-to-l from-amber-500 to-amber-400'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex justify-between text-[10px] font-mono text-slate-400">
        <span>{fmt(raised)}</span>
        <span className={done ? 'text-emerald-600 font-bold' : ''}>{pct}% of {fmt(target)}</span>
      </div>
    </div>
  );
}

/** Generic modal shell. */
function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 bg-slate-900/45 backdrop-blur-xs flex items-center justify-center p-4 z-50 overflow-y-auto animate-in fade-in duration-200">
      <div className="bg-white border border-slate-200 rounded-2xl shadow-2xl w-full max-w-lg my-8 animate-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h3 className="font-extrabold text-slate-900 text-sm">{title}</h3>
          <button onClick={onClose} className="p-1.5 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-slate-600 transition-colors cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

const inputCls = 'w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500/15 focus:bg-white transition-colors';
const labelCls = 'block text-slate-600 font-bold mb-1 text-[11px]';

// ============================================================================
// Main component
// ============================================================================
export default function FundingView({
  donors, campaigns, donations, scholarships, scholarshipAwards, sponsorships, students,
  activeRole, addDonor, editDonor, addFundingCampaign, recordDonation, addScholarship,
  awardScholarship, addSponsorship,
}: FundingViewProps) {
  const canManage = ['owner', 'manager', 'donor_manager'].includes(activeRole);

  const [tab, setTab] = useState<FundingTab>('donors');
  const [searchQuery, setSearchQuery] = useState('');
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const notify = (message: string, type: 'success' | 'error' | 'info' = 'success') => setToast({ message, type });

  // ---- Modal + form state ----
  const [showDonorModal, setShowDonorModal] = useState(false);
  const [editingDonor, setEditingDonor] = useState<Donor | null>(null);
  const [donorForm, setDonorForm] = useState({ fullName: '', type: 'individual' as Donor['type'], email: '', phone: '', country: '', notes: '' });

  const [showCampaignModal, setShowCampaignModal] = useState(false);
  const [campaignForm, setCampaignForm] = useState({ name: '', donorId: '', targetAmount: 0, startDate: '', endDate: '', description: '' });

  const [showDonationModal, setShowDonationModal] = useState(false);
  const [donationForm, setDonationForm] = useState({ donorId: '', campaignId: '', amount: 0, restricted: false, restrictionNote: '', date: '' });

  const [showScholarshipModal, setShowScholarshipModal] = useState(false);
  const [scholarshipForm, setScholarshipForm] = useState({ name: '', donorId: '', totalBudget: 0, criteria: '' });

  const [awardingScholarship, setAwardingScholarship] = useState<Scholarship | null>(null);
  const [awardForm, setAwardForm] = useState({ studentId: '', amount: 0, semester: '', notes: '' });

  const [showSponsorshipModal, setShowSponsorshipModal] = useState(false);
  const [sponsorshipForm, setSponsorshipForm] = useState({ donorId: '', studentId: '', monthlyAmount: 0, startDate: '', endDate: '' });

  // ---- Derived treasury metrics ----
  const treasury = useMemo(() => {
    const totalRaised = donations.reduce((s, d) => s + d.amount, 0);
    const restricted = donations.filter((d) => d.restricted).reduce((s, d) => s + d.amount, 0);
    const campaignTarget = campaigns.reduce((s, c) => s + c.targetAmount, 0);
    const campaignRaised = campaigns.reduce((s, c) => s + c.raisedAmount, 0);
    const scholarshipBudget = scholarships.reduce((s, x) => s + x.totalBudget, 0);
    const scholarshipAllocated = scholarships.reduce((s, x) => s + x.allocatedAmount, 0);
    return {
      totalRaised, restricted,
      unrestricted: totalRaised - restricted,
      campaignTarget, campaignRaised,
      campaignPct: campaignTarget > 0 ? Math.round((campaignRaised / campaignTarget) * 100) : 0,
      scholarshipBudget, scholarshipAllocated,
      scholarshipPct: scholarshipBudget > 0 ? Math.round((scholarshipAllocated / scholarshipBudget) * 100) : 0,
      activeCampaigns: campaigns.filter((c) => c.status === 'active').length,
      activeSponsorships: sponsorships.filter((s) => s.status === 'active').length,
    };
  }, [donations, campaigns, scholarships, sponsorships]);

  const donorName = (id?: string) => donors.find((d) => d.id === id)?.fullName || '—';
  const studentName = (id?: string) => students.find((s) => s.id === id)?.fullName || '—';
  const donatedBy = (donorId: string) => donations.filter((d) => d.donorId === donorId).reduce((s, d) => s + d.amount, 0);

  const filteredDonors = donors.filter((d) =>
    d.fullName.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (d.email || '').toLowerCase().includes(searchQuery.toLowerCase())
  );

  // ---- Handlers ----
  const openAddDonor = () => {
    setEditingDonor(null);
    setDonorForm({ fullName: '', type: 'individual', email: '', phone: '', country: '', notes: '' });
    setShowDonorModal(true);
  };
  const openEditDonor = (d: Donor) => {
    setEditingDonor(d);
    setDonorForm({ fullName: d.fullName, type: d.type, email: d.email || '', phone: d.phone || '', country: d.country || '', notes: d.notes || '' });
    setShowDonorModal(true);
  };
  const submitDonor = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!donorForm.fullName.trim()) return notify('Donor name is required.', 'error');
    try {
      if (editingDonor) {
        await editDonor(editingDonor.id, { ...donorForm });
        notify('Donor profile updated.');
      } else {
        await addDonor({ ...donorForm });
        notify('Donor registered successfully.');
      }
      setShowDonorModal(false);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to save donor.', 'error');
    }
  };

  const submitCampaign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!campaignForm.name.trim() || campaignForm.targetAmount <= 0) return notify('Campaign name and a positive target are required.', 'error');
    try {
      await addFundingCampaign({
        name: campaignForm.name, donorId: campaignForm.donorId || undefined, targetAmount: campaignForm.targetAmount,
        startDate: campaignForm.startDate || new Date().toISOString().split('T')[0], endDate: campaignForm.endDate || undefined,
        description: campaignForm.description || undefined,
      });
      notify('Funding campaign created.');
      setShowCampaignModal(false);
      setCampaignForm({ name: '', donorId: '', targetAmount: 0, startDate: '', endDate: '', description: '' });
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to create campaign.', 'error');
    }
  };

  const submitDonation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!donationForm.donorId || donationForm.amount <= 0) return notify('Select a donor and enter a positive amount.', 'error');
    try {
      await recordDonation({
        donorId: donationForm.donorId, campaignId: donationForm.campaignId || undefined, amount: donationForm.amount,
        restricted: donationForm.restricted, restrictionNote: donationForm.restrictionNote || undefined,
        date: donationForm.date || new Date().toISOString().split('T')[0],
      });
      notify('Donation recorded and posted to the ledger.');
      setShowDonationModal(false);
      setDonationForm({ donorId: '', campaignId: '', amount: 0, restricted: false, restrictionNote: '', date: '' });
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to record donation.', 'error');
    }
  };

  const submitScholarship = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!scholarshipForm.name.trim() || scholarshipForm.totalBudget <= 0) return notify('Scholarship name and budget are required.', 'error');
    try {
      await addScholarship({ name: scholarshipForm.name, donorId: scholarshipForm.donorId || undefined, totalBudget: scholarshipForm.totalBudget, criteria: scholarshipForm.criteria || undefined });
      notify('Scholarship fund created.');
      setShowScholarshipModal(false);
      setScholarshipForm({ name: '', donorId: '', totalBudget: 0, criteria: '' });
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to create scholarship.', 'error');
    }
  };

  const submitAward = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!awardingScholarship || !awardForm.studentId || awardForm.amount <= 0) return notify('Select a student and enter an amount.', 'error');
    const remaining = awardingScholarship.totalBudget - awardingScholarship.allocatedAmount;
    if (awardForm.amount > remaining) return notify(`Exceeds remaining budget (${fmt(remaining)}).`, 'error');
    try {
      await awardScholarship({ scholarshipId: awardingScholarship.id, studentId: awardForm.studentId, amount: awardForm.amount, semester: awardForm.semester || undefined, notes: awardForm.notes || undefined });
      notify('Scholarship awarded to student.');
      setAwardingScholarship(null);
      setAwardForm({ studentId: '', amount: 0, semester: '', notes: '' });
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to award scholarship.', 'error');
    }
  };

  const submitSponsorship = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sponsorshipForm.donorId || sponsorshipForm.monthlyAmount <= 0) return notify('Select a donor and enter a monthly amount.', 'error');
    try {
      await addSponsorship({
        donorId: sponsorshipForm.donorId, studentId: sponsorshipForm.studentId || undefined, monthlyAmount: sponsorshipForm.monthlyAmount,
        startDate: sponsorshipForm.startDate || new Date().toISOString().split('T')[0], endDate: sponsorshipForm.endDate || undefined,
      });
      notify('Sponsorship agreement created.');
      setShowSponsorshipModal(false);
      setSponsorshipForm({ donorId: '', studentId: '', monthlyAmount: 0, startDate: '', endDate: '' });
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to create sponsorship.', 'error');
    }
  };

  const TABS: { id: FundingTab; label: string; icon: React.ElementType; count: number }[] = [
    { id: 'donors', label: 'Donors', icon: Users, count: donors.length },
    { id: 'campaigns', label: 'Campaigns', icon: Target, count: campaigns.length },
    { id: 'donations', label: 'Donations', icon: ReceiptText, count: donations.length },
    { id: 'scholarships', label: 'Scholarships', icon: GraduationCap, count: scholarships.length },
    { id: 'sponsorships', label: 'Sponsorships', icon: HeartHandshake, count: sponsorships.length },
  ];

  return (
    <div className="space-y-6 font-sans text-left" dir="ltr" id="funding-view-root">
      {/* ============ Treasury Command Band (distinctive opening) ============ */}
      <div className="relative overflow-hidden rounded-2xl bg-slate-900 text-white">
        {/* layered ledger-line texture + soft glow, not blobs */}
        <div
          className="absolute inset-0 opacity-[0.06] pointer-events-none"
          style={{ backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 27px, #fff 28px)' }}
        />
        <div className="absolute -top-24 -left-24 w-72 h-72 bg-emerald-500/15 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -bottom-32 -right-16 w-80 h-80 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />

        <div className="relative px-6 py-6 md:px-8 md:py-7 flex flex-col lg:flex-row lg:items-end lg:justify-between gap-6">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/10 border border-white/15 text-[10px] font-bold tracking-widest uppercase">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> Live Development Ledger
              </span>
              <span className="text-[10px] text-slate-400 font-semibold tracking-wider uppercase">BC #11 · Funding</span>
            </div>
            <h2 className="text-2xl md:text-3xl font-black tracking-tight flex items-center gap-2.5">
      {donors.length === 0 && campaigns.length === 0 && donations.length === 0 && (
        <div className="rounded-2xl border border-dashed border-emerald-200 bg-emerald-50/40 px-5 py-8 text-center text-xs text-slate-600">
          <p className="font-extrabold text-sm text-slate-900">Funding is empty</p>
          <p className="mt-1 max-w-lg mx-auto text-slate-500">
            Add real donors and campaigns when you have them. No demo data is loaded — your fundraising ledger starts at zero.
          </p>
        </div>
      )}
              <HandCoins className="w-7 h-7 text-amber-400" />
              Funding &amp; Development Treasury
            </h2>
            <p className="text-xs text-slate-400 max-w-xl leading-relaxed">
              Donor relations, capital campaigns, restricted grants, scholarships, and sponsorships —
              every afghani tracked from pledge to student impact.
            </p>
          </div>

          {/* Hero metric + inline supporting strip (not equal cards) */}
          <div className="flex flex-col sm:flex-row sm:items-end gap-6 sm:gap-8">
            <div>
              <p className="text-[10px] font-bold tracking-widest uppercase text-slate-400">Total Capital Raised</p>
              <p className="text-4xl md:text-5xl font-black font-mono tabular-nums text-emerald-400 leading-none mt-1">
                {treasury.totalRaised.toLocaleString('en-US')}
                <span className="text-base font-bold text-slate-500 ml-1.5">AFN</span>
              </p>
            </div>
            <div className="flex items-center gap-6 sm:gap-7 sm:border-l sm:border-white/15 sm:pl-8">
              <div>
                <p className="text-[10px] font-bold tracking-widest uppercase text-slate-400">Donors</p>
                <p className="text-2xl font-black font-mono tabular-nums mt-0.5">{donors.length}</p>
              </div>
              <div>
                <p className="text-[10px] font-bold tracking-widest uppercase text-slate-400">Active Campaigns</p>
                <p className="text-2xl font-black font-mono tabular-nums mt-0.5">{treasury.activeCampaigns}</p>
              </div>
              <div>
                <p className="text-[10px] font-bold tracking-widest uppercase text-slate-400">Restricted</p>
                <p className="text-2xl font-black font-mono tabular-nums text-amber-400 mt-0.5">{treasury.restricted.toLocaleString('en-US')}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Capital allocation strip */}
        <div className="relative border-t border-white/10 px-6 md:px-8 py-4 grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-4">
          <div>
            <div className="flex justify-between text-[11px] font-bold mb-1.5">
              <span className="text-slate-300">Campaign progress → {fmt(treasury.campaignRaised)} of {fmt(treasury.campaignTarget)}</span>
              <span className="text-amber-400 font-mono">{treasury.campaignPct}%</span>
            </div>
            <div className="w-full bg-white/10 rounded-full h-2 overflow-hidden">
              <div className="h-full rounded-full bg-gradient-to-l from-amber-500 to-amber-400 transition-all duration-700" style={{ width: `${treasury.campaignPct}%` }} />
            </div>
          </div>
          <div>
            <div className="flex justify-between text-[11px] font-bold mb-1.5">
              <span className="text-slate-300">Scholarship allocation → {fmt(treasury.scholarshipAllocated)} of {fmt(treasury.scholarshipBudget)}</span>
              <span className="text-emerald-400 font-mono">{treasury.scholarshipPct}%</span>
            </div>
            <div className="w-full bg-white/10 rounded-full h-2 overflow-hidden">
              <div className="h-full rounded-full bg-gradient-to-l from-emerald-500 to-emerald-400 transition-all duration-700" style={{ width: `${treasury.scholarshipPct}%` }} />
            </div>
          </div>
        </div>
      </div>

      {/* ============ Tab navigation + primary actions ============ */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div className="flex flex-wrap gap-1 bg-white border border-slate-200 rounded-xl p-1 shadow-xs w-fit">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  active ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
                }`}
              >
                <Icon className="w-3.5 h-3.5" /> {t.label}
                <span className={`font-mono text-[10px] px-1.5 py-0.5 rounded-full ${active ? 'bg-white/20' : 'bg-slate-100 text-slate-500'}`}>{t.count}</span>
              </button>
            );
          })}
        </div>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            {tab === 'donors' && (
              <button onClick={openAddDonor} className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold px-4 py-2.5 rounded-xl cursor-pointer shadow-sm transition-all hover:-translate-y-0.5">
                <Plus className="w-4 h-4" /> New Donor
              </button>
            )}
            {tab === 'campaigns' && (
              <button onClick={() => setShowCampaignModal(true)} className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold px-4 py-2.5 rounded-xl cursor-pointer shadow-sm transition-all hover:-translate-y-0.5">
                <Plus className="w-4 h-4" /> New Campaign
              </button>
            )}
            {tab === 'donations' && (
              <button onClick={() => setShowDonationModal(true)} className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold px-4 py-2.5 rounded-xl cursor-pointer shadow-sm transition-all hover:-translate-y-0.5">
                <Plus className="w-4 h-4" /> Record Donation
              </button>
            )}
            {tab === 'scholarships' && (
              <button onClick={() => setShowScholarshipModal(true)} className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold px-4 py-2.5 rounded-xl cursor-pointer shadow-sm transition-all hover:-translate-y-0.5">
                <Plus className="w-4 h-4" /> New Scholarship
              </button>
            )}
            {tab === 'sponsorships' && (
              <button onClick={() => setShowSponsorshipModal(true)} className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold px-4 py-2.5 rounded-xl cursor-pointer shadow-sm transition-all hover:-translate-y-0.5">
                <Plus className="w-4 h-4" /> New Sponsorship
              </button>
            )}
          </div>
        )}
      </div>

      {/* ============ DONORS ============ */}
      {tab === 'donors' && (
        <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-3">
            <h3 className="text-sm font-extrabold text-slate-900 flex items-center gap-1.5">
              <Users className="w-5 h-5 text-emerald-600" /> Donor Registry
            </h3>
            <div className="relative w-full sm:w-64">
              <input
                type="text"
                placeholder="Search donors by name or email…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-3 pr-9 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500/10 font-semibold"
              />
              <Search className="w-4 h-4 text-slate-400 absolute right-3 top-2.5" />
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-100 text-slate-500 font-bold">
                  <th className="py-2.5 px-3 text-slate-700">Donor</th>
                  <th className="py-2.5 px-3 text-slate-700">Type</th>
                  <th className="py-2.5 px-3 text-slate-700">Contact</th>
                  <th className="py-2.5 px-3 text-slate-700">Total Donated</th>
                  {canManage && <th className="py-2.5 px-3 text-slate-700 text-left">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50 text-slate-600">
                {filteredDonors.length === 0 ? (
                  <tr><td colSpan={canManage ? 5 : 4} className="text-center py-10 text-slate-400">No donors match your search.</td></tr>
                ) : (
                  filteredDonors.map((d) => (
                    <tr key={d.id} className="hover:bg-emerald-50/30 transition-colors">
                      <td className="py-3 px-3">
                        <p className="font-extrabold text-slate-800">{d.fullName}</p>
                        {d.country && <p className="text-[10px] text-slate-400 mt-0.5">{d.country}</p>}
                      </td>
                      <td className="py-3 px-3"><DonorTypeBadge type={d.type} /></td>
                      <td className="py-3 px-3">
                        <p className="font-mono text-slate-600">{d.phone || '—'}</p>
                        <p className="text-[10px] text-slate-400 font-mono">{d.email || ''}</p>
                      </td>
                      <td className="py-3 px-3">
                        <span className="font-black font-mono tabular-nums text-emerald-700">{fmt(donatedBy(d.id))}</span>
                      </td>
                      {canManage && (
                        <td className="py-3 px-3 text-left">
                          <button onClick={() => openEditDonor(d)} className="p-1.5 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-indigo-600 cursor-pointer transition-colors" title="Edit donor">
                            <Edit className="w-4 h-4" />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ============ CAMPAIGNS ============ */}
      {tab === 'campaigns' && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
          {campaigns.length === 0 ? (
            <div className="col-span-full bg-white border border-slate-200 rounded-2xl p-12 text-center text-slate-400 text-xs">
              No funding campaigns defined yet.
            </div>
          ) : (
            campaigns.map((c) => (
              <div key={c.id} className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all duration-200 flex flex-col justify-between gap-4">
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <h4 className="font-extrabold text-slate-900 text-sm leading-snug">{c.name}</h4>
                    <StatusPill status={c.status} />
                  </div>
                  {c.description && <p className="text-[11px] text-slate-500 leading-relaxed line-clamp-2">{c.description}</p>}
                  <div className="flex items-center gap-1.5 text-[10px] text-slate-400 font-mono">
                    <Calendar className="w-3.5 h-3.5" /> {c.startDate} → {c.endDate || 'ongoing'}
                  </div>
                  {c.donorId && (
                    <p className="text-[10px] text-slate-500">Lead donor: <span className="font-bold text-slate-700">{donorName(c.donorId)}</span></p>
                  )}
                </div>
                <GoalBar raised={c.raisedAmount} target={c.targetAmount} />
              </div>
            ))
          )}
        </div>
      )}

      {/* ============ DONATIONS ============ */}
      {tab === 'donations' && (
        <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
          <h3 className="text-sm font-extrabold text-slate-900 flex items-center gap-1.5 border-b border-slate-100 pb-3">
            <ReceiptText className="w-5 h-5 text-emerald-600" /> Donation Ledger
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-100 text-slate-500 font-bold">
                  <th className="py-2.5 px-3 text-slate-700">Receipt</th>
                  <th className="py-2.5 px-3 text-slate-700">Donor</th>
                  <th className="py-2.5 px-3 text-slate-700">Campaign</th>
                  <th className="py-2.5 px-3 text-slate-700">Restriction</th>
                  <th className="py-2.5 px-3 text-slate-700">Date</th>
                  <th className="py-2.5 px-3 text-slate-700 text-left">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50 text-slate-600">
                {donations.length === 0 ? (
                  <tr><td colSpan={6} className="text-center py-10 text-slate-400">No donations recorded yet.</td></tr>
                ) : (
                  donations.map((dn) => (
                    <tr key={dn.id} className="hover:bg-emerald-50/30 transition-colors">
                      <td className="py-3 px-3 font-mono text-slate-400">{dn.receiptNo}</td>
                      <td className="py-3 px-3 font-bold text-slate-800">{donorName(dn.donorId)}</td>
                      <td className="py-3 px-3 text-slate-500">{campaigns.find((c) => c.id === dn.campaignId)?.name || 'General fund'}</td>
                      <td className="py-3 px-3"><RestrictedBadge restricted={dn.restricted} /></td>
                      <td className="py-3 px-3 font-mono text-slate-400">{dn.date}</td>
                      <td className="py-3 px-3 text-left">
                        <span className="font-black font-mono tabular-nums text-emerald-700">+{dn.amount.toLocaleString('en-US')}</span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ============ SCHOLARSHIPS ============ */}
      {tab === 'scholarships' && (
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {scholarships.length === 0 ? (
              <div className="col-span-full bg-white border border-slate-200 rounded-2xl p-12 text-center text-slate-400 text-xs">
                No scholarship funds yet.
              </div>
            ) : (
              scholarships.map((sc) => {
                const remaining = sc.totalBudget - sc.allocatedAmount;
                return (
                  <div key={sc.id} className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm hover:shadow-md transition-shadow flex flex-col justify-between gap-4">
                    <div className="space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <h4 className="font-extrabold text-slate-900 text-sm flex items-center gap-1.5">
                          <GraduationCap className="w-4 h-4 text-indigo-600" /> {sc.name}
                        </h4>
                        <StatusPill status={sc.status} />
                      </div>
                      {sc.criteria && <p className="text-[11px] text-slate-500 leading-relaxed line-clamp-2">{sc.criteria}</p>}
                      {sc.donorId && <p className="text-[10px] text-slate-500">Funded by <span className="font-bold text-slate-700">{donorName(sc.donorId)}</span></p>}
                    </div>
                    <div className="space-y-2">
                      <GoalBar raised={sc.allocatedAmount} target={sc.totalBudget} />
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-slate-400 font-mono">{fmt(remaining)} remaining</span>
                        {canManage && sc.status === 'active' && (
                          <button
                            onClick={() => { setAwardingScholarship(sc); setAwardForm({ studentId: '', amount: 0, semester: '', notes: '' }); }}
                            className="flex items-center gap-1 text-[11px] font-bold text-indigo-700 hover:text-indigo-900 hover:bg-indigo-50 px-2.5 py-1.5 rounded-lg transition-colors cursor-pointer"
                          >
                            <BadgeCheck className="w-3.5 h-3.5" /> Award Student
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Awards list */}
          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-3">
            <h3 className="text-sm font-extrabold text-slate-900 flex items-center gap-1.5 border-b border-slate-100 pb-2.5">
              <BadgeCheck className="w-5 h-5 text-indigo-600" /> Scholarship Awards
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-100 text-slate-500 font-bold">
                    <th className="py-2.5 px-3 text-slate-700">Student</th>
                    <th className="py-2.5 px-3 text-slate-700">Scholarship</th>
                    <th className="py-2.5 px-3 text-slate-700">Semester</th>
                    <th className="py-2.5 px-3 text-slate-700">Award Date</th>
                    <th className="py-2.5 px-3 text-slate-700 text-left">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50 text-slate-600">
                  {scholarshipAwards.length === 0 ? (
                    <tr><td colSpan={5} className="text-center py-8 text-slate-400">No awards issued yet.</td></tr>
                  ) : (
                    scholarshipAwards.map((a) => (
                      <tr key={a.id} className="hover:bg-indigo-50/30 transition-colors">
                        <td className="py-3 px-3 font-bold text-slate-800">{studentName(a.studentId)}</td>
                        <td className="py-3 px-3 text-slate-500">{scholarships.find((s) => s.id === a.scholarshipId)?.name || '—'}</td>
                        <td className="py-3 px-3 text-slate-500">{a.semester || '—'}</td>
                        <td className="py-3 px-3 font-mono text-slate-400">{a.awardDate}</td>
                        <td className="py-3 px-3 text-left font-black font-mono tabular-nums text-indigo-700">{fmt(a.amount)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ============ SPONSORSHIPS ============ */}
      {tab === 'sponsorships' && (
        <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
          <h3 className="text-sm font-extrabold text-slate-900 flex items-center gap-1.5 border-b border-slate-100 pb-3">
            <HeartHandshake className="w-5 h-5 text-emerald-600" /> Sponsorship Agreements
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-100 text-slate-500 font-bold">
                  <th className="py-2.5 px-3 text-slate-700">Sponsor</th>
                  <th className="py-2.5 px-3 text-slate-700">Sponsored Student</th>
                  <th className="py-2.5 px-3 text-slate-700">Monthly</th>
                  <th className="py-2.5 px-3 text-slate-700">Term</th>
                  <th className="py-2.5 px-3 text-slate-700">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50 text-slate-600">
                {sponsorships.length === 0 ? (
                  <tr><td colSpan={5} className="text-center py-10 text-slate-400">No sponsorship agreements yet.</td></tr>
                ) : (
                  sponsorships.map((sp) => (
                    <tr key={sp.id} className="hover:bg-emerald-50/30 transition-colors">
                      <td className="py-3 px-3 font-bold text-slate-800">{donorName(sp.donorId)}</td>
                      <td className="py-3 px-3 text-slate-500">{sp.studentId ? studentName(sp.studentId) : '—'}</td>
                      <td className="py-3 px-3 font-black font-mono tabular-nums text-emerald-700">{fmt(sp.monthlyAmount)}</td>
                      <td className="py-3 px-3 font-mono text-slate-400">{sp.startDate} → {sp.endDate}</td>
                      <td className="py-3 px-3"><StatusPill status={sp.status} /></td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ============ MODALS ============ */}
      {showDonorModal && (
        <ModalShell title={editingDonor ? 'Edit Donor' : 'Register New Donor'} onClose={() => setShowDonorModal(false)}>
          <form onSubmit={submitDonor} className="space-y-3.5 text-xs">
            <div><label className={labelCls}>Full Name *</label>
              <input className={inputCls} value={donorForm.fullName} onChange={(e) => setDonorForm({ ...donorForm, fullName: e.target.value })} required /></div>
            <div><label className={labelCls}>Donor Type</label>
              <select className={inputCls} value={donorForm.type} onChange={(e) => setDonorForm({ ...donorForm, type: e.target.value as Donor['type'] })}>
                <option value="individual">Individual</option><option value="organization">Organization</option>
                <option value="ngo">NGO</option><option value="government">Government</option>
              </select></div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className={labelCls}>Email</label><input type="email" className={inputCls} value={donorForm.email} onChange={(e) => setDonorForm({ ...donorForm, email: e.target.value })} /></div>
              <div><label className={labelCls}>Phone</label><input className={inputCls} value={donorForm.phone} onChange={(e) => setDonorForm({ ...donorForm, phone: e.target.value })} /></div>
            </div>
            <div><label className={labelCls}>Country</label><input className={inputCls} value={donorForm.country} onChange={(e) => setDonorForm({ ...donorForm, country: e.target.value })} /></div>
            <div><label className={labelCls}>Notes</label><textarea className={inputCls} rows={2} value={donorForm.notes} onChange={(e) => setDonorForm({ ...donorForm, notes: e.target.value })} /></div>
            <button type="submit" className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-2.5 rounded-lg cursor-pointer transition-colors shadow-sm">
              {editingDonor ? 'Save Changes' : 'Register Donor'}
            </button>
          </form>
        </ModalShell>
      )}

      {showCampaignModal && (
        <ModalShell title="Create Funding Campaign" onClose={() => setShowCampaignModal(false)}>
          <form onSubmit={submitCampaign} className="space-y-3.5 text-xs">
            <div><label className={labelCls}>Campaign Name *</label>
              <input className={inputCls} value={campaignForm.name} onChange={(e) => setCampaignForm({ ...campaignForm, name: e.target.value })} required /></div>
            <div><label className={labelCls}>Lead Donor (optional)</label>
              <select className={inputCls} value={campaignForm.donorId} onChange={(e) => setCampaignForm({ ...campaignForm, donorId: e.target.value })}>
                <option value="">— None —</option>
                {donors.map((d) => <option key={d.id} value={d.id}>{d.fullName}</option>)}
              </select></div>
            <div><label className={labelCls}>Target Amount (AFN) *</label>
              <input type="number" min={1} className={inputCls} value={campaignForm.targetAmount || ''} onChange={(e) => setCampaignForm({ ...campaignForm, targetAmount: Number(e.target.value) })} required /></div>
            <div className="grid grid-cols-2 gap-3">
              <ShamsiDateInput label="Start Date" value={campaignForm.startDate} onChange={(v) => setCampaignForm({ ...campaignForm, startDate: v })} />
              <ShamsiDateInput label="End Date" value={campaignForm.endDate} onChange={(v) => setCampaignForm({ ...campaignForm, endDate: v })} />
            </div>
            <div><label className={labelCls}>Description</label><textarea className={inputCls} rows={2} value={campaignForm.description} onChange={(e) => setCampaignForm({ ...campaignForm, description: e.target.value })} /></div>
            <button type="submit" className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-2.5 rounded-lg cursor-pointer transition-colors shadow-sm">Create Campaign</button>
          </form>
        </ModalShell>
      )}

      {showDonationModal && (
        <ModalShell title="Record Donation" onClose={() => setShowDonationModal(false)}>
          <form onSubmit={submitDonation} className="space-y-3.5 text-xs">
            <div><label className={labelCls}>Donor *</label>
              <select className={inputCls} value={donationForm.donorId} onChange={(e) => setDonationForm({ ...donationForm, donorId: e.target.value })} required>
                <option value="">Select donor…</option>
                {donors.map((d) => <option key={d.id} value={d.id}>{d.fullName}</option>)}
              </select></div>
            <div><label className={labelCls}>Campaign (optional)</label>
              <select className={inputCls} value={donationForm.campaignId} onChange={(e) => setDonationForm({ ...donationForm, campaignId: e.target.value })}>
                <option value="">— General fund —</option>
                {campaigns.filter((c) => c.status === 'active').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className={labelCls}>Amount (AFN) *</label>
                <input type="number" min={1} className={inputCls} value={donationForm.amount || ''} onChange={(e) => setDonationForm({ ...donationForm, amount: Number(e.target.value) })} required /></div>
              <ShamsiDateInput label="Date" value={donationForm.date} onChange={(v) => setDonationForm({ ...donationForm, date: v })} />
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={donationForm.restricted} onChange={(e) => setDonationForm({ ...donationForm, restricted: e.target.checked })} className="w-4 h-4 accent-emerald-600 rounded" />
              <span className="font-bold text-slate-700">Restricted grant</span>
            </label>
            {donationForm.restricted && (
              <div><label className={labelCls}>Restriction Note</label>
                <input className={inputCls} value={donationForm.restrictionNote} onChange={(e) => setDonationForm({ ...donationForm, restrictionNote: e.target.value })} placeholder="e.g. Female students only" /></div>
            )}
            <button type="submit" className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-2.5 rounded-lg cursor-pointer transition-colors shadow-sm">Record Donation</button>
          </form>
        </ModalShell>
      )}

      {showScholarshipModal && (
        <ModalShell title="Create Scholarship Fund" onClose={() => setShowScholarshipModal(false)}>
          <form onSubmit={submitScholarship} className="space-y-3.5 text-xs">
            <div><label className={labelCls}>Scholarship Name *</label>
              <input className={inputCls} value={scholarshipForm.name} onChange={(e) => setScholarshipForm({ ...scholarshipForm, name: e.target.value })} required /></div>
            <div><label className={labelCls}>Funding Donor (optional)</label>
              <select className={inputCls} value={scholarshipForm.donorId} onChange={(e) => setScholarshipForm({ ...scholarshipForm, donorId: e.target.value })}>
                <option value="">— None —</option>
                {donors.map((d) => <option key={d.id} value={d.id}>{d.fullName}</option>)}
              </select></div>
            <div><label className={labelCls}>Total Budget (AFN) *</label>
              <input type="number" min={1} className={inputCls} value={scholarshipForm.totalBudget || ''} onChange={(e) => setScholarshipForm({ ...scholarshipForm, totalBudget: Number(e.target.value) })} required /></div>
            <div><label className={labelCls}>Eligibility Criteria</label>
              <textarea className={inputCls} rows={2} value={scholarshipForm.criteria} onChange={(e) => setScholarshipForm({ ...scholarshipForm, criteria: e.target.value })} /></div>
            <button type="submit" className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-2.5 rounded-lg cursor-pointer transition-colors shadow-sm">Create Scholarship</button>
          </form>
        </ModalShell>
      )}

      {awardingScholarship && (
        <ModalShell title={`Award — ${awardingScholarship.name}`} onClose={() => setAwardingScholarship(null)}>
          <div className="bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2.5 text-[11px] text-emerald-800 font-semibold mb-4 flex items-center gap-2">
            <Info className="w-4 h-4 shrink-0" />
            Remaining budget: {fmt(awardingScholarship.totalBudget - awardingScholarship.allocatedAmount)}
          </div>
          <form onSubmit={submitAward} className="space-y-3.5 text-xs">
            <div><label className={labelCls}>Student *</label>
              <select className={inputCls} value={awardForm.studentId} onChange={(e) => setAwardForm({ ...awardForm, studentId: e.target.value })} required>
                <option value="">Select student…</option>
                {students.map((s) => <option key={s.id} value={s.id}>{s.fullName} ({s.studentCode})</option>)}
              </select></div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className={labelCls}>Amount (AFN) *</label>
                <input type="number" min={1} className={inputCls} value={awardForm.amount || ''} onChange={(e) => setAwardForm({ ...awardForm, amount: Number(e.target.value) })} required /></div>
              <div><label className={labelCls}>Semester</label>
                <input className={inputCls} value={awardForm.semester} onChange={(e) => setAwardForm({ ...awardForm, semester: e.target.value })} placeholder="e.g. Fall 1405" /></div>
            </div>
            <div><label className={labelCls}>Notes</label>
              <input className={inputCls} value={awardForm.notes} onChange={(e) => setAwardForm({ ...awardForm, notes: e.target.value })} /></div>
            <button type="submit" className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2.5 rounded-lg cursor-pointer transition-colors shadow-sm">Award Scholarship</button>
          </form>
        </ModalShell>
      )}

      {showSponsorshipModal && (
        <ModalShell title="Create Sponsorship Agreement" onClose={() => setShowSponsorshipModal(false)}>
          <form onSubmit={submitSponsorship} className="space-y-3.5 text-xs">
            <div><label className={labelCls}>Sponsor (Donor) *</label>
              <select className={inputCls} value={sponsorshipForm.donorId} onChange={(e) => setSponsorshipForm({ ...sponsorshipForm, donorId: e.target.value })} required>
                <option value="">Select donor…</option>
                {donors.map((d) => <option key={d.id} value={d.id}>{d.fullName}</option>)}
              </select></div>
            <div><label className={labelCls}>Sponsored Student (optional)</label>
              <select className={inputCls} value={sponsorshipForm.studentId} onChange={(e) => setSponsorshipForm({ ...sponsorshipForm, studentId: e.target.value })}>
                <option value="">— Not assigned yet —</option>
                {students.map((s) => <option key={s.id} value={s.id}>{s.fullName} ({s.studentCode})</option>)}
              </select></div>
            <div><label className={labelCls}>Monthly Amount (AFN) *</label>
              <input type="number" min={1} className={inputCls} value={sponsorshipForm.monthlyAmount || ''} onChange={(e) => setSponsorshipForm({ ...sponsorshipForm, monthlyAmount: Number(e.target.value) })} required /></div>
            <div className="grid grid-cols-2 gap-3">
              <ShamsiDateInput label="Start Date" value={sponsorshipForm.startDate} onChange={(v) => setSponsorshipForm({ ...sponsorshipForm, startDate: v })} />
              <ShamsiDateInput label="End Date" value={sponsorshipForm.endDate} onChange={(v) => setSponsorshipForm({ ...sponsorshipForm, endDate: v })} />
            </div>
            <button type="submit" className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-2.5 rounded-lg cursor-pointer transition-colors shadow-sm">Create Agreement</button>
          </form>
        </ModalShell>
      )}

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}