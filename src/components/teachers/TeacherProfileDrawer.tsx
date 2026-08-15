import React from 'react';
import { X, Award, Mail, Phone, Star, Wallet, ListPlus, ClipboardCheck, Edit, DollarSign } from 'lucide-react';
import { Teacher, Class, ClassTeacherSkill, Skill } from '../../types';
import { formatAFN } from '../../utils/format';

interface TeacherProfileDrawerProps {
  teacher: Teacher;
  classes: Class[];
  skills: Skill[];
  assignments: ClassTeacherSkill[];
  onClose: () => void;
  onEdit: () => void;
  onPay: () => void;
  onEvaluate: () => void;
  onManageSkills: () => void;
}

export default function TeacherProfileDrawer({
  teacher, classes, skills, assignments, onClose, onEdit, onPay, onEvaluate, onManageSkills
}: TeacherProfileDrawerProps) {
  const skillAssignments = assignments.filter(a => a.teacherId === teacher.id);
  const assignedClassIds = new Set([
    ...classes.filter(c => c.teacherId === teacher.id).map(c => c.id),
    ...skillAssignments.map(a => a.classId),
  ]);
  const assignedClasses = classes.filter(c => assignedClassIds.has(c.id));
  const perfScore = teacher.performanceScore || 0;

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-40 flex justify-center items-center p-4 animate-in fade-in duration-200">
      <div className="bg-white w-full max-w-2xl h-[90vh] rounded-3xl shadow-2xl flex flex-col overflow-hidden">
        
        {/* Header */}
        <div className="bg-gradient-to-r from-indigo-600 to-purple-600 p-6 text-white relative">
          <button onClick={onClose} className="absolute top-4 right-4 p-2 bg-white/20 hover:bg-white/30 rounded-full cursor-pointer">
            <X className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-4">
            <div className="w-16 h-16 rounded-full bg-white/20 border-2 border-white/40 flex items-center justify-center text-2xl font-black">
              {teacher.fullName.charAt(0)}
            </div>
            <div>
              <h2 className="text-xl font-black flex items-center gap-2">
                {teacher.fullName}
                {perfScore > 0 ? (
                  <span className="flex items-center gap-1 text-xs bg-white/20 px-2 py-0.5 rounded-full">
                    <Star className="w-3 h-3 fill-current" /> {perfScore}/100
                  </span>
                ) : (
                  <span className="text-[10px] font-bold text-slate-400">Not evaluated</span>
                )}
              </h2>
              <p className="text-indigo-100 text-sm">{teacher.specialization || 'TOEFL Instructor'}</p>
              <div className="flex gap-4 mt-1 text-xs text-indigo-50">
                <span className="flex items-center gap-1"><Phone className="w-3 h-3" /> {teacher.phone}</span>
                {teacher.email && <span className="flex items-center gap-1"><Mail className="w-3 h-3" /> {teacher.email}</span>}
              </div>
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="p-4 border-b border-slate-100 grid grid-cols-2 md:grid-cols-4 gap-2">
          <button onClick={onPay} className="flex flex-col items-center justify-center gap-1 p-3 bg-emerald-50 text-emerald-700 rounded-xl hover:bg-emerald-100 transition-colors cursor-pointer">
            <DollarSign className="w-5 h-5" /><span className="text-[10px] font-bold">Pay Salary</span>
          </button>
          <button onClick={onEvaluate} className="flex flex-col items-center justify-center gap-1 p-3 bg-amber-50 text-amber-700 rounded-xl hover:bg-amber-100 transition-colors cursor-pointer">
            <ClipboardCheck className="w-5 h-5" /><span className="text-[10px] font-bold">Evaluate</span>
          </button>
          <button onClick={onManageSkills} className="flex flex-col items-center justify-center gap-1 p-3 bg-violet-50 text-violet-700 rounded-xl hover:bg-violet-100 transition-colors cursor-pointer">
            <ListPlus className="w-5 h-5" /><span className="text-[10px] font-bold">Manage Skills</span>
          </button>
          <button onClick={onEdit} className="flex flex-col items-center justify-center gap-1 p-3 bg-slate-100 text-slate-700 rounded-xl hover:bg-slate-200 transition-colors cursor-pointer">
            <Edit className="w-5 h-5" /><span className="text-[10px] font-bold">Edit Profile</span>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 bg-slate-50">
          
          {/* Contract & Finance */}
          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
            <h3 className="text-xs font-extrabold text-slate-800 mb-3 flex items-center gap-1.5"><Wallet className="w-4 h-4 text-indigo-600" /> Contract & Finance</h3>
            <div className="grid grid-cols-2 gap-4 text-xs">
              <div>
                <p className="text-slate-400 font-semibold">Contract Type</p>
                <p className="font-bold text-slate-800 capitalize">{teacher.salaryType?.replace('_', ' ') || 'Fixed'}</p>
              </div>
              <div>
                <p className="text-slate-400 font-semibold">Base Salary</p>
                <p className="font-bold text-slate-800 font-mono">{formatAFN(teacher.baseSalary)}</p>
              </div>
              <div>
                <p className="text-slate-400 font-semibold">Default Skill Rate</p>
                <p className="font-bold text-slate-800 font-mono">{formatAFN(teacher.defaultSkillRate || 0)}</p>
              </div>
              <div>
                <p className="text-slate-400 font-semibold">Status</p>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${teacher.status === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>{teacher.status}</span>
              </div>
            </div>
          </div>

          {/* Assigned Classes */}
          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
            <h3 className="text-xs font-extrabold text-slate-800 mb-3 flex items-center gap-1.5"><Award className="w-4 h-4 text-indigo-600" /> Assigned Classes</h3>
            {assignedClasses.length === 0 ? <p className="text-slate-400 text-xs italic">No active classes assigned.</p> : (
              <div className="flex flex-wrap gap-2">
                {assignedClasses.map(c => (
                  <span key={c.id} className="px-3 py-1 bg-indigo-50 text-indigo-700 rounded-lg text-[11px] font-bold border border-indigo-100">
                    {c.name} <span className="text-indigo-400 font-normal">({c.level})</span>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Skills Breakdown */}
          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
            <h3 className="text-xs font-extrabold text-slate-800 mb-3 flex items-center gap-1.5"><ListPlus className="w-4 h-4 text-indigo-600" /> Skills & Rates</h3>
            {skillAssignments.length === 0 ? <p className="text-slate-400 text-xs italic">No specific skills assigned.</p> : (
              <div className="space-y-2">
                {skillAssignments.map(a => {
                  const cls = classes.find(c => c.id === a.classId);
                  const skill = skills.find(s => s.id === a.skillId);
                  return (
                    <div key={a.id} className="flex justify-between items-center text-xs bg-slate-50 p-2 rounded-lg border border-slate-100">
                      <span className="font-bold text-slate-700">{skill?.name || 'Unknown'} <span className="text-slate-400 font-normal">in {cls?.name || 'Unknown'}</span></span>
                      <span className="font-mono font-extrabold text-indigo-600">{formatAFN(a.monthlyRate)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}