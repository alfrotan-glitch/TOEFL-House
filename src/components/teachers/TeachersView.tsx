/**
 * @license SPDX-License-Identifier: Apache-2.0
 */
import React, { useState, useEffect, useMemo } from 'react';
import {Award, Plus, Wallet, Users, Search, X, Sparkles} from 'lucide-react';
import {Teacher, Employee, Class, BudgetLine, UserRole, Skill, ClassTeacherSkill, Branch, Campus} from '../../types';
import type {TeacherSalaryStatus} from '../../apiStore';
import TeachersModals, { TeacherSkillAssignmentModal } from './TeachersModals';
import {TeacherDirectoryPanel} from './TeacherDirectoryPanel';
import {EmployeeDirectoryPanel} from './EmployeeDirectoryPanel';
import TeacherProfileDrawer from './TeacherProfileDrawer'; // Added Profile Drawer
import {formatAFN} from '../../utils/format';
import {api} from '../../api/client';

interface TeachersViewProps {
  teachers: Teacher[];
  employees: Employee[];
  classes: Class[];
  budgetLines: BudgetLine[];
  activeRole: UserRole;
  skills: Skill[];
  classTeacherSkills: ClassTeacherSkill[];
  addTeacher: (fullName: string, phone: string, email: string, baseSalary: number, salaryType?: 'fixed' | 'per_skill' | 'per_level' | 'per_session' | 'hybrid_skill' | 'hybrid_level', specialization?: string, qualification?: string, contractType?: 'monthly' | 'hourly' | 'per_session', branchId?: string, defaultSkillRate?: number) => void;
  editTeacher: (id: string, fullName: string, phone: string, email: string, baseSalary: number, salaryType?: 'fixed' | 'per_skill' | 'per_level' | 'per_session' | 'hybrid_skill' | 'hybrid_level', specialization?: string, qualification?: string, contractType?: 'monthly' | 'hourly' | 'per_session', status?: 'active' | 'inactive' | 'on_leave', defaultSkillRate?: number) => Promise<void>;
  deleteTeacher: (id: string) => Promise<void>;
  transferTeacher: (teacherId: string, targetBranchId: string) => Promise<{ ok: boolean; unassignedActiveClasses?: string[] }>;
  getTeacherSalaryStatus: (teacherId: string, monthName: string) => Promise<TeacherSalaryStatus>;
  branches: Branch[];
  campuses: Campus[];
  currentBranchId: string;
  payTeacherSalary: (teacherId: string, monthName: string, amountPaid: number, paymentType: 'full' | 'partial' | 'advance') => Promise<void>;
  addEmployee: (fullName: string, phone: string, email: string, role: string, baseSalary: number, branchId?: string) => Promise<void>;
  editEmployee: (id: string, fullName: string, phone: string, email: string, role: string, baseSalary: number, status: 'active' | 'inactive') => Promise<void>;
  deleteEmployee: (id: string) => Promise<void>;
  transferEmployee: (employeeId: string, targetBranchId: string) => Promise<unknown>;
  payEmployeeSalary: (employeeId: string, monthName: string, amountPaid: number, paymentType: 'full' | 'partial' | 'advance') => Promise<void>;
  assignTeacherSkill: (classId: string, teacherId: string, skillId: string, monthlyRate: number) => Promise<void>;
  editTeacherSkillRate: (assignmentId: string, monthlyRate: number) => Promise<void>;
  removeTeacherSkill: (assignmentId: string) => Promise<void>;
  triggerToast: (message: string, type: 'success' | 'error' | 'info') => void;
}

