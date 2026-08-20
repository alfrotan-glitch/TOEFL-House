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
    tuitionAmount?: number,
    fatherName?: string,
    addressRegion?: string,
    tazkiraNo?: string,
    whatsapp?: string,
    dob?: string,
    schoolOrUniversity?: string,
    emergencyContactName?: string,
    emergencyContactPhone?: string,
    amountPaidNow?: number,
    branchId?: string
  ) => void;
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

  // Step 1: Identity State
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

  // Step 2: Enrollment & Finance State
  const [assignedClassId, setAssignedClassId] = useState('');
  const [studentBranchId, setStudentBranchId] = useState('');
  const [discountPercent, setDiscountPercent] = useState(0);
  const [semesterFee, setSemesterFee] = useState(0);
  const [initialFee, setInitialFee] = useState(0);
  const [notes, setNotes] = useState('');

  const inputCls = "w-full bg-slate-50 border border-slate-200 rounded-xl px-3.5 py-3 focus:outline-none focus:ring-2 focus:ring-indigo-500/10 font-bold text-slate-800 text-xs transition-all";

  const handleVisitorSelect = (vid: string) => {
    setSelectedVisitorId(vid);
    if (vid) {
      const visitor = visitors.find(v => v.id === vid);
      if (visitor) {
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
      }
    }
  };

  const validateStep1 = () => {
    if (!fullName.trim() || !phone.trim() || !fatherName.trim()) {
      triggerToast("Full name, father's name, and phone are required.", "error");
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
    const safeSemesterFee = Number(semesterFee || 0);
    const safeInitialFee = Number(initialFee || 0);
    const safeDiscount = Number(discountPercent || 0);
    const netTuition = Math.max(0, safeSemesterFee - Math.round(safeSemesterFee * safeDiscount / 100));
    
    if (safeInitialFee > netTuition) {
      triggerToast("Today's payment cannot exceed payable tuition after discount.", "error");
      return false;
    }
    return true;
  };

  const nextStep = () => {
    if (step === 1 && !validateStep1()) return;
    if (step === 2 && !validateStep2()) return;
    setStep(prev => Math.min(3, prev + 1));
  };

  const prevStep = () => setStep(prev => Math.max(1, prev - 1));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateStep1() || !validateStep2()) return;

    try {
      await addStudentManual(
        fullName,
        phone,
        email,
        gender,
        Number(discountPercent || 0),
        notes,
        assignedClassId,
        Number(semesterFee || 0),
        fatherName,
        addressRegion,
        tazkiraNo,
        whatsapp,
        dob,
        schoolOrUniversity,
        emergencyContactName,
        emergencyContactPhone,
        Number(initialFee || 0),
        studentBranchId || activeBranchId
      );
      triggerToast('Student registered successfully.', 'success');
      onCancel();
    } catch (err) {
      triggerToast(err instanceof Error ? err.message : 'Could not register student. Please try again.', 'error');
    }
  };

  // Live Calculation Variables
  const safeSemesterFee = Number(semesterFee || 0);
  const safeDiscount = Number(discountPercent || 0);
  const safeInitialFee = Number(initialFee || 0);
  const discountAmount = Math.round(safeSemesterFee * safeDiscount / 100);
  const netTuition = Math.max(0, safeSemesterFee - discountAmount);
  const remainingDebt = Math.max(0, netTuition - safeInitialFee);

  return (
    <div className="bg-white border border-slate-200 rounded-3xl p-6 shadow-xs max-w-3xl mx-auto animate-in fade-in duration-200">
      <h3 className="text-base font-black text-slate-900 mb-4 flex items-center gap-1.5 border-b border-slate-100 pb-3">
        <UserPlus className="w-5 h-5 text-indigo-600 stroke-[2.5]" />
        Direct Enrollment — New Student
      </h3>

      {/* Stepper Indicator */}
      <div className="flex items-center justify-between mb-8 mt-4">
        {[
          { num: 1, label: 'Identity', icon: ShieldCheck },
          { num: 2, label: 'Finance', icon: Wallet },
          { num: 3, label: 'Review', icon: IdCard }
        ].map((s, i) => (
          <div key={s.num} className="flex items-center w-full">
            <div className="flex flex-col items-center">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-xs transition-all ${step >= s.num ? 'bg-indigo-600 text-white shadow-md' : 'bg-slate-100 text-slate-400'}`}>
                {step > s.num ? <Check className="w-5 h-5" /> : <s.icon className="w-5 h-5" />}
              </div>
              <span className={`text-[10px] font-bold mt-1 ${step >= s.num ? 'text-indigo-600' : 'text-slate-400'}`}>{s.label}</span>
            </div>
            {i < 2 && <div className={`h-1 flex-1 mx-2 rounded-full transition-all ${step > s.num ? 'bg-indigo-600' : 'bg-slate-100'}`}></div>}
          </div>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-start">
        
        {/* STEP 1: IDENTITY & CONTACT */}
        {step === 1 && (
          <>
            {visitors.length > 0 && (
              <div className="md:col-span-2 bg-indigo-50/40 border border-indigo-150 rounded-2xl p-4 mb-2">
                <label className="block text-indigo-900 font-extrabold text-[11px] flex items-center gap-1.5 mb-2">
                  <Sparkles className="w-4 h-4 text-indigo-600 animate-pulse" /> Auto-fill from registered visitors
                </label>
                <select 
                  value={selectedVisitorId} 
                  onChange={(e) => handleVisitorSelect(e.target.value)} 
                  className="w-full bg-white border border-indigo-200 text-indigo-950 font-bold rounded-xl px-3 py-2.5 cursor-pointer focus:outline-none text-[11px]"
                >
                  <option value="">-- Select an active visitor --</option>
                  {visitors.filter(v => v.branchId === activeBranchId && v.status !== 'registered').map(v => <option key={v.id} value={v.id}>{v.fullName} ({v.phone})</option>)}
                </select>
              </div>
            )}

            <div className="space-y-1">
              <label className="block text-slate-600 font-bold mb-1">Student full name *</label>
              <input type="text" placeholder="e.g. Najibullah Azimi" value={fullName} onChange={(e) => setFullName(e.target.value)} className={inputCls} required />
            </div>
            <div className="space-y-1">
              <label className="block text-slate-600 font-bold mb-1">Father's name *</label>
              <input type="text" placeholder="e.g. Mohammad Amin" value={fatherName} onChange={(e) => setFatherName(e.target.value)} className={inputCls} required />
            </div>
            <div className="space-y-1">
              <label className="block text-slate-600 font-bold mb-1">Mobile phone *</label>
              <input type="tel" placeholder="0799887766" value={phone} onChange={(e) => setPhone(e.target.value)} className={`${inputCls} font-mono`} required />
            </div>
            <div className="space-y-1">
              <label className="block text-slate-600 font-bold mb-1">Gender</label>
              <select value={gender} onChange={(e) => setGender(e.target.value as any)} className={inputCls}>
                <option value="male">Male</option>
                <option value="female">Female</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="block text-slate-600 font-bold mb-1">Tazkira / ID number</label>
              <input type="text" value={tazkiraNo} onChange={(e) => setTazkiraNo(e.target.value)} className={`${inputCls} font-mono`} />
            </div>
            <div className="space-y-1">
              <label className="block text-slate-600 font-bold mb-1">Date of birth / age</label>
              <input type="text" placeholder="2003-07-06 or 22" value={dob} onChange={(e) => setDob(e.target.value)} className={inputCls} />
            </div>
            <div className="md:col-span-2 space-y-1">
              <label className="block text-slate-600 font-bold mb-1">School / university</label>
              <input type="text" value={schoolOrUniversity} onChange={(e) => setSchoolOrUniversity(e.target.value)} className={inputCls} />
            </div>
            <div className="space-y-1">
              <label className="block text-slate-600 font-bold mb-1">WhatsApp (optional)</label>
              <input type="tel" value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} className={`${inputCls} font-mono`} />
            </div>
            <div className="space-y-1">
              <label className="block text-slate-600 font-bold mb-1">Address / region</label>
              <input type="text" value={addressRegion} onChange={(e) => setAddressRegion(e.target.value)} className={inputCls} />
            </div>
          </>
        )}

        {/* STEP 2: CLASS & FINANCE */}
        {step === 2 && (
          <>
            <div className="space-y-1">
              <label className="block text-slate-600 font-bold mb-1">Branch</label>
              <select value={studentBranchId || activeBranchId} onChange={(e) => setStudentBranchId(e.target.value)} className={inputCls}>
                {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <label className="block text-slate-600 font-bold mb-1">Class</label>
              <select 
                value={assignedClassId} 
                onChange={(e) => {
                  const cId = e.target.value;
                  setAssignedClassId(cId);
                  const cls = classes.find(c => c.id === cId);
                  if (cls) {
                    const fee = Number(cls.fee || 0);
                    setSemesterFee(fee);
                    setInitialFee(fee);
                  }
                }} 
                className={inputCls}
              >
                <option value="">-- Select Class --</option>
                {classes.filter(c => (!c.status || c.status === 'active') && (!c.branchId || c.branchId === (studentBranchId || activeBranchId))).map(c => (
                  <option key={c.id} value={c.id}>{c.name} ({c.level})</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="block text-slate-600 font-bold mb-1">Standard tuition (AFN)</label>
              <input type="number" value={semesterFee} onChange={(e) => { const v = Number(e.target.value); setSemesterFee(v); setInitialFee(v); }} className={`${inputCls} font-mono`} min={0} />
            </div>
            <div className="space-y-1">
              <label className="block text-slate-600 font-bold mb-1">Discount (%)</label>
              <input type="number" value={discountPercent} onChange={(e) => { const next = Number(e.target.value); setDiscountPercent(next); const nextNet = Math.max(0, safeSemesterFee - Math.round(safeSemesterFee * Math.max(0, next) / 100)); setInitialFee((current) => Math.min(current, nextNet)); }} className={`${inputCls} font-mono`} min={0} max={30} />
            </div>
            <div className="md:col-span-2 space-y-1">
              <label className="block text-slate-600 font-bold mb-1">Amount paid today (AFN)</label>
              <input type="number" value={initialFee} onChange={(e) => setInitialFee(Number(e.target.value))} className={`${inputCls} font-mono`} min={0} />
            </div>

            {/* Live Calculation Summary */}
            <div className="md:col-span-2 bg-indigo-50/45 border border-indigo-100 rounded-2xl p-4 mt-2 grid grid-cols-3 gap-3 text-[11px]">
              <div className="space-y-0.5">
                <span className="text-slate-500 block font-bold">Gross Fee</span>
                <span className="font-mono font-extrabold text-slate-800 text-sm">{safeSemesterFee.toLocaleString()} AFN</span>
              </div>
              <div className="space-y-0.5">
                <span className="text-slate-500 block font-bold">Discount ({safeDiscount}%)</span>
                <span className="font-mono font-extrabold text-rose-600 text-sm">{discountAmount.toLocaleString()} AFN</span>
              </div>
              <div className="space-y-0.5">
                <span className="text-indigo-600 font-bold block">Remaining Debt</span>
                <span className={`font-mono font-black text-sm ${remainingDebt > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
                  {remainingDebt.toLocaleString()} AFN
                </span>
              </div>
            </div>
          </>
        )}

        {/* STEP 3: REVIEW & CONFIRM */}
        {step === 3 && (
          <div className="md:col-span-2 space-y-4">
            <div className="text-center bg-emerald-50 p-6 rounded-2xl border border-emerald-100">
              <Check className="w-12 h-12 text-emerald-600 mx-auto mb-2" />
              <h4 className="font-extrabold text-slate-900 text-sm">Review & Confirm Registration</h4>
              <p className="text-slate-500 mt-1 text-[11px]">Please verify the details below before posting to the main account.</p>
            </div>
            
            <div className="bg-slate-50 rounded-2xl p-4 grid grid-cols-2 gap-3 text-[11px] font-semibold">
              <div><span className="text-slate-400 block">Student Name:</span> <span className="text-slate-900 font-bold">{fullName}</span></div>
              <div><span className="text-slate-400 block">Father's Name:</span> <span className="text-slate-900 font-bold">{fatherName}</span></div>
              <div><span className="text-slate-400 block">Phone:</span> <span className="text-slate-900 font-mono">{phone}</span></div>
              <div><span className="text-slate-400 block">Branch:</span> <span className="text-slate-900">{branches.find(b=>b.id===(studentBranchId||activeBranchId))?.name}</span></div>
              <div><span className="text-slate-400 block">Class:</span> <span className="text-slate-900">{classes.find(c=>c.id===assignedClassId)?.name || 'N/A'}</span></div>
              <div><span className="text-slate-400 block">Tuition:</span> <span className="text-slate-900 font-mono">{safeSemesterFee.toLocaleString()} AFN</span></div>
              <div><span className="text-slate-400 block">Paid Today:</span> <span className="text-emerald-600 font-mono">{safeInitialFee.toLocaleString()} AFN</span></div>
              <div><span className="text-slate-400 block">Remaining Debt:</span> <span className="text-amber-600 font-mono">{remainingDebt.toLocaleString()} AFN</span></div>
            </div>
          </div>
        )}

        {/* Navigation Buttons */}
        <div className="md:col-span-2 flex gap-2.5 mt-4">
          <button 
            type="button" 
            onClick={() => (step === 1 ? onCancel() : prevStep())} 
            className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-600 font-black py-3 rounded-xl transition-all cursor-pointer text-xs flex items-center justify-center gap-1"
          >
            {step === 1 ? 'Cancel' : <><ChevronLeft className="w-4 h-4" /> Back</>}
          </button>
          
          {step < 3 ? (
            <button 
              type="button" 
              onClick={nextStep} 
              className="flex-[2] bg-indigo-600 hover:bg-indigo-700 text-white font-black py-3 rounded-xl transition-all cursor-pointer shadow-md shadow-indigo-900/15 text-xs flex items-center justify-center gap-1"
            >
              Next Step <ChevronRight className="w-4 h-4" />
            </button>
          ) : (
            <button 
              type="submit" 
              className="flex-[2] bg-emerald-600 hover:bg-emerald-700 text-white font-black py-3 rounded-xl transition-all cursor-pointer shadow-md text-xs flex items-center justify-center gap-1"
            >
              <Check className="w-4 h-4" /> Save & Post Payment
            </button>
          )}
        </div>
      </form>
    </div>
  );
}