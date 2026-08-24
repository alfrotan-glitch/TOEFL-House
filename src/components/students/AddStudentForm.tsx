/**
 * @license SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { UserPlus, Sparkles, ChevronRight, ChevronLeft, Check, ShieldCheck, Wallet, IdCard } from 'lucide-react';
import { Class, Branch, Visitor } from '../../types';
import { validatePhone, validateEmail } from '../../utils/erpHelpers';

interface AddStudentFormProps {
  classes: Class[];
  branches: Branch[];
  activeBranchId: string;
  addStudentManual: (
    fullName: string,
    phone: string,
    email: string,
    gender: 'male' | 'female',
    discountPercent: number,
    notes?: string,
    classId?: string,
    fatherName?: string,
    addressRegion?: string,
    tazkiraNo?: string,
    whatsapp?: string,
    dob?: string,
    schoolOrUniversity?: string,
    emergencyContactName?: string,
    emergencyContactPhone?: string,
    branchId?: string
  ) => Promise<void> | void;
  onCancel: () => void;
  educationalSections?: Array<{ id: string; name: string; fee?: number }>;
  triggerToast: (msg: string, type: 'success' | 'error' | 'info') => void;
  visitors?: Visitor[];
}

export default function AddStudentForm({
  classes,
  branches,
  activeBranchId,
  addStudentManual,
  onCancel,
  triggerToast,
  visitors = [],
}: AddStudentFormProps) {
  const [step, setStep] = useState(1);
  const [selectedVisitorId, setSelectedVisitorId] = useState('');

  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email] = useState('');
  const [gender, setGender] = useState<'male' | 'female'>('male');
  const [fatherName, setFatherName] = useState('');
  const [dob, setDob] = useState('');
  const [tazkiraNo, setTazkiraNo] = useState('');
  const [addressRegion, setAddressRegion] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [schoolOrUniversity, setSchoolOrUniversity] = useState('');
  const [emergencyContactName, setEmergencyContactName] = useState('');
  const [emergencyContactPhone, setEmergencyContactPhone] = useState('');

  const [assignedClassId, setAssignedClassId] = useState('');
  const [studentBranchId, setStudentBranchId] = useState('');
  const [discountPercent, setDiscountPercent] = useState(0);
  const [notes, setNotes] = useState('');

  const inputCls = 'w-full bg-slate-50 border border-slate-200 rounded-xl px-3.5 py-3 focus:outline-none focus:ring-2 focus:ring-indigo-500/10 font-bold text-slate-800 text-xs transition-all';

  const handleVisitorSelect = (vid: string) => {
    setSelectedVisitorId(vid);
    if (!vid) return;
    const visitor = visitors.find((candidate) => candidate.id === vid);
    if (!visitor) return;
    setFullName(visitor.fullName);
    setPhone(visitor.phone);
    setGender(visitor.gender);
    setFatherName(visitor.fatherName || '');
    setAddressRegion(visitor.addressRegion || '');
    setTazkiraNo(visitor.tazkiraNo || '');
    setWhatsapp(visitor.whatsapp || '');
    setDob(visitor.dob || '');
    setSchoolOrUniversity(visitor.schoolOrUniversity || '');
    setEmergencyContactName(visitor.emergencyContactName || '');
    setEmergencyContactPhone(visitor.emergencyContactPhone || '');
    setNotes(visitor.notes || '');
    triggerToast(`Visitor «${visitor.fullName}» loaded.`, 'success');
  };

  const validateStep1 = () => {
    if (!fullName.trim() || !phone.trim() || !fatherName.trim()) {
      triggerToast("Full name, father's name, and phone are required.", 'error');
      return false;
    }
    if (!validatePhone(phone)) {
      triggerToast('Invalid phone. Use Afghan format (e.g. 0799887766).', 'error');
      return false;
    }
    if (whatsapp && !validatePhone(whatsapp)) {
      triggerToast('Invalid WhatsApp number.', 'error');
      return false;
    }
    if (email && !validateEmail(email)) {
      triggerToast('Invalid email format.', 'error');
      return false;
    }
    return true;
  };

  const validateStep2 = () => {
    const safeDiscount = Number(discountPercent || 0);
    if (!Number.isFinite(safeDiscount) || safeDiscount < 0 || safeDiscount > 100) {
      triggerToast('Discount percent must be between 0 and 100.', 'error');
      return false;
    }
    return true;
  };

  const nextStep = () => {
    if (step === 1 && !validateStep1()) return;
    if (step === 2 && !validateStep2()) return;
    setStep((prev) => Math.min(3, prev + 1));
  };

  const prevStep = () => setStep((prev) => Math.max(1, prev - 1));

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!validateStep1() || !validateStep2()) return;
    try {
      await addStudentManual(
        fullName,
        phone,
        email,
        gender,
        Number(discountPercent || 0),
        notes,
        assignedClassId || undefined,
        fatherName,
        addressRegion,
        tazkiraNo,
        whatsapp,
        dob,
        schoolOrUniversity,
        emergencyContactName,
        emergencyContactPhone,
        studentBranchId || activeBranchId,
      );
      triggerToast('Student admitted successfully. Continue with placement, invoices, and enrollment from the student workspace.', 'success');
      onCancel();
    } catch (err) {
      triggerToast(err instanceof Error ? err.message : 'Could not admit student. Please try again.', 'error');
    }
  };

  const selectedClass = classes.find((candidate) => candidate.id === assignedClassId);

  return (
    <div className="mx-auto max-w-3xl animate-in fade-in duration-200 rounded-3xl border border-slate-200 bg-white p-6 shadow-xs">
      <h3 className="mb-4 flex items-center gap-1.5 border-b border-slate-100 pb-3 text-base font-black text-slate-900">
        <UserPlus className="h-5 w-5 text-indigo-600 stroke-[2.5]" />
        Direct Admission — New Student
      </h3>

      <div className="mb-8 mt-4 flex items-center justify-between">
        {[
          { num: 1, label: 'Identity', icon: ShieldCheck },
          { num: 2, label: 'Admission', icon: Wallet },
          { num: 3, label: 'Review', icon: IdCard },
        ].map((stepper, index) => (
          <div key={stepper.num} className="flex w-full items-center">
            <div className="flex flex-col items-center">
              <div className={`flex h-10 w-10 items-center justify-center rounded-full text-xs font-bold transition-all ${step >= stepper.num ? 'bg-indigo-600 text-white shadow-md' : 'bg-slate-100 text-slate-400'}`}>
                {step > stepper.num ? <Check className="h-5 w-5" /> : <stepper.icon className="h-5 w-5" />}
              </div>
              <span className={`mt-1 text-[10px] font-bold ${step >= stepper.num ? 'text-indigo-600' : 'text-slate-400'}`}>{stepper.label}</span>
            </div>
            {index < 2 && <div className={`mx-2 h-1 flex-1 rounded-full transition-all ${step > stepper.num ? 'bg-indigo-600' : 'bg-slate-100'}`} />}
          </div>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-4 text-start text-xs md:grid-cols-2">
        {step === 1 && (
          <>
            {visitors.length > 0 && (
              <div className="mb-2 rounded-2xl border border-indigo-150 bg-indigo-50/40 p-4 md:col-span-2">
                <label className="mb-2 flex items-center gap-1.5 text-[11px] font-extrabold text-indigo-900">
                  <Sparkles className="h-4 w-4 animate-pulse text-indigo-600" /> Auto-fill from registered visitors
                </label>
                <select
                  value={selectedVisitorId}
                  onChange={(event) => handleVisitorSelect(event.target.value)}
                  className="w-full cursor-pointer rounded-xl border border-indigo-200 bg-white px-3 py-2.5 text-[11px] font-bold text-indigo-950 focus:outline-none"
                >
                  <option value="">-- Select an active visitor --</option>
                  {visitors.filter((visitor) => visitor.branchId === activeBranchId && visitor.status !== 'registered').map((visitor) => (
                    <option key={visitor.id} value={visitor.id}>{visitor.fullName} ({visitor.phone})</option>
                  ))}
                </select>
              </div>
            )}

            <div className="space-y-1">
              <label className="mb-1 block font-bold text-slate-600">Student full name *</label>
              <input type="text" placeholder="e.g. Najibullah Azimi" value={fullName} onChange={(event) => setFullName(event.target.value)} className={inputCls} required />
            </div>
            <div className="space-y-1">
              <label className="mb-1 block font-bold text-slate-600">Father's name *</label>
              <input type="text" placeholder="e.g. Mohammad Amin" value={fatherName} onChange={(event) => setFatherName(event.target.value)} className={inputCls} required />
            </div>
            <div className="space-y-1">
              <label className="mb-1 block font-bold text-slate-600">Mobile phone *</label>
              <input type="tel" placeholder="0799887766" value={phone} onChange={(event) => setPhone(event.target.value)} className={`${inputCls} font-mono`} required />
            </div>
            <div className="space-y-1">
              <label className="mb-1 block font-bold text-slate-600">Gender</label>
              <select value={gender} onChange={(event) => setGender(event.target.value as 'male' | 'female')} className={inputCls}>
                <option value="male">Male</option>
                <option value="female">Female</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="mb-1 block font-bold text-slate-600">Tazkira no.</label>
              <input type="text" value={tazkiraNo} onChange={(event) => setTazkiraNo(event.target.value)} className={inputCls} />
            </div>
            <div className="space-y-1">
              <label className="mb-1 block font-bold text-slate-600">WhatsApp</label>
              <input type="tel" value={whatsapp} onChange={(event) => setWhatsapp(event.target.value)} className={`${inputCls} font-mono`} />
            </div>
            <div className="space-y-1">
              <label className="mb-1 block font-bold text-slate-600">Date of birth</label>
              <input type="date" value={dob} onChange={(event) => setDob(event.target.value)} className={inputCls} />
            </div>
            <div className="space-y-1">
              <label className="mb-1 block font-bold text-slate-600">School / University</label>
              <input type="text" value={schoolOrUniversity} onChange={(event) => setSchoolOrUniversity(event.target.value)} className={inputCls} />
            </div>
            <div className="space-y-1 md:col-span-2">
              <label className="mb-1 block font-bold text-slate-600">Address</label>
              <input type="text" value={addressRegion} onChange={(event) => setAddressRegion(event.target.value)} className={inputCls} />
            </div>
            <div className="space-y-1">
              <label className="mb-1 block font-bold text-slate-600">Emergency contact name</label>
              <input type="text" value={emergencyContactName} onChange={(event) => setEmergencyContactName(event.target.value)} className={inputCls} />
            </div>
            <div className="space-y-1">
              <label className="mb-1 block font-bold text-slate-600">Emergency phone</label>
              <input type="tel" value={emergencyContactPhone} onChange={(event) => setEmergencyContactPhone(event.target.value)} className={`${inputCls} font-mono`} />
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <div className="rounded-2xl border border-indigo-100 bg-indigo-50 p-4 md:col-span-2">
              <p className="text-[11px] font-extrabold text-indigo-900">Workflow reminder</p>
              <p className="mt-1 text-[11px] leading-relaxed text-indigo-700">
                Admission creates the student identity plus any required registration invoice. Placement, payment, and class enrollment happen afterward from the student workspace.
              </p>
            </div>

            <div className="space-y-1">
              <label className="mb-1 block font-bold text-slate-600">Owning branch</label>
              <select value={studentBranchId || activeBranchId} onChange={(event) => setStudentBranchId(event.target.value)} className={inputCls}>
                {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <label className="mb-1 block font-bold text-slate-600">Intended class (optional)</label>
              <select value={assignedClassId} onChange={(event) => setAssignedClassId(event.target.value)} className={inputCls}>
                <option value="">Choose later after placement</option>
                {classes.filter((candidate) => candidate.branchId === (studentBranchId || activeBranchId) && candidate.status === 'active').map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="mb-1 block font-bold text-slate-600">Discount percent</label>
              <input type="number" min={0} max={100} step={1} value={discountPercent} onChange={(event) => setDiscountPercent(Number(event.target.value || 0))} className={inputCls} />
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-[11px] text-slate-600">
              <p className="font-extrabold text-slate-800">No payment is collected here.</p>
              <p className="mt-1">The server will fail closed if required fees are missing from configuration, and enrollment remains blocked until the required invoices are settled.</p>
            </div>
            <div className="space-y-1 md:col-span-2">
              <label className="mb-1 block font-bold text-slate-600">Admission note</label>
              <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={4} className={`${inputCls} min-h-[110px]`} placeholder="Optional context for the student record" />
            </div>
          </>
        )}

        {step === 3 && (
          <div className="space-y-4 md:col-span-2">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <h4 className="mb-3 text-sm font-black text-slate-900">Admission review</h4>
              <div className="grid grid-cols-1 gap-3 text-[11px] font-semibold text-slate-700 md:grid-cols-2">
                <div><span className="block text-slate-400">Student</span>{fullName}</div>
                <div><span className="block text-slate-400">Phone</span>{phone}</div>
                <div><span className="block text-slate-400">Branch</span>{branches.find((branch) => branch.id === (studentBranchId || activeBranchId))?.name || 'Current branch'}</div>
                <div><span className="block text-slate-400">Intended class</span>{selectedClass?.name || 'To be assigned after placement'}</div>
                <div><span className="block text-slate-400">Discount</span>{discountPercent}%</div>
                <div><span className="block text-slate-400">Workflow</span>Admission → Placement → Invoice & Payment → Enrollment</div>
              </div>
            </div>
          </div>
        )}

        <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-4 md:col-span-2">
          <button type="button" onClick={step === 1 ? onCancel : prevStep} className="inline-flex items-center gap-1 rounded-xl border border-slate-200 px-4 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50">
            <ChevronLeft className="h-4 w-4" /> {step === 1 ? 'Cancel' : 'Back'}
          </button>

          {step < 3 ? (
            <button type="button" onClick={nextStep} className="inline-flex items-center gap-1 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-bold text-white hover:bg-indigo-700">
              Next <ChevronRight className="h-4 w-4" />
            </button>
          ) : (
            <button type="submit" className="inline-flex items-center gap-1 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-700">
              <Check className="h-4 w-4" /> Admit student
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
