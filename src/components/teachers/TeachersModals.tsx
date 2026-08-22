/**
 * @license SPDX-License-Identifier: Apache-2.0
 */
import { control, text } from '../../design-system/styles';
import React, { useState } from 'react';
import {ShieldAlert, Award, Sparkles, Check, Plus, X, ClipboardCheck} from 'lucide-react';
import {Teacher, Employee, BudgetLine, Skill, ClassTeacherSkill, Class as ClassType} from '../../types';
import type {TeacherSalaryStatus} from '../../apiStore';
import {formatAFN} from '../../utils/format';
import {recentJalaliPeriods, jalaliPeriodLabel, formatJalali} from '../../utils/jalali';
import {printPayslip} from '../../utils/payslipDocument';
import {ShamsiDate} from '../common/ShamsiDate';
import { BRAND_NAME } from '../../config/branding';

/** Labels for the five contract types. A contract type describes how the
 *  teacher is PAID; it never affects whether Skills are recorded. */
function salaryModelLabel(model?: string): string {
  switch (model) {
    case 'fixed': return 'Fixed Monthly';
    case 'per_skill': return 'Per Skill';
    case 'per_level': return 'Per Level';
    case 'per_session': return 'Per Session';
    case 'hybrid': return 'Hybrid (Base + Skill)';
    default: return model || 'Unknown';
  }
}

/** Payroll periods are Hijri Shamsi months (e.g. '1405-05' = اسد ۱۴۰۵),
 *  matching how Afghan payroll is actually run. */
function getPayrollMonthOptions(): string[] {
  return recentJalaliPeriods(8).reverse();
}

export interface PayslipData {
  serialNo: string;
  date: string;
  fullName: string;
  role: string;
  month: string;
  baseSalary: number;
  paymentType: 'full' | 'partial' | 'advance';
  amount: number;
}

interface TeachersModalsProps {
  // Edit teacher
  editingTeacher: Teacher | null;
  setEditingTeacher: (t: Teacher | null) => void;
  editTFullName: string; setEditTFullName: (v: string) => void;
  editTPhone: string; setEditTPhone: (v: string) => void;
  editTEmail: string; setEditTEmail: (v: string) => void;
  editTBaseSalary: number; setEditTBaseSalary: (v: number) => void;
  editTSalaryType: string; setEditTSalaryType: (v: string) => void;
  editTSpecialization: string; setEditTSpecialization: (v: string) => void;
  editTQualification: string; setEditTQualification: (v: string) => void;
  editTContractType: 'monthly' | 'hourly' | 'per_session'; setEditTContractType: (v: 'monthly' | 'hourly' | 'per_session') => void;
  editTStatus: 'active' | 'inactive' | 'on_leave'; setEditTStatus: (v: 'active' | 'inactive' | 'on_leave') => void;
  editTDefaultSkillRate: number; setEditTDefaultSkillRate: (v: number) => void;
  handleEditTeacherSubmit: (e: React.FormEvent) => void;

  // Edit employee
  editingEmployee: Employee | null;
  setEditingEmployee: (e: Employee | null) => void;
  editEFullName: string; setEditEFullName: (v: string) => void;
  editEPhone: string; setEditEPhone: (v: string) => void;
  editEEmail: string; setEditEEmail: (v: string) => void;
  editERole: string; setEditERole: (v: string) => void;
  editEBaseSalary: number; setEditEBaseSalary: (v: number) => void;
  editEStatus: 'active' | 'inactive'; setEditEStatus: (v: 'active' | 'inactive') => void;
  handleEditEmployeeSubmit: (e: React.FormEvent) => void;

  // Pay salary (shared)
  salaryTeacher: Teacher | null;
  setSalaryTeacher: (t: Teacher | null) => void;
  teacherSalaryStatus: TeacherSalaryStatus | null;
  salaryStatusLoading: boolean;
  salaryEmployee: Employee | null;
  setSalaryEmployee: (e: Employee | null) => void;
  teacherBudget: BudgetLine | undefined;
  employeeBudget: BudgetLine | undefined;
  paymentType: 'full' | 'partial' | 'advance';
  handleTeacherPaymentTypeChange: (type: 'full' | 'partial') => void;
  handleEmployeePaymentTypeChange: (type: 'full' | 'partial' | 'advance') => void;
  amountPaid: number; setAmountPaid: (v: number) => void;
  selectedMonth: string; setSelectedMonth: (v: string) => void;
  handlePayTeacherSalaryConfirm: () => void;
  handlePayEmployeeSalaryConfirm: () => void;

