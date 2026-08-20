/**
 * @license SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { UserPlus, X, CheckCircle2, Loader2, ChevronDown, ChevronUp, AlertTriangle } from 'lucide-react';
import { Branch, Visitor, DuplicateCandidate } from '../../types';
import { validatePhone } from '../../utils/erpHelpers';
import { VISITOR_SOURCE_OPTIONS } from '../../config/visitorSources';
import { ShamsiDateInput } from '../common/ShamsiDateInput';

interface AddVisitorFormProps {
  branches: Branch[];
  activeBranchId: string;
  addVisitor: (
    fullName: string, phone: string, gender: 'male' | 'female', source: Visitor['source'], 
    notes: string, interestedCourse: string,
    followUpStatus: 'high_interest' | 'medium_interest' | 'low_interest' | 'not_answering' | 'no_interest',
    nextContactDate: string, fatherName?: string, addressRegion?: string, tazkiraNo?: string, whatsapp?: string,
    dob?: string, schoolOrUniversity?: string, emergencyContactName?: string, emergencyContactPhone?: string,
    branchId?: string, email?: string, programVersionId?: string
  ) => Promise<{ id: string; serialNo: string } | void>;
  onCancel: () => void;
  triggerToast: (msg: string, type: 'success' | 'error' | 'info') => void;
  onVisitorCreated?: (visitorId: string) => void;
  /** Advisory duplicate lookup (UX-9). Never blocks submit. */
  checkDuplicateLeads?: (params: { phone?: string; tazkiraNo?: string; fullName?: string }) => Promise<DuplicateCandidate[]>;
  /** Open an existing lead instead of creating a second record. */
  onOpenExistingLead?: (visitorId: string) => void;
  programVersions?: Array<{ id: string; name: string; versionLabel: string; status: string }>;
}