export default function TeachersView({
  teachers, employees = [], classes, budgetLines, activeRole, addTeacher, editTeacher, deleteTeacher,
  transferTeacher, getTeacherSalaryStatus, branches, campuses, currentBranchId, payTeacherSalary,
  addEmployee, editEmployee, deleteEmployee, transferEmployee, payEmployeeSalary,
  skills, classTeacherSkills, assignTeacherSkill, editTeacherSkillRate, removeTeacherSkill, triggerToast
}: TeachersViewProps) {
  const [activeCategory, setActiveCategory] = useState<'teachers' | 'employees'>('teachers');
  const [hrSearch, setHrSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [transferringEmployee, setTransferringEmployee] = useState<Employee | null>(null);
  const [transferringTeacher, setTransferringTeacher] = useState<Teacher | null>(null);
  const [transferTargetBranchId, setTransferTargetBranchId] = useState<string>('');
  const [transferBusy, setTransferBusy] = useState(false);
  const [showAddForm, setShowAddForm] = useState<boolean>(false);
  const [managingSkillsFor, setManagingSkillsFor] = useState<Teacher | null>(null);
  const [profileTeacher, setProfileTeacher] = useState<Teacher | null>(null); // State for Profile Drawer

  // Form states (Teacher)
  const [fullName, setFullName] = useState(''); const [phone, setPhone] = useState(''); const [email, setEmail] = useState('');
  const [baseSalary, setBaseSalary] = useState(0); const [salaryType, setSalaryType] = useState('fixed');
  const [defaultSkillRate, setDefaultSkillRate] = useState(0); const [specialization, setSpecialization] = useState('');
  const [qualification, setQualification] = useState(''); const [contractType, setContractType] = useState<'monthly' | 'hourly' | 'per_session'>('monthly');

  // Form states (Employee)
  const [empFullName, setEmpFullName] = useState(''); const [empPhone, setEmpPhone] = useState('');
  const [empEmail, setEmpEmail] = useState(''); const [empRole, setEmpRole] = useState(''); const [empBaseSalary, setEmpBaseSalary] = useState(0);

  // Edit states (Teacher)
  const [editingTeacher, setEditingTeacher] = useState<Teacher | null>(null);
  const [editTFullName, setEditTFullName] = useState(''); const [editTPhone, setEditTPhone] = useState('');
  const [editTEmail, setEditTEmail] = useState(''); const [editTBaseSalary, setEditTBaseSalary] = useState(0);
  const [editTSalaryType, setEditTSalaryType] = useState('fixed'); const [editTSpecialization, setEditTSpecialization] = useState('');
  const [editTQualification, setEditTQualification] = useState(''); const [editTContractType, setEditTContractType] = useState<'monthly' | 'hourly' | 'per_session'>('monthly');
  const [editTStatus, setEditTStatus] = useState<'active' | 'inactive' | 'on_leave'>('active'); const [editTDefaultSkillRate, setEditTDefaultSkillRate] = useState(0);

  // Edit states (Employee)
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);
  const [editEFullName, setEditEFullName] = useState(''); const [editEPhone, setEditEPhone] = useState('');
  const [editEEmail, setEditEEmail] = useState(''); const [editERole, setEditERole] = useState('');
  const [editEBaseSalary, setEditEBaseSalary] = useState(0); const [editEStatus, setEditEStatus] = useState<'active' | 'inactive'>('active');

  // Salary & Eval states
  const [salaryTeacher, setSalaryTeacher] = useState<Teacher | null>(null);
  const [salaryEmployee, setSalaryEmployee] = useState<Employee | null>(null);
  const [selectedMonth, setSelectedMonth] = useState<string>(() => new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' }));
  const [paymentType, setPaymentType] = useState<'full' | 'partial' | 'advance'>('full');
  const [amountPaid, setAmountPaid] = useState<number>(0);
  const [printedPayslip, setPrintedPayslip] = useState<any | null>(null);
  const [teacherSalaryStatus, setTeacherSalaryStatus] = useState<TeacherSalaryStatus | null>(null);
  const [salaryStatusLoading, setSalaryStatusLoading] = useState<boolean>(false);
  const [evaluatingTeacher, setEvaluatingTeacher] = useState<Teacher | null>(null);

  const isOwnerOrFinance = activeRole === 'owner' || activeRole === 'finance' || activeRole === 'manager';
  const isOwnerOrManager = activeRole === 'owner' || activeRole === 'manager';

  const handleCreateTeacher = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fullName || !phone) return triggerToast('Full name and phone number are required.', 'error');
    try {
      await addTeacher(fullName, phone, email, baseSalary, salaryType as 'fixed' | 'per_skill' | 'per_level' | 'per_session' | 'hybrid_skill' | 'hybrid_level', specialization || undefined, qualification || undefined, contractType, currentBranchId, defaultSkillRate > 0 ? defaultSkillRate : undefined);
      setFullName(''); setPhone(''); setEmail(''); setBaseSalary(0); setSalaryType('fixed'); setDefaultSkillRate(0); setSpecialization(''); setQualification(''); setContractType('monthly');
      setShowAddForm(false); triggerToast(`Teacher created with contract: ${salaryType}`, 'success');
    } catch (err) { triggerToast(err instanceof Error ? err.message : 'Could not create teacher.', 'error'); }
  };

  const handleCreateEmployee = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!empFullName || !empPhone || !empRole) return triggerToast('Full name, phone, and role are required.', 'error');
    try {
      await addEmployee(empFullName, empPhone, empEmail, empRole, empBaseSalary, currentBranchId);
      setEmpFullName(''); setEmpPhone(''); setEmpEmail(''); setEmpRole(''); setEmpBaseSalary(0);
      setShowAddForm(false); triggerToast('Employee added successfully.', 'success');
    } catch (err) { triggerToast(err instanceof Error ? err.message : 'Could not add employee.', 'error'); }
  };

  const handleStartEditTeacher = (t: Teacher) => {
    setEditingTeacher(t); setEditTFullName(t.fullName); setEditTPhone(t.phone); setEditTEmail(t.email || '');
    setEditTBaseSalary(t.baseSalary); setEditTSalaryType(t.salaryType || 'fixed'); setEditTSpecialization(t.specialization || '');
    setEditTQualification(t.qualification || ''); setEditTContractType(t.contractType || 'monthly'); setEditTStatus(t.status || 'active'); setEditTDefaultSkillRate(t.defaultSkillRate || 0);
  };

  const handleEditTeacherSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); if (!editingTeacher) return;
    try {
      await editTeacher(editingTeacher.id, editTFullName, editTPhone, editTEmail, editTBaseSalary, editTSalaryType as 'fixed' | 'per_skill' | 'per_level' | 'per_session' | 'hybrid_skill' | 'hybrid_level', editTSpecialization || undefined, editTQualification || undefined, editTContractType, editTStatus, editTDefaultSkillRate);
      setEditingTeacher(null); triggerToast('Teacher details updated.', 'success');
    } catch (err) { triggerToast(err instanceof Error ? err.message : 'Could not update teacher.', 'error'); }
  };

  const handleStartEditEmployee = (emp: Employee) => {
    setEditingEmployee(emp); setEditEFullName(emp.fullName); setEditEPhone(emp.phone); setEditEEmail(emp.email || '');
    setEditERole(emp.role); setEditEBaseSalary(emp.baseSalary); setEditEStatus(emp.status || 'active');
  };

  const handleEditEmployeeSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); if (!editingEmployee) return;
    try {
      await editEmployee(editingEmployee.id, editEFullName, editEPhone, editEEmail, editERole, editEBaseSalary, editEStatus);
      setEditingEmployee(null); triggerToast('Employee details updated.', 'success');
    } catch (err) { triggerToast(err instanceof Error ? err.message : 'Could not update employee.', 'error'); }
  };

  const handleEvaluateSubmit = async (score: number, notes: string) => {
    if (!evaluatingTeacher) return;
    try {
      await api.post(`/teachers/${evaluatingTeacher.id}/evaluation`, { score, notes });
      triggerToast('Evaluation submitted successfully.', 'success'); 
      setEvaluatingTeacher(null);
      // Dispatch event to refresh data globally
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('erp-teachers-refresh'));
    } catch (err: any) { 
      triggerToast(err?.response?.data?.error || 'Evaluation failed.', 'error'); 
    }
  };

  const getTeacherMonthlyTotal = (teacher: Teacher): number | null => {
    switch (teacher.salaryType) {
      case 'fixed': return teacher.baseSalary;
      default: return null;
    }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!salaryTeacher) {
        if (!cancelled) { setTeacherSalaryStatus(null); setSalaryStatusLoading(false); }
        return;
      }
      if (!cancelled) { setTeacherSalaryStatus(null); setSalaryStatusLoading(true); }
      try {
        const status = await getTeacherSalaryStatus(salaryTeacher.id, selectedMonth);
        if (!cancelled) setTeacherSalaryStatus(status);
      } catch {
        if (!cancelled) setTeacherSalaryStatus(null);
      } finally {
        if (!cancelled) setSalaryStatusLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [salaryTeacher, selectedMonth, getTeacherSalaryStatus]);

  // Auto-fill the payment amount whenever the teacher, salary status, or
  // payment type changes — by adjusting state during render (no
  // setState-in-effect). Manual edits to the amount are preserved because the
  // key is unchanged while typing.
  const [prevSalaryAmountKey, setPrevSalaryAmountKey] = useState('');
  const salaryAmountKey = `${salaryTeacher?.id ?? 'none'}|${paymentType}|${teacherSalaryStatus?.due ?? ''}|${teacherSalaryStatus?.remaining ?? ''}`;
  if (prevSalaryAmountKey !== salaryAmountKey) {
    setPrevSalaryAmountKey(salaryAmountKey);
    if (salaryTeacher) {
      const due = teacherSalaryStatus?.due ?? getTeacherMonthlyTotal(salaryTeacher) ?? 0;
      const remaining = teacherSalaryStatus?.remaining ?? due;
      if (paymentType === 'full') setAmountPaid(remaining > 0 ? remaining : due);
      else if (paymentType === 'advance') setAmountPaid(Math.round(due * 0.4));
      else if (paymentType === 'partial') setAmountPaid(Math.round(due * 0.5));
    }
  }

  const handleTeacherPaymentTypeChange = (type: 'full' | 'partial' | 'advance') => setPaymentType(type);
  const handleEmployeePaymentTypeChange = (type: 'full' | 'partial' | 'advance') => {
    setPaymentType(type);
    if (salaryEmployee) {
      if (type === 'full') setAmountPaid(salaryEmployee.baseSalary);
      else if (type === 'advance') setAmountPaid(Math.round(salaryEmployee.baseSalary * 0.4));
      else if (type === 'partial') setAmountPaid(Math.round(salaryEmployee.baseSalary * 0.5));
    }
  };

  const handlePayTeacherSalaryConfirm = async () => {
    if (!salaryTeacher || amountPaid <= 0) return;
    try {
      await payTeacherSalary(salaryTeacher.id, selectedMonth, amountPaid, paymentType);
      // Payslip is only printed after the payment was confirmed by the server.
      setPrintedPayslip({ fullName: salaryTeacher.fullName, role: 'Teacher', month: selectedMonth, amount: amountPaid, baseSalary: salaryTeacher.baseSalary, paymentType, serialNo: 'PAY-TCH-' + Math.floor(Math.random() * 90000 + 10000), date: new Date().toISOString().split('T')[0] });
      setSalaryTeacher(null);
    } catch (err) { triggerToast(err instanceof Error ? err.message : 'Salary payment failed.', 'error'); }
  };

  const handlePayEmployeeSalaryConfirm = async () => {
    if (!salaryEmployee || amountPaid <= 0) return;
    try {
      await payEmployeeSalary(salaryEmployee.id, selectedMonth, amountPaid, paymentType);
      // Payslip is only printed after the payment was confirmed by the server.
      setPrintedPayslip({ fullName: salaryEmployee.fullName, role: salaryEmployee.role, month: selectedMonth, amount: amountPaid, baseSalary: salaryEmployee.baseSalary, paymentType, serialNo: 'PAY-EMP-' + Math.floor(Math.random() * 90000 + 10000), date: new Date().toISOString().split('T')[0] });
      setSalaryEmployee(null);
    } catch (err) { triggerToast(err instanceof Error ? err.message : 'Salary payment failed.', 'error'); }
  };

  const { filteredTeachers, filteredEmployees } = useMemo(() => {
    const q = hrSearch.trim().toLowerCase();
    const matchesSearch = (name: string, phone?: string | null, extra?: string | null) => !q || name.toLowerCase().includes(q) || (phone || '').toLowerCase().includes(q) || (extra || '').toLowerCase().includes(q);
    const matchesStatus = (status?: string | null) => statusFilter === 'all' || (status || 'active').toLowerCase() === statusFilter;
    return {
      filteredTeachers: teachers.filter(x => matchesSearch(x.fullName, x.phone, x.specialization) && matchesStatus(x.status)),
      filteredEmployees: employees.filter(x => matchesSearch(x.fullName, x.phone, x.role) && matchesStatus(x.status))
    };
  }, [teachers, employees, hrSearch, statusFilter]);

  const teacherBudget = budgetLines.find(b => (b as any).purpose === 'teacher_salary') || budgetLines.find(b => b.id === 'b1');
  const employeeBudget = budgetLines.find(b => (b as any).purpose === 'employee_salary') || budgetLines.find(b => b.id === 'b2');
  const activeTeacherCount = teachers.filter((x) => (x.status || 'active') === 'active').length;
  const activeEmployeeCount = employees.filter((x) => (x.status || 'active') === 'active').length;

  return (
    <div className="space-y-6 font-sans text-left bg-slate-50 min-h-screen p-4 md:p-8" dir="ltr" id="teachers-view-root">
      
      {/* Premium Header */}
      <div className="bg-white p-6 rounded-3xl shadow-sm border border-slate-200 flex flex-col md:flex-row justify-between items-center gap-4">
        <div>
          <h2 className="text-2xl font-extrabold text-slate-900 tracking-tight flex items-center gap-2">
            <Sparkles className="w-6 h-6 text-indigo-600" />
            Human Resources
          </h2>
          <p className="text-sm text-slate-500 mt-1">Manage your faculty, staff, contracts, evaluations, and payroll.</p>
        </div>
        {isOwnerOrFinance && (
          <button onClick={() => setShowAddForm(!showAddForm)} className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs px-5 py-3 rounded-xl cursor-pointer shadow-md transition-all hover:-translate-y-0.5">
            <Plus className="w-4 h-4" /> {activeCategory === 'teachers' ? 'New Teacher' : 'New Employee'}
          </button>
        )}
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-200 flex items-center gap-4">
          <div className="p-3 bg-indigo-50 rounded-xl text-indigo-600"><Award className="w-6 h-6" /></div>
          <div><p className="text-xs text-slate-400 font-semibold">Active Teachers</p><p className="text-xl font-black text-slate-900">{activeTeacherCount}</p></div>
        </div>
        <div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-200 flex items-center gap-4">
          <div className="p-3 bg-teal-50 rounded-xl text-teal-600"><Users className="w-6 h-6" /></div>
          <div><p className="text-xs text-slate-400 font-semibold">Active Employees</p><p className="text-xl font-black text-slate-900">{activeEmployeeCount}</p></div>
        </div>
        <div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-200 flex items-center gap-4">
          <div className="p-3 bg-emerald-50 rounded-xl text-emerald-600"><Wallet className="w-6 h-6" /></div>
          <div><p className="text-xs text-slate-400 font-semibold">Teacher Budget</p><p className="text-lg font-black text-slate-900">{teacherBudget ? formatAFN(teacherBudget.currentAmount) : 'N/A'}</p></div>
        </div>
        <div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-200 flex items-center gap-4">
          <div className="p-3 bg-amber-50 rounded-xl text-amber-600"><Wallet className="w-6 h-6" /></div>
          <div><p className="text-xs text-slate-400 font-semibold">Employee Budget</p><p className="text-lg font-black text-slate-900">{employeeBudget ? formatAFN(employeeBudget.currentAmount) : 'N/A'}</p></div>
        </div>
      </div>

      {/* Toolbar: Tabs, Search, Filters */}
      <div className="bg-white p-4 rounded-2xl shadow-sm border border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="bg-slate-100 p-1 rounded-xl flex gap-1 w-full md:w-auto">
          <button onClick={() => { setActiveCategory('teachers'); setShowAddForm(false); }} className={`flex-1 md:flex-none flex items-center justify-center gap-2 px-6 py-2 rounded-lg text-xs font-bold transition-all cursor-pointer ${activeCategory === 'teachers' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>
            <Award className="w-4 h-4" /> Teachers
          </button>
          <button onClick={() => { setActiveCategory('employees'); setShowAddForm(false); }} className={`flex-1 md:flex-none flex items-center justify-center gap-2 px-6 py-2 rounded-lg text-xs font-bold transition-all cursor-pointer ${activeCategory === 'employees' ? 'bg-white text-teal-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>
            <Users className="w-4 h-4" /> Employees
          </button>
        </div>
        
        <div className="flex items-center gap-3 w-full md:w-auto">
          <div className="relative flex-1 md:w-64">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input value={hrSearch} onChange={(e) => setHrSearch(e.target.value)} placeholder="Search name, phone..." className="w-full pl-9 pr-3 py-2 text-xs border border-slate-200 rounded-xl bg-slate-50 font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
          </div>
          <div className="flex items-center gap-1.5 bg-slate-100 p-1 rounded-xl">
            {(['all', 'active', 'inactive'] as const).map(s => (
              <button key={s} onClick={() => setStatusFilter(s)} className={`text-[10px] font-bold px-3 py-1.5 rounded-lg border capitalize transition-all ${statusFilter === s ? 'bg-white text-slate-900 shadow-sm border-white' : 'text-slate-500 border-transparent hover:bg-slate-200/50'}`}>{s}</button>
            ))}
          </div>
        </div>
      </div>

      {/* Inline Add Form (Beautiful Card) */}
      {showAddForm && (
        <div className="bg-white border border-indigo-200 rounded-3xl p-6 shadow-lg max-w-2xl mx-auto animate-in fade-in duration-300">
          <div className="flex justify-between items-center mb-4 border-b border-slate-100 pb-3">
            <h3 className="text-base font-extrabold text-slate-900">{activeCategory === 'teachers' ? 'Register New Teacher' : 'Register New Employee'}</h3>
            <button onClick={() => setShowAddForm(false)} className="text-slate-400 hover:text-slate-700 p-1 rounded-full hover:bg-slate-100"><X className="w-5 h-5" /></button>
          </div>
          {activeCategory === 'teachers' ? (
            <form onSubmit={handleCreateTeacher} className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
              <div><label className="block text-slate-600 mb-1 font-medium">Full Name:</label><input type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5" required /></div>
              <div><label className="block text-slate-600 mb-1 font-medium">Phone:</label><input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 font-mono text-left" required /></div>
              <div><label className="block text-slate-600 mb-1 font-medium">Email:</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 font-mono text-left" /></div>
              <div><label className="block text-slate-600 mb-1 font-medium">Contract Type:</label><select value={salaryType} onChange={(e) => setSalaryType(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 cursor-pointer font-semibold"><option value="fixed">Fixed Monthly</option><option value="per_skill">Per Skill</option><option value="per_level">Per Level</option><option value="per_session">Per Session</option><option value="hybrid_skill">Hybrid Skill</option><option value="hybrid_level">Hybrid Level</option></select></div>
              <div><label className="block text-slate-600 mb-1 font-medium">Base Salary (AFN):</label><input type="number" value={baseSalary} onChange={(e) => setBaseSalary(Number(e.target.value))} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 font-mono" required /></div>
              <div><label className="block text-slate-600 mb-1 font-medium">Default Skill Rate (AFN):</label><input type="number" value={defaultSkillRate} onChange={(e) => setDefaultSkillRate(Number(e.target.value))} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 font-mono" /></div>
              <div className="sm:col-span-2 flex justify-end gap-2 pt-2 border-t border-slate-100 mt-2"><button type="button" onClick={() => setShowAddForm(false)} className="px-4 py-2 bg-slate-100 text-slate-600 rounded-lg font-bold hover:bg-slate-200 cursor-pointer">Cancel</button><button type="submit" className="px-6 py-2 bg-indigo-600 text-white rounded-lg font-bold hover:bg-indigo-700 cursor-pointer shadow-sm">Save Teacher</button></div>
            </form>
          ) : (
            <form onSubmit={handleCreateEmployee} className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
              <div><label className="block text-slate-600 mb-1 font-medium">Full Name:</label><input type="text" value={empFullName} onChange={(e) => setEmpFullName(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5" required /></div>
              <div><label className="block text-slate-600 mb-1 font-medium">Phone:</label><input type="tel" value={empPhone} onChange={(e) => setEmpPhone(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 font-mono text-left" required /></div>
              <div><label className="block text-slate-600 mb-1 font-medium">Email:</label><input type="email" value={empEmail} onChange={(e) => setEmpEmail(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 font-mono text-left" /></div>
              <div><label className="block text-slate-600 mb-1 font-medium">Role:</label><input type="text" value={empRole} onChange={(e) => setEmpRole(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5" required /></div>
              <div><label className="block text-slate-600 mb-1 font-medium">Base Salary (AFN):</label><input type="number" value={empBaseSalary} onChange={(e) => setEmpBaseSalary(Number(e.target.value))} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 font-mono" required /></div>
              <div className="sm:col-span-2 flex justify-end gap-2 pt-2 border-t border-slate-100 mt-2"><button type="button" onClick={() => setShowAddForm(false)} className="px-4 py-2 bg-slate-100 text-slate-600 rounded-lg font-bold hover:bg-slate-200 cursor-pointer">Cancel</button><button type="submit" className="px-6 py-2 bg-teal-600 text-white rounded-lg font-bold hover:bg-teal-700 cursor-pointer shadow-sm">Save Employee</button></div>
            </form>
          )}
        </div>
      )}

      {/* Directory Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {activeCategory === 'teachers' ? (
          <TeacherDirectoryPanel
            teachers={teachers} filteredTeachers={filteredTeachers} classes={classes} classTeacherSkills={classTeacherSkills}
            isOwnerOrFinance={isOwnerOrFinance} isOwnerOrManager={isOwnerOrManager} getTeacherMonthlyTotal={getTeacherMonthlyTotal}
            onEdit={handleStartEditTeacher} onDelete={(id, name) => { if (confirm(`Delete ${name}?`)) { deleteTeacher(id).then(() => triggerToast('Teacher deactivated.', 'info')).catch((err: unknown) => triggerToast(err instanceof Error ? err.message : 'Deactivate failed.', 'error')); } }}
            onPay={(t) => { setSalaryTeacher(t); setPaymentType('full'); setAmountPaid(getTeacherMonthlyTotal(t) ?? 0); }}
            onEvaluate={(t) => setEvaluatingTeacher(t)} onManageSkills={setManagingSkillsFor}
            onTransfer={(t) => { setTransferringTeacher(t); setTransferTargetBranchId(''); }}
            onOpenProfile={(t) => setProfileTeacher(t)} // Added Profile Handler
          />
        ) : (
          <EmployeeDirectoryPanel
            employees={employees} filteredEmployees={filteredEmployees} isOwnerOrFinance={isOwnerOrFinance} isOwnerOrManager={isOwnerOrManager}
            onEdit={handleStartEditEmployee} onDelete={(id, name) => { if (confirm(`Delete ${name}?`)) { deleteEmployee(id).then(() => triggerToast('Employee deactivated.', 'info')).catch((err: unknown) => triggerToast(err instanceof Error ? err.message : 'Deactivate failed.', 'error')); } }}
            onPay={(e) => { setSalaryEmployee(e); setPaymentType('full'); setAmountPaid(e.baseSalary || 0); }}
            onTransfer={(e) => { setTransferringEmployee(e); setTransferTargetBranchId(''); }}
          />
        )}
      </div>

      {/* Transfer Modals */}
      {transferringTeacher && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xl max-w-md w-full p-5 space-y-4">
            <div className="flex items-start justify-between gap-2"><div><h3 className="text-sm font-extrabold text-slate-900">Transfer teacher</h3><p className="text-xs text-slate-500 mt-1">Move <strong>{transferringTeacher.fullName}</strong> to another branch.</p></div><button type="button" onClick={() => setTransferringTeacher(null)} className="text-slate-400 hover:text-slate-700"><X className="w-4 h-4" /></button></div>
            <select value={transferTargetBranchId} onChange={(e) => setTransferTargetBranchId(e.target.value)} className="w-full border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold bg-slate-50"><option value="">Select branch…</option>{branches.filter(b => b.isActive !== false && b.id !== transferringTeacher.branchId).map(b => { const campus = campuses.find(c => c.id === b.campusId); return <option key={b.id} value={b.id}>{campus ? `${campus.name} / ${b.name}` : b.name}</option>; })}</select>
            <div className="flex justify-end gap-2 pt-1"><button type="button" onClick={() => setTransferringTeacher(null)} className="px-3 py-2 text-xs font-bold rounded-xl border border-slate-200 text-slate-600">Cancel</button><button type="button" disabled={!transferTargetBranchId || transferBusy} onClick={async () => { if (!transferTargetBranchId || !transferringTeacher) return; setTransferBusy(true); try { await transferTeacher(transferringTeacher.id, transferTargetBranchId); triggerToast('Teacher transferred successfully.', 'success'); setTransferringTeacher(null); } catch (err) { triggerToast(err instanceof Error ? err.message : 'Transfer failed.', 'error'); } finally { setTransferBusy(false); } }} className="px-3 py-2 text-xs font-bold rounded-xl bg-emerald-600 text-white disabled:opacity-50">{transferBusy ? 'Transferring…' : 'Confirm transfer'}</button></div>
          </div>
        </div>
      )}

      {transferringEmployee && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xl max-w-md w-full p-5 space-y-4">
            <div className="flex items-start justify-between gap-2"><div><h3 className="text-sm font-extrabold text-slate-900">Transfer employee</h3><p className="text-xs text-slate-500 mt-1">Move <strong>{transferringEmployee.fullName}</strong> to another branch.</p></div><button type="button" onClick={() => setTransferringEmployee(null)} className="text-slate-400 hover:text-slate-700"><X className="w-4 h-4" /></button></div>
            <select value={transferTargetBranchId} onChange={(e) => setTransferTargetBranchId(e.target.value)} className="w-full border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold bg-slate-50"><option value="">Select branch…</option>{branches.filter(b => b.isActive !== false && b.id !== transferringEmployee.branchId).map(b => { const campus = campuses.find(c => c.id === b.campusId); return <option key={b.id} value={b.id}>{campus ? `${campus.name} / ${b.name}` : b.name}</option>; })}</select>
            <div className="flex justify-end gap-2 pt-1"><button type="button" onClick={() => setTransferringEmployee(null)} className="px-3 py-2 text-xs font-bold rounded-xl border border-slate-200 text-slate-600">Cancel</button><button type="button" disabled={!transferTargetBranchId || transferBusy} onClick={async () => { if (!transferTargetBranchId || !transferringEmployee) return; setTransferBusy(true); try { await transferEmployee(transferringEmployee.id, transferTargetBranchId); triggerToast('Employee transferred successfully.', 'success'); setTransferringEmployee(null); } catch (err) { triggerToast(err instanceof Error ? err.message : 'Transfer failed.', 'error'); } finally { setTransferBusy(false); } }} className="px-3 py-2 text-xs font-bold rounded-xl bg-emerald-600 text-white disabled:opacity-50">{transferBusy ? 'Transferring…' : 'Confirm transfer'}</button></div>
          </div>
        </div>
      )}

      <TeachersModals
        editingTeacher={editingTeacher} setEditingTeacher={setEditingTeacher} editTFullName={editTFullName} setEditTFullName={setEditTFullName} editTPhone={editTPhone} setEditTPhone={setEditTPhone} editTEmail={editTEmail} setEditTEmail={setEditTEmail} editTBaseSalary={editTBaseSalary} setEditTBaseSalary={setEditTBaseSalary} editTSalaryType={editTSalaryType} setEditTSalaryType={setEditTSalaryType} editTSpecialization={editTSpecialization} setEditTSpecialization={setEditTSpecialization} editTQualification={editTQualification} setEditTQualification={setEditTQualification} editTContractType={editTContractType} setEditTContractType={setEditTContractType} editTStatus={editTStatus} setEditTStatus={setEditTStatus} editTDefaultSkillRate={editTDefaultSkillRate} setEditTDefaultSkillRate={setEditTDefaultSkillRate} handleEditTeacherSubmit={handleEditTeacherSubmit}
        editingEmployee={editingEmployee} setEditingEmployee={setEditingEmployee} editEFullName={editEFullName} setEditEFullName={setEditEFullName} editEPhone={editEPhone} setEditEPhone={setEditEPhone} editEEmail={editEEmail} setEditEEmail={setEditEEmail} editERole={editERole} setEditERole={setEditERole} editEBaseSalary={editEBaseSalary} setEditEBaseSalary={setEditEBaseSalary} editEStatus={editEStatus} setEditEStatus={setEditEStatus} handleEditEmployeeSubmit={handleEditEmployeeSubmit}
        salaryTeacher={salaryTeacher} setSalaryTeacher={setSalaryTeacher} teacherSalaryStatus={teacherSalaryStatus} salaryStatusLoading={salaryStatusLoading} salaryEmployee={salaryEmployee} setSalaryEmployee={setSalaryEmployee} teacherBudget={teacherBudget} employeeBudget={employeeBudget} paymentType={paymentType} handleTeacherPaymentTypeChange={handleTeacherPaymentTypeChange} handleEmployeePaymentTypeChange={handleEmployeePaymentTypeChange} amountPaid={amountPaid} setAmountPaid={setAmountPaid} selectedMonth={selectedMonth} setSelectedMonth={setSelectedMonth} handlePayTeacherSalaryConfirm={handlePayTeacherSalaryConfirm} handlePayEmployeeSalaryConfirm={handlePayEmployeeSalaryConfirm}
        evaluatingTeacher={evaluatingTeacher} setEvaluatingTeacher={setEvaluatingTeacher} handleEvaluateSubmit={handleEvaluateSubmit}
        printedPayslip={printedPayslip} setPrintedPayslip={setPrintedPayslip} triggerToast={triggerToast}
      />

      {managingSkillsFor && (
        <TeacherSkillAssignmentModal teacher={managingSkillsFor} classes={classes} skills={skills} assignments={classTeacherSkills.filter(cts => cts.teacherId === managingSkillsFor.id)} onAssign={assignTeacherSkill} onEditRate={editTeacherSkillRate} onRemove={removeTeacherSkill} onClose={() => setManagingSkillsFor(null)} />
      )}

      {/* Teacher Profile Drawer */}
      {profileTeacher && (
        <TeacherProfileDrawer
          teacher={profileTeacher}
          classes={classes}
          skills={skills}
          assignments={classTeacherSkills}
          onClose={() => setProfileTeacher(null)}
          onEdit={() => { handleStartEditTeacher(profileTeacher); setProfileTeacher(null); }}
          onPay={() => { setSalaryTeacher(profileTeacher); setPaymentType('full'); setAmountPaid(getTeacherMonthlyTotal(profileTeacher) ?? 0); setProfileTeacher(null); }}
          onEvaluate={() => { setEvaluatingTeacher(profileTeacher); setProfileTeacher(null); }}
          onManageSkills={() => { setManagingSkillsFor(profileTeacher); setProfileTeacher(null); }}
        />
      )}
    </div>
  );
}