  // Evaluation
  evaluatingTeacher: Teacher | null;
  setEvaluatingTeacher: (t: Teacher | null) => void;
  handleEvaluateSubmit: (score: number, notes: string) => void;

  // Payslip
  printedPayslip: PayslipData | null;
  setPrintedPayslip: (p: PayslipData | null) => void;
  
  triggerToast: (message: string, type: 'success' | 'error' | 'info') => void;
}

export default function TeachersModals(props: TeachersModalsProps) {
  const {
    editingTeacher, setEditingTeacher, editTFullName, setEditTFullName, editTPhone, setEditTPhone,
    editTEmail, setEditTEmail, editTBaseSalary, setEditTBaseSalary, editTSalaryType, setEditTSalaryType,
    editTSpecialization, setEditTSpecialization, editTQualification, setEditTQualification, 
    editTContractType, setEditTContractType, editTStatus, setEditTStatus, editTDefaultSkillRate, setEditTDefaultSkillRate,
    handleEditTeacherSubmit,
    editingEmployee, setEditingEmployee, editEFullName, setEditEFullName, editEPhone, setEditEPhone,
    editEEmail, setEditEEmail, editERole, setEditERole, editEBaseSalary, setEditEBaseSalary, editEStatus, setEditEStatus,
    handleEditEmployeeSubmit,
    salaryTeacher, setSalaryTeacher, teacherSalaryStatus, salaryStatusLoading, salaryEmployee, setSalaryEmployee, teacherBudget, employeeBudget,
    paymentType, handleTeacherPaymentTypeChange, handleEmployeePaymentTypeChange,
    amountPaid, setAmountPaid, selectedMonth, setSelectedMonth,
    handlePayTeacherSalaryConfirm, handlePayEmployeeSalaryConfirm,
    evaluatingTeacher, setEvaluatingTeacher, handleEvaluateSubmit,
    printedPayslip, setPrintedPayslip, triggerToast
  } = props;

  const payrollMonthOptions = getPayrollMonthOptions();
  const monthOptions = payrollMonthOptions.includes(selectedMonth) ? payrollMonthOptions : [selectedMonth, ...payrollMonthOptions];

  // Local state for evaluation form
  // Evaluation defaults to 0 on every criterion so the evaluator must
  // consciously assign each score — a default of 50/100 was silently
  // submitting a half-appraisal. The three criteria sum to the full 100.
  const [evalTeaching, setEvalTeaching] = useState(0);
  const [evalManagement, setEvalManagement] = useState(0);
  const [evalCommunication, setEvalCommunication] = useState(0);
  const [evalNotes, setEvalNotes] = useState('');
  const totalEvalScore = evalTeaching + evalManagement + evalCommunication;

  const handleEvalSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (totalEvalScore <= 0) return;
    handleEvaluateSubmit(totalEvalScore, evalNotes);
    setEvalTeaching(0); setEvalManagement(0); setEvalCommunication(0); setEvalNotes('');
  };

  return (
    <>
      {/* Edit Teacher Modal */}
      {editingTeacher && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 z-50 overflow-y-auto">
          <div className="bg-white border border-slate-200 rounded-2xl p-6 max-w-lg w-full space-y-4 max-h-[90vh] overflow-y-auto shadow-xl">
            <div className="flex justify-between items-center border-b border-slate-100 pb-3">
              <h3 className="font-extrabold text-slate-900 text-sm">Edit Teacher Profile</h3>
              <button onClick={() => setEditingTeacher(null)} className="text-slate-400 hover:text-slate-700"><X className="w-4 h-4" /></button>
            </div>
            <form onSubmit={handleEditTeacherSubmit} className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
              <div className="sm:col-span-2">
                <label className={text.label}>Full Name:</label>
                <input type="text" value={editTFullName} onChange={(e) => setEditTFullName(e.target.value)} className={control.input} required />
              </div>
              <div>
                <label className={text.label}>Phone:</label>
                <input type="tel" value={editTPhone} onChange={(e) => setEditTPhone(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 font-mono text-start" required />
              </div>
              <div>
                <label className={text.label}>Email:</label>
                <input type="email" value={editTEmail} onChange={(e) => setEditTEmail(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 font-mono text-start" />
              </div>
              <div className="sm:col-span-2">
                <label className={text.label}>Contract / Salary Model:</label>
                <select value={editTSalaryType} onChange={(e) => setEditTSalaryType(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 cursor-pointer font-bold">
                  <option value="fixed">Fixed Monthly Salary</option>
                  <option value="per_skill">Per Skill (Count × Default Rate)</option>
                  <option value="per_level">Per Level (Rule Engine Rate)</option>
                  <option value="per_session">Per Session (Completed Sessions)</option>
                  <option value="hybrid">Hybrid (Base + Per Skill)</option>
                </select>
              </div>
              <div>
                <label className={text.label}>Base Salary (AFN):</label>
                <input type="number" value={editTBaseSalary} onChange={(e) => setEditTBaseSalary(Number(e.target.value))} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 font-mono" min={0} required />
              </div>
              <div>
                <label className={text.label}>Default Skill Rate (AFN):</label>
                <input type="number" value={editTDefaultSkillRate} onChange={(e) => setEditTDefaultSkillRate(Number(e.target.value))} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 font-mono" min={0} />
                <p className="text-[9px] text-slate-400 mt-1">Used in 'Per Skill' or 'Per Session' if specific class rate is not set.</p>
              </div>
              <div>
                <label className={text.label}>Specialty:</label>
                <input type="text" value={editTSpecialization} onChange={(e) => setEditTSpecialization(e.target.value)} className={control.input} />
              </div>
              <div>
                <label className={text.label}>Qualification:</label>
                <input type="text" value={editTQualification} onChange={(e) => setEditTQualification(e.target.value)} className={control.input} />
              </div>
              <div>
                <label className={text.label}>Contract Type:</label>
                <select value={editTContractType} onChange={(e) => setEditTContractType(e.target.value as any)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 cursor-pointer">
                  <option value="monthly">Monthly (Full-time)</option>
                  <option value="hourly">Hourly (Part-time)</option>
                  <option value="per_session">Per Session</option>
                </select>
              </div>
              <div>
                <label className={text.label}>Status:</label>
                <select value={editTStatus} onChange={(e) => setEditTStatus(e.target.value as any)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 cursor-pointer">
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                  <option value="on_leave">On Leave</option>
                </select>
              </div>
              <div className="sm:col-span-2 flex justify-end gap-2 pt-2 border-t border-slate-100 mt-2">
                <button type="button" onClick={() => setEditingTeacher(null)} className="bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold py-2 px-4 rounded-lg cursor-pointer">Cancel</button>
                <button type="submit" className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2 px-5 rounded-lg cursor-pointer shadow-sm">Save Changes</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Employee Modal */}
      {editingEmployee && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white border border-slate-200 rounded-2xl p-6 max-w-md w-full space-y-4 shadow-xl">
            <div className="flex justify-between items-center border-b border-slate-100 pb-3">
              <h3 className="font-extrabold text-slate-900 text-sm">Edit Employee Details</h3>
              <button onClick={() => setEditingEmployee(null)} className="text-slate-400 hover:text-slate-700"><X className="w-4 h-4" /></button>
            </div>
            <form onSubmit={handleEditEmployeeSubmit} className="grid grid-cols-1 gap-3 text-xs">
              <div><label className={text.label}>Full Name:</label><input type="text" value={editEFullName} onChange={(e) => setEditEFullName(e.target.value)} className={control.input} required /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={text.label}>Phone:</label><input type="tel" value={editEPhone} onChange={(e) => setEditEPhone(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 font-mono text-start" required /></div>
                <div><label className={text.label}>Email:</label><input type="email" value={editEEmail} onChange={(e) => setEditEEmail(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 font-mono text-start" /></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={text.label}>Role:</label><input type="text" value={editERole} onChange={(e) => setEditERole(e.target.value)} className={control.input} required /></div>
                <div><label className={text.label}>Base Salary (AFN):</label><input type="number" value={editEBaseSalary} onChange={(e) => setEditEBaseSalary(Number(e.target.value))} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 font-mono" min={0} required /></div>
              </div>
              <div><label className={text.label}>Status:</label><select value={editEStatus} onChange={(e) => setEditEStatus(e.target.value as any)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 cursor-pointer"><option value="active">Active</option><option value="inactive">Inactive</option></select></div>
              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                <button type="button" onClick={() => setEditingEmployee(null)} className="bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold py-2 px-4 rounded-lg cursor-pointer">Cancel</button>
                <button type="submit" className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2 px-5 rounded-lg cursor-pointer shadow-sm">Save Changes</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Pay Teacher Salary Modal */}
      {salaryTeacher && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xl w-full max-w-md text-xs space-y-4">
            <div className="flex justify-between items-start border-b border-slate-100 pb-2.5">
              <div><h3 className="font-extrabold text-slate-900 text-sm">Process Teacher Salary</h3><p className="text-[10px] text-slate-400 mt-0.5">Contract: {salaryModelLabel(salaryTeacher.salaryType)}</p></div>
              <button onClick={() => setSalaryTeacher(null)} className="text-slate-400 hover:text-slate-600 cursor-pointer"><X className="w-4 h-4" /></button>
            </div>

            <div className="bg-indigo-50/50 border border-indigo-100 rounded-xl p-3.5 space-y-2">
              <div className="flex justify-between"><span className="text-slate-500">Payee:</span><span className="font-bold text-slate-950">{salaryTeacher.fullName}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Performance Score:</span><span className={`font-mono font-bold ${salaryTeacher.performanceScore >= 80 ? 'text-emerald-600' : 'text-amber-600'}`}>{salaryTeacher.performanceScore > 0 ? `${salaryTeacher.performanceScore}/100` : 'Not evaluated'}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Due this month:</span><span className="font-mono font-bold text-indigo-600">{salaryStatusLoading ? 'Calculating...' : teacherSalaryStatus ? formatAFN(teacherSalaryStatus.due) : 'N/A'}</span></div>
              {teacherSalaryStatus && <div className="flex justify-between"><span className="text-slate-500">Already paid:</span><span className="font-mono font-semibold text-slate-700">{formatAFN(teacherSalaryStatus.paid)}</span></div>}
              {teacherSalaryStatus && <div className="flex justify-between border-t border-indigo-100 pt-1.5"><span className="text-slate-500">Remaining:</span><span className="font-mono font-bold text-emerald-700">{formatAFN(teacherSalaryStatus.remaining)}</span></div>}
              <div className="flex justify-between border-t border-indigo-100 pt-1.5"><span className="text-slate-500">Salary Budget Balance:</span><span className={`font-mono font-semibold ${teacherBudget && teacherBudget.currentAmount < amountPaid ? 'text-rose-600' : 'text-emerald-600'}`}>{teacherBudget ? formatAFN(teacherBudget.currentAmount) : 'Not found'}</span></div>
            </div>

            {/* SKILL WORKLOAD — shown for EVERY contract type. On a fixed
                contract the Skills are real teaching workload that do not
                add to pay, so they are displayed separately from the money. */}
            {teacherSalaryStatus && (
              <div className="bg-violet-50/60 border border-violet-100 rounded-xl p-3.5 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-extrabold uppercase tracking-wide text-violet-700">Skill Workload</span>
                  <span className="text-[9px] text-slate-400">{salaryModelLabel(salaryTeacher.salaryType)}</span>
                </div>
                <div className="flex justify-between"><span className="text-slate-500">Actual Skills:</span><span className="font-mono font-bold text-violet-700">{teacherSalaryStatus.skillCount ?? 0}</span></div>
                {(teacherSalaryStatus.targetSkills ?? 0) > 0 && (
                  <>
                    <div className="flex justify-between"><span className="text-slate-500">Target Skills:</span><span className="font-mono font-semibold text-slate-700">{teacherSalaryStatus.targetSkills}</span></div>
                    {(teacherSalaryStatus.shortfall ?? 0) > 0 && <div className="flex justify-between"><span className="text-slate-500">Shortfall:</span><span className="font-mono font-bold text-amber-600">{teacherSalaryStatus.shortfall}</span></div>}
                    {(teacherSalaryStatus.excess ?? 0) > 0 && <div className="flex justify-between"><span className="text-slate-500">Excess:</span><span className="font-mono font-bold text-emerald-600">{teacherSalaryStatus.excess}</span></div>}
                  </>
                )}
                <div className="flex justify-between border-t border-violet-100 pt-1.5"><span className="text-slate-500">Fixed component:</span><span className="font-mono font-semibold text-slate-700">{formatAFN(teacherSalaryStatus.base ?? 0)}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Skill component:</span><span className="font-mono font-semibold text-slate-700">{formatAFN(teacherSalaryStatus.skillsTotal ?? 0)}</span></div>
                {salaryTeacher.salaryType === 'fixed' && (teacherSalaryStatus.skillCount ?? 0) > 0 && (
                  <p className="text-[9px] text-slate-500 leading-snug pt-0.5">Fixed contract: these Skills are recorded as teaching workload and do not change the fixed salary.</p>
                )}
              </div>
            )}

            {(teacherSalaryStatus as typeof teacherSalaryStatus & { isBlocked?: boolean })?.isBlocked && (
              <div className="bg-rose-50 border border-rose-200 rounded-xl p-3 text-rose-700 flex items-center gap-2">
                <ShieldAlert className="w-4 h-4" /> Payment blocked by Rule Engine.
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={text.label}>Payment Type:</label>
                <select value={paymentType === 'partial' ? 'partial' : 'full'} onChange={(e) => handleTeacherPaymentTypeChange(e.target.value as 'full' | 'partial')} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 cursor-pointer font-bold">
                  <option value="full">Full Salary</option><option value="partial">Partial</option>
                </select>
              </div>
              <div>
                <label className={text.label}>Amount (AFN):</label>
                <input type="number" value={amountPaid} onChange={(e) => setAmountPaid(Number(e.target.value))} disabled={paymentType === 'full'} className={`w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 font-mono font-bold ${paymentType === 'full' ? 'opacity-70 cursor-not-allowed bg-slate-100' : ''}`} min={1} />
              </div>
            </div>

            <div>
              <label className={text.label}>For Work Month:</label>
              <select value={selectedMonth} onChange={(e) => setSelectedMonth(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 cursor-pointer">
                {monthOptions.map((m) => <option key={m} value={m}>{jalaliPeriodLabel(m)}</option>)}
              </select>
            </div>

            <div className="flex gap-2 justify-end pt-3 border-t border-slate-100">
              <button onClick={() => setSalaryTeacher(null)} className="px-4 py-2 bg-slate-100 text-slate-600 rounded-lg font-semibold hover:bg-slate-200 cursor-pointer">Cancel</button>
              <button onClick={handlePayTeacherSalaryConfirm} disabled={(teacherBudget ? teacherBudget.currentAmount < amountPaid || amountPaid <= 0 : true) || (teacherSalaryStatus as typeof teacherSalaryStatus & { isBlocked?: boolean })?.isBlocked} className="px-4 py-2 bg-emerald-600 text-white rounded-lg font-semibold hover:bg-emerald-700 cursor-pointer shadow-sm disabled:opacity-50 disabled:cursor-not-allowed">Confirm & Pay</button>
            </div>
          </div>
        </div>
      )}

      {/* Pay Employee Salary Modal */}
      {salaryEmployee && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xl w-full max-w-md text-xs space-y-4">
            <div className="flex justify-between items-start border-b border-slate-100 pb-2.5">
              <div><h3 className="font-extrabold text-slate-900 text-sm">Process Employee Salary</h3><p className="text-[10px] text-slate-400 mt-0.5">{salaryEmployee.role}</p></div>
              <button onClick={() => setSalaryEmployee(null)} className="text-slate-400 hover:text-slate-600 cursor-pointer"><X className="w-4 h-4" /></button>
            </div>
            <div className="bg-teal-50/50 border border-teal-100 rounded-xl p-3.5 space-y-2">
              <div className="flex justify-between"><span className="text-slate-500">Employee:</span><span className="font-bold text-slate-950">{salaryEmployee.fullName}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Base Salary:</span><span className="font-mono font-bold text-teal-600">{formatAFN(salaryEmployee.baseSalary)}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Budget Balance:</span><span className={`font-mono font-semibold ${employeeBudget && employeeBudget.currentAmount < amountPaid ? 'text-rose-600' : 'text-emerald-600'}`}>{employeeBudget ? formatAFN(employeeBudget.currentAmount) : 'Not found'}</span></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={text.label}>Payment Type:</label>
                <select value={paymentType} onChange={(e) => handleEmployeePaymentTypeChange(e.target.value as any)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 cursor-pointer font-bold">
                  <option value="full">Full Salary</option><option value="partial">Partial</option><option value="advance">Advance</option>
                </select>
              </div>
              <div>
                <label className={text.label}>Amount (AFN):</label>
                <input type="number" value={amountPaid} onChange={(e) => setAmountPaid(Number(e.target.value))} disabled={paymentType === 'full'} className={`w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 font-mono font-bold ${paymentType === 'full' ? 'opacity-70 cursor-not-allowed bg-slate-100' : ''}`} min={1} />
              </div>
            </div>
            <div>
              <label className={text.label}>For Work Month:</label>
              <select value={selectedMonth} onChange={(e) => setSelectedMonth(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 cursor-pointer">
                {monthOptions.map((m) => <option key={m} value={m}>{jalaliPeriodLabel(m)}</option>)}
              </select>
            </div>
            <div className="flex gap-2 justify-end pt-3 border-t border-slate-100">
              <button onClick={() => setSalaryEmployee(null)} className="px-4 py-2 bg-slate-100 text-slate-600 rounded-lg font-semibold hover:bg-slate-200 cursor-pointer">Cancel</button>
              <button onClick={handlePayEmployeeSalaryConfirm} disabled={employeeBudget ? employeeBudget.currentAmount < amountPaid || amountPaid <= 0 : true} className="px-4 py-2 bg-teal-600 text-white rounded-lg font-semibold hover:bg-teal-700 cursor-pointer shadow-sm disabled:opacity-50 disabled:cursor-not-allowed">Confirm & Pay</button>
            </div>
          </div>
        </div>
      )}

      {/* Evaluation Modal */}
      {evaluatingTeacher && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white border border-slate-200 rounded-2xl p-6 max-w-lg w-full space-y-4 shadow-xl">
            <div className="flex justify-between items-center border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <ClipboardCheck className="w-5 h-5 text-indigo-600" />
                <div><h3 className="font-extrabold text-slate-900 text-sm">Teacher Evaluation (100 Points)</h3><p className={text.meta}>Evaluating: {evaluatingTeacher.fullName}</p></div>
              </div>
              <button onClick={() => setEvaluatingTeacher(null)} className="text-slate-400 hover:text-slate-700"><X className="w-4 h-4" /></button>
            </div>
            <form onSubmit={handleEvalSubmit} className="space-y-4 text-xs">
              <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-3">
                <p className="font-bold text-slate-700 text-[11px]">Performance Appraisal (100 Points):</p>
                <div>
                  <label className="flex justify-between text-slate-600 font-semibold mb-1">Teaching Skills & Mastery <span className="text-indigo-600 font-mono">{evalTeaching}/40</span></label>
                  <input type="range" min="0" max="40" value={evalTeaching} onChange={(e) => setEvalTeaching(Number(e.target.value))} className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-indigo-600" />
                </div>
                <div>
                  <label className="flex justify-between text-slate-600 font-semibold mb-1">Class Management & Discipline <span className="text-indigo-600 font-mono">{evalManagement}/30</span></label>
                  <input type="range" min="0" max="30" value={evalManagement} onChange={(e) => setEvalManagement(Number(e.target.value))} className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-indigo-600" />
                </div>
                <div>
                  <label className="flex justify-between text-slate-600 font-semibold mb-1">Communication & Punctuality <span className="text-indigo-600 font-mono">{evalCommunication}/30</span></label>
                  <input type="range" min="0" max="30" value={evalCommunication} onChange={(e) => setEvalCommunication(Number(e.target.value))} className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-indigo-600" />
                </div>
              </div>
              <div className="bg-emerald-50 p-3 rounded-xl border border-emerald-200 flex justify-between items-center">
                <span className="font-bold text-emerald-800">Total Appraisal Score:</span>
                <span className="font-mono font-black text-emerald-700 text-lg">{totalEvalScore} / 100</span>
              </div>
              <div>
                <label className={text.label}>Appraisal Notes (Optional):</label>
                <textarea value={evalNotes} onChange={(e) => setEvalNotes(e.target.value)} rows={2} className={control.input} placeholder="Strengths, areas to improve..."></textarea>
              </div>
              <div className="bg-amber-50 p-2 rounded-lg border border-amber-100 text-[10px] text-amber-800">
                All three criteria must be scored — the appraisal is 100 points total and is recorded in full.
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                <button type="button" onClick={() => setEvaluatingTeacher(null)} className="px-4 py-2 bg-slate-100 text-slate-600 rounded-lg font-semibold hover:bg-slate-200 cursor-pointer">Cancel</button>
                <button type="submit" className="px-5 py-2 bg-indigo-600 text-white rounded-lg font-bold hover:bg-indigo-700 cursor-pointer shadow-sm flex items-center gap-1"><Check className="w-4 h-4" /> Submit Evaluation</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Printable Payslip */}
      {printedPayslip && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50 overflow-y-auto">
          <div className="bg-white border-2 border-indigo-200 rounded-3xl p-6 shadow-2xl w-full max-w-2xl text-xs space-y-6">
            <div className="flex justify-between items-center border-b border-slate-100 pb-3">
              <h4 className="font-extrabold text-slate-900 text-sm flex items-center gap-2"><Check className="w-4 h-4 text-emerald-500" /> Salary Slip Issued</h4>
              <button onClick={() => setPrintedPayslip(null)} className="p-1.5 bg-slate-50 hover:bg-slate-100 text-slate-400 rounded-xl cursor-pointer"><X className="w-4 h-4" /></button>
            </div>
            <div id="printed-staff-payslip-area" className="bg-white border-2 border-dashed border-slate-300 rounded-2xl p-6 space-y-6 text-slate-800 relative select-text">
              <div className="flex flex-col sm:flex-row justify-between items-center pb-4 border-b-2 border-slate-200 gap-4">
                <div className="text-center sm:text-start space-y-1"><h3 className="font-black text-slate-950 text-base">{BRAND_NAME}</h3><p className="text-[10px] text-slate-400 font-bold">Finance calculation, salary payment, and central treasury</p></div>
                <div className="text-center sm:text-start space-y-1 font-mono text-[10px] text-slate-500"><p className="font-bold text-slate-900 text-xs">Receipt No: {printedPayslip.serialNo}</p><p>Date: <ShamsiDate value={printedPayslip.date} format="long" /></p></div>
              </div>
              <div className="bg-slate-50 border border-slate-100 rounded-xl p-2.5 text-center font-black text-slate-900 text-xs tracking-wider">Official monthly salary settlement slip</div>
              <div className="grid grid-cols-2 gap-4 text-[11px]">
                <div className="space-y-2 bg-slate-50/50 p-3 rounded-xl border border-slate-100">
                  <p className="flex justify-between"><span className="text-slate-500 font-bold">Employee Name:</span><strong className="text-slate-950 font-black">{printedPayslip.fullName}</strong></p>
                  <p className="flex justify-between"><span className="text-slate-500 font-bold">Role:</span><strong className="text-indigo-600 font-bold">{printedPayslip.role}</strong></p>
                  <p className="flex justify-between"><span className="text-slate-500 font-bold">Work Month:</span><strong className="text-slate-800 font-bold">{jalaliPeriodLabel(printedPayslip.month)}</strong></p>
                </div>
                <div className="space-y-2 bg-slate-50/50 p-3 rounded-xl border border-slate-100">
                  <p className="flex justify-between"><span className="text-slate-500 font-bold">Base Amount:</span><strong className="text-slate-950 font-mono font-bold">{formatAFN(printedPayslip.baseSalary)}</strong></p>
                  <p className="flex justify-between"><span className="text-slate-500 font-bold">Settlement Type:</span><span className="text-slate-800 font-bold">{printedPayslip.paymentType.toUpperCase()}</span></p>
                  <p className="flex justify-between"><span className="text-slate-500 font-bold">Net Paid:</span><strong className="text-emerald-600 font-mono font-black text-xs bg-emerald-50 px-2 py-0.5 rounded border border-emerald-100">{formatAFN(printedPayslip.amount)}</strong></p>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4 pt-10 text-center text-[10px] text-slate-500 font-bold">
                <div className="space-y-12"><p>Recipient Signature:</p><p className="text-slate-300 font-normal">.................................</p></div>
                <div className="space-y-12"><p>Finance Manager:</p><p className="text-slate-300 font-normal">.................................</p></div>
                <div className="space-y-12"><p>Director (Authorized Signatory):</p><p className="text-slate-300 font-normal">.................................</p></div>
              </div>
            </div>
            <div className="flex gap-2 justify-end border-t border-slate-100 pt-4">
              <button onClick={() => setPrintedPayslip(null)} className="px-4 py-2 bg-slate-100 text-slate-600 rounded-xl font-bold hover:bg-slate-200 cursor-pointer">Close</button>
              <button onClick={() => {
                const opened = printPayslip({
                  ...printedPayslip,
                  monthLabel: jalaliPeriodLabel(printedPayslip.month),
                  dateLabel: formatJalali(printedPayslip.date, 'long'),
                  baseSalaryLabel: formatAFN(printedPayslip.baseSalary),
                  amountLabel: formatAFN(printedPayslip.amount),
                });
                if (!opened) triggerToast('The print window was blocked by the browser. Allow pop-ups for this site and try again.', 'error');
              }} className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-black rounded-xl cursor-pointer shadow-md flex items-center gap-1.5"><Award className="w-4 h-4" /> Print Slip</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ============================================================================ 
// Teacher Skill Assignment Modal
// ============================================================================ 
interface TeacherSkillAssignmentModalProps {
  teacher: Teacher;
  classes: ClassType[];
  skills: Skill[];
  assignments: ClassTeacherSkill[];
  onAssign: (classId: string, teacherId: string, skillId: string, monthlyRate: number) => void;
  onEditRate: (assignmentId: string, monthlyRate: number) => void;
  onRemove: (assignmentId: string) => void;
  onClose: () => void;
}

export function TeacherSkillAssignmentModal({ teacher, classes, skills, assignments, onAssign, onEditRate, onRemove, onClose }: TeacherSkillAssignmentModalProps) {
  const [newClassId, setNewClassId] = useState('');
  const [newSkillId, setNewSkillId] = useState('');
  const [newRate, setNewRate] = useState<number>(teacher.defaultSkillRate || 0);
  const [editingRateId, setEditingRateId] = useState<string | null>(null);
  const [editingRateValue, setEditingRateValue] = useState<number>(0);

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newClassId || !newSkillId) {
      return;
    }
    // If rate is 0, use teacher's default rate
    const finalRate = newRate > 0 ? newRate : teacher.defaultSkillRate || 0;
    onAssign(newClassId, teacher.id, newSkillId, finalRate);
    setNewClassId(''); setNewSkillId(''); setNewRate(teacher.defaultSkillRate || 0);
  };

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 z-50 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg my-8 text-xs">
        <div className="flex justify-between items-center p-5 border-b border-slate-100">
          <div><h3 className="font-extrabold text-slate-900 text-sm flex items-center gap-1.5"><Sparkles className="w-4 h-4 text-violet-500" /> Teaching Skills & Rates</h3><p className="text-[10px] text-slate-400 mt-1">Teacher: {teacher.fullName} — Leave rate blank to use default ({formatAFN(teacher.defaultSkillRate || 0)}).</p></div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 cursor-pointer"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-4">
          <div className="space-y-2">
            {assignments.length === 0 ? <p className="text-[11px] text-slate-400 italic text-center py-4 bg-slate-50 rounded-xl">No skills assigned yet.</p> : (
              assignments.map((a) => {
                const cls = classes.find((c) => c.id === a.classId);
                const skill = skills.find((s) => s.id === a.skillId);
                return (
                  <div key={a.id} className="flex items-center justify-between bg-slate-50 border border-slate-100 rounded-xl px-3 py-2">
                    <div><p className="font-bold text-slate-800">{skill?.name || 'Unknown'}</p><p className="text-[10px] text-slate-400 mt-0.5">Class: {cls?.name || 'Unknown'}</p></div>
                    <div className="flex items-center gap-2">
                      {editingRateId === a.id ? (
                        <><input type="number" value={editingRateValue} onChange={(e) => setEditingRateValue(Number(e.target.value))} className="w-24 bg-white border border-indigo-200 rounded-lg px-2 py-1 font-mono text-start" autoFocus /><button onClick={() => { onEditRate(a.id, editingRateValue); setEditingRateId(null); }} className="text-emerald-600 hover:text-emerald-700 cursor-pointer font-bold">✓</button></>
                      ) : (
                        <><span className="font-mono font-extrabold text-slate-900">{formatAFN(a.monthlyRate)}</span><button onClick={() => { setEditingRateId(a.id); setEditingRateValue(a.monthlyRate); }} className="text-indigo-500 hover:text-indigo-700 cursor-pointer"><Check className="w-3.5 h-3.5" /></button></>
                      )}
                      <button onClick={() => onRemove(a.id)} className="text-rose-400 hover:text-rose-600 cursor-pointer font-bold">×</button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
          <form onSubmit={handleAdd} className="border-t border-slate-100 pt-4 space-y-3">
            <p className="font-bold text-slate-700">Add new skill assignment:</p>
            <div className="grid grid-cols-2 gap-2">
              <select value={newClassId} onChange={(e) => setNewClassId(e.target.value)} className="bg-slate-50 border border-slate-200 rounded-lg px-2 py-2 cursor-pointer" required><option value="">-- Class --</option>{classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
              <select value={newSkillId} onChange={(e) => setNewSkillId(e.target.value)} className="bg-slate-50 border border-slate-200 rounded-lg px-2 py-2 cursor-pointer" required><option value="">-- Skill --</option>{skills.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
            </div>
            <div className="flex gap-2">
              <input type="number" placeholder={`Rate (Default: ${teacher.defaultSkillRate || 0})`} value={newRate} onChange={(e) => setNewRate(Number(e.target.value))} className="flex-1 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 font-mono" min={0} />
              <button type="submit" className="px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white rounded-lg font-bold cursor-pointer flex items-center gap-1 shrink-0"><Plus className="w-3.5 h-3.5" /> Add</button>
            </div>
          </form>
        </div>
        <div className="p-4 border-t border-slate-100 flex justify-end"><button onClick={onClose} className="px-5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg font-bold cursor-pointer">Close</button></div>
      </div>
    </div>
  );
}