export default function AddVisitorForm({
  branches, activeBranchId, addVisitor, onCancel, triggerToast, onVisitorCreated, programVersions = [],
  checkDuplicateLeads, onOpenExistingLead,
}: AddVisitorFormProps) {
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [gender, setGender] = useState<'male' | 'female'>('male');
  const [source, setSource] = useState<Visitor['source']>('social');
  const [notes, setNotes] = useState('');
  const [interestedCourse, setInterestedCourse] = useState('');
  const [followUpStatus, setFollowUpStatus] = useState<'high_interest' | 'medium_interest' | 'low_interest' | 'not_answering' | 'no_interest'>('medium_interest');
  const [nextContactDate, setNextContactDate] = useState('');
  
  const [fatherName, setFatherName] = useState('');
  const [addressRegion, setAddressRegion] = useState('');
  const [tazkiraNo, setTazkiraNo] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [dob, setDob] = useState('');
  const [schoolOrUniversity, setSchoolOrUniversity] = useState('');
  const [emergencyContactName, setEmergencyContactName] = useState('');
  const [emergencyContactPhone, setEmergencyContactPhone] = useState('');
  const [visitorBranchId, setVisitorBranchId] = useState('');
  const [programVersionId, setProgramVersionId] = useState('');
  
  const [submitting, setSubmitting] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false); // Collapsible state

  /**
   * Possible-duplicate warning (UX-9).
   *
   * Advisory by design. The audit proved a receptionist could silently
   * re-register a returning walk-in — identical name and phone created a second
   * row, because only Tazkira is unique server-side and it is optional. Making
   * phone unique would be wrong (household and office lines are shared), so the
   * operator is shown what we already have and decides.
   *
   * Debounced, and keyed off the identifying fields only, so typing a name does
   * not issue a request per keystroke.
   */
  const [dupResult, setDupResult] = useState<DuplicateCandidate[]>([]);
  const phoneDigits = phone.replace(/\D/g, '');
  const hasDupSignal = phoneDigits.length >= 7 || tazkiraNo.trim().length >= 4;
  // Derived, not stored: with too little typed to search on, there is nothing
  // to show. Clearing state inside the effect for this case would be a
  // synchronous setState that cascades a render on every keystroke.
  const duplicates = hasDupSignal ? dupResult : [];

  useEffect(() => {
    if (!checkDuplicateLeads || !hasDupSignal) return;
    let cancelled = false;
    const t = setTimeout(() => {
      checkDuplicateLeads({ phone: phone.trim() || undefined, tazkiraNo: tazkiraNo.trim() || undefined })
        .then((rows) => { if (!cancelled) setDupResult(rows); })
        // A failed advisory lookup must never obstruct registration.
        .catch(() => { if (!cancelled) setDupResult([]); });
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [phone, tazkiraNo, hasDupSignal, checkDuplicateLeads]);

  // Local calendar date, matching the server's `today()`, so a future date of
  // birth cannot be entered at all.
  const todayIso = new Date().toLocaleDateString('en-CA');

  const inputCls = "w-full bg-slate-50 border border-slate-200 rounded-xl px-3.5 py-2.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/10 font-medium transition-all";
  const labelCls = "block text-slate-600 mb-1 font-bold text-[11px]";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fullName.trim() || !phone.trim()) return triggerToast('Visitor full name and phone are required.', 'error');
    if (!validatePhone(phone)) return triggerToast('Invalid phone. Use Afghan format (e.g. 0729112233).', 'error');
    if (whatsapp && !validatePhone(whatsapp)) return triggerToast('Invalid WhatsApp. Use Afghan format.', 'error');
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return triggerToast('Invalid email address.', 'error');

    setSubmitting(true);
    try {
      const created = await addVisitor(
        fullName, phone, gender, source, notes, interestedCourse, followUpStatus, nextContactDate,
        fatherName, addressRegion, tazkiraNo, whatsapp, dob, schoolOrUniversity,
        emergencyContactName, emergencyContactPhone, visitorBranchId || activeBranchId, email.trim() || undefined, programVersionId || undefined
      );
      triggerToast('New visitor saved and follow-up activated.', 'success');
      if (created?.id) onVisitorCreated?.(created.id);
      onCancel();
    } catch (err: any) {
      // UX-2: `api` is fetch-based and throws ApiError with `.message` — there
      // is no `.response.data` anywhere in this codebase. Reading the Axios
      // shape first meant EVERY actionable server message (duplicate Tazkira,
      // invalid date, name too long) collapsed into one generic sentence on
      // the receptionist's most-used screen. Sibling modals already read
      // `err.message`; this now matches them.
      triggerToast(err?.message || 'Could not save visitor. Please check the fields and try again.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-3xl p-6 shadow-xl max-w-2xl mx-auto animate-in fade-in duration-200 text-start">
      <div className="flex justify-between items-center mb-6 border-b border-slate-100 pb-3">
        <h3 className="text-base font-black text-slate-900 flex items-center gap-2">
          <UserPlus className="w-5 h-5 text-indigo-600 stroke-[2.5]" />
          Register New Lead
        </h3>
        <button type="button" onClick={onCancel} className="p-1.5 bg-slate-50 hover:bg-slate-100 text-slate-500 rounded-lg cursor-pointer"><X className="w-4 h-4" /></button>
      </div>
      
      {/* Possible-duplicate warning. Advisory: it never blocks the submit, it
          just makes the existing record visible before a second one is created. */}
      {duplicates.length > 0 && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-[11px] font-bold text-amber-900">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
            {duplicates.length === 1 ? 'A matching lead already exists' : `${duplicates.length} matching leads already exist`}
          </p>
          <ul className="mt-1.5 space-y-1">
            {duplicates.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white/70 px-2 py-1.5">
                <span className="text-[10px] text-amber-950">
                  <span className="font-bold">{c.fullName}</span>
                  {c.serialNo ? <span className="font-mono text-amber-700"> · {c.serialNo}</span> : null}
                  {c.phone ? <span className="font-mono"> · {c.phone}</span> : null}
                  {c.visitDate ? <span className="text-amber-700"> · first visit {c.visitDate}</span> : null}
                  <span className="text-amber-700"> · matched on {c.matchedOn}</span>
                </span>
                {onOpenExistingLead && (
                  <button
                    type="button"
                    onClick={() => onOpenExistingLead(c.id)}
                    className="rounded-lg bg-amber-600 px-2.5 py-1 text-[10px] font-bold text-white hover:bg-amber-700 cursor-pointer"
                  >Open instead</button>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[9px] text-amber-700">A shared family or office phone is normal — continue if this is a different person.</p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="grid grid-cols-1 sm:grid-cols-2 gap-5 text-xs">
        
        {/* Primary Contact */}
        <div>
          <label className={labelCls}>Full name *</label>
          <input type="text" placeholder="e.g. Zabiullah Amini" maxLength={200} value={fullName} onChange={(e) => setFullName(e.target.value)} className={inputCls} required />
        </div>
        <div>
          <label className={labelCls}>Phone (preferably WhatsApp) *</label>
          <input type="tel" placeholder="e.g. 0729112233" maxLength={60} value={phone} onChange={(e) => setPhone(e.target.value)} className={`${inputCls} font-mono text-start`} required />
        </div>
        <div>
          <label className={labelCls}>Gender</label>
          <select value={gender} onChange={(e) => setGender(e.target.value as any)} className={inputCls}>
            <option value="male">Male</option><option value="female">Female</option>
          </select>
        </div>
        <div>
          <label className={labelCls}>Lead source</label>
          <select value={source} onChange={(e) => setSource(e.target.value as any)} className={inputCls}>
            {VISITOR_SOURCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>

        {/* Academic Interest */}
        <div>
          <label className={labelCls}>Program / curriculum version *</label>
          <select
            value={programVersionId}
            onChange={(e) => {
              const next = e.target.value;
              setProgramVersionId(next);
              const selected = programVersions.find((v) => v.id === next);
              if (selected) setInterestedCourse(selected.name);
            }}
            className={inputCls}
            required
          >
            <option value="">Select program…</option>
            {programVersions.filter((v) => v.status === 'published').map((v) => (
              <option key={v.id} value={v.id}>{v.name} · {v.versionLabel}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>Interest level</label>
          <select value={followUpStatus} onChange={(e) => setFollowUpStatus(e.target.value as any)} className={inputCls}>
            <option value="high_interest">High interest 🔥</option><option value="medium_interest">Medium interest ⚡</option><option value="low_interest">Low interest ❄️</option><option value="not_answering">No response 📞</option><option value="no_interest">Dropped ❌</option>
          </select>
        </div>
        
        {}
        <div>
          <ShamsiDateInput label="Next contact date" value={nextContactDate} onChange={setNextContactDate} />
        </div>
        <div>
          <label className={labelCls}>Branch</label>
          <select value={visitorBranchId || activeBranchId} onChange={(e) => setVisitorBranchId(e.target.value)} className={`${inputCls} font-bold`}>
            {branches && branches.length > 0 ? branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>) : <option value="">No branches available</option>}
          </select>
        </div>
        
        <div className="sm:col-span-2">
          <label className={labelCls}>Initial counseling notes</label>
          <textarea placeholder="e.g. Looking for TOEFL prep next month for a scholarship…" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={inputCls} />
        </div>

        {/* Collapsible Advanced Details */}
        <div className="sm:col-span-2 mt-2 border-t border-slate-100 pt-3">
          <button type="button" onClick={() => setShowAdvanced(!showAdvanced)} className="w-full flex items-center justify-center gap-1 text-[11px] font-extrabold text-indigo-600 hover:text-indigo-700 cursor-pointer">
            {showAdvanced ? <><ChevronUp className="w-4 h-4" /> Hide Additional Details</> : <><ChevronDown className="w-4 h-4" /> Show Additional Details (Optional)</>}
          </button>
        </div>

        {showAdvanced && (
          <div className="sm:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-5 animate-in fade-in duration-200">
            <div><label className={labelCls}>Email (optional)</label><input type="email" placeholder="name@example.com" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} className={`${inputCls} font-mono text-start`} /></div>
            <div><label className={labelCls}>Father's name</label><input type="text" placeholder="e.g. Mohammad Zaman" maxLength={200} value={fatherName} onChange={(e) => setFatherName(e.target.value)} className={inputCls} /></div>
            <div><label className={labelCls}>Tazkira number</label><input type="text" placeholder="e.g. 1234-5678-901" maxLength={60} value={tazkiraNo} onChange={(e) => setTazkiraNo(e.target.value)} className={`${inputCls} font-mono`} /></div>
            {/* UX-5: the server validates this with assertOptionalIsoDate, so a
                free-text "24" is rejected. A date input makes the only accepted
                format the only enterable one. */}
            <div><label className={labelCls}>Date of birth</label><input type="date" max={todayIso} value={dob} onChange={(e) => setDob(e.target.value)} className={inputCls} /><p className="mt-1 text-[10px] text-slate-400">Optional — format YYYY-MM-DD.</p></div>
            <div><label className={labelCls}>WhatsApp (if different)</label><input type="tel" placeholder="e.g. 0722334455" maxLength={60} value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} className={`${inputCls} font-mono text-start`} /></div>
            <div><label className={labelCls}>School / university</label><input type="text" placeholder="e.g. Kabul Polytechnic" maxLength={500} value={schoolOrUniversity} onChange={(e) => setSchoolOrUniversity(e.target.value)} className={inputCls} /></div>
            <div className="sm:col-span-2"><label className={labelCls}>Region, district & address</label><input type="text" placeholder="e.g. Kabul, District 6, Baraki" maxLength={500} value={addressRegion} onChange={(e) => setAddressRegion(e.target.value)} className={inputCls} /></div>
            <div><label className={labelCls}>Emergency contact name</label><input type="text" placeholder="e.g. Abdul Rahim" maxLength={200} value={emergencyContactName} onChange={(e) => setEmergencyContactName(e.target.value)} className={inputCls} /></div>
            <div><label className={labelCls}>Emergency phone</label><input type="tel" placeholder="e.g. 0799112233" maxLength={60} value={emergencyContactPhone} onChange={(e) => setEmergencyContactPhone(e.target.value)} className={`${inputCls} font-mono text-start`} /></div>
          </div>
        )}

        {/* Actions */}
        <div className="sm:col-span-2 flex gap-2 justify-end pt-4 border-t border-slate-100 mt-2">
          <button type="button" onClick={onCancel} disabled={submitting} className="px-5 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl font-bold transition-colors cursor-pointer disabled:opacity-50">Cancel</button>
          <button type="submit" disabled={submitting} className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-black transition-colors cursor-pointer shadow-md flex items-center gap-2 disabled:opacity-60">
            {submitting ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</> : <><CheckCircle2 className="w-4 h-4" /> Save Visitor</>}
          </button>
        </div>
      </form>
    </div>
  );
}