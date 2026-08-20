import React from 'react';
import {Phone, Edit, Trash2, ArrowRightLeft, DollarSign, ListPlus, Star, ClipboardCheck} from 'lucide-react';
import {Teacher, Class, ClassTeacherSkill} from '../../types';
import {formatAFN} from '../../utils/format';

export interface TeacherDirectoryPanelProps {
  teachers: Teacher[];
  filteredTeachers: Teacher[];
  classes: Class[];
  classTeacherSkills: ClassTeacherSkill[];
  isOwnerOrFinance: boolean;
  isOwnerOrManager: boolean;
  getTeacherMonthlyTotal: (teacher: Teacher) => number | null;
  onEdit: (t: Teacher) => void;
  onDelete: (id: string, name: string) => void;
  onPay: (t: Teacher) => void;
  onEvaluate: (t: Teacher) => void;
  onManageSkills: (t: Teacher) => void;
  onTransfer: (t: Teacher) => void;
  onOpenProfile: (t: Teacher) => void; // Added to open profile
}

export function TeacherDirectoryPanel({
  filteredTeachers, isOwnerOrFinance, isOwnerOrManager,
  getTeacherMonthlyTotal, onEdit, onDelete, onPay, onEvaluate, onManageSkills, onTransfer, onOpenProfile
}: TeacherDirectoryPanelProps) {
  if (filteredTeachers.length === 0) {
    return <div className="col-span-full rounded-2xl border border-slate-200 bg-white p-8 text-center text-xs text-slate-400">No teachers match the current search or filter.</div>;
  }

  return (
    <>
      {filteredTeachers.map((teacher) => {
        const monthly = getTeacherMonthlyTotal(teacher);
        const perfScore = teacher.performanceScore || 0;

        return (
          <div key={teacher.id} className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm flex flex-col justify-between hover:border-indigo-300 hover:shadow-md transition-all cursor-pointer" onClick={() => onOpenProfile(teacher)}>
            <div className="space-y-3">
              <div className="flex justify-between items-start gap-2">
                <div>
                  <div className="flex items-center gap-1.5">
                    <div className="w-8 h-8 rounded-full bg-indigo-100 text-indigo-600 flex items-center justify-center font-black text-xs">
                      {teacher.fullName.charAt(0)}
                    </div>
                    <p className="font-extrabold text-slate-900 text-sm">{teacher.fullName}</p>
                    {perfScore > 0 ? (
                      <span className={`flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded-full ${perfScore >= 80 ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
                        <Star className="w-3 h-3 fill-current" /> {perfScore}/100
                      </span>
                    ) : (
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-400">Not evaluated</span>
                    )}
                  </div>
                  <p className="text-[10px] text-slate-400 mt-1 ms-9">
                    {(teacher.status || 'active').toUpperCase()}
                    {teacher.specialization ? ` · ${teacher.specialization}` : ''}
                  </p>
                </div>
                <span className="inline-flex items-center gap-1 bg-slate-100 text-slate-600 px-2 py-0.5 rounded text-[9px] font-bold">
                  {teacher.salaryType === 'per_skill' ? 'Per Skill'
                    : teacher.salaryType === 'hybrid' ? 'Hybrid'
                    : teacher.salaryType === 'per_level' ? 'Per Level'
                    : teacher.salaryType === 'per_session' ? 'Per Session'
                    : 'Fixed'}
                </span>
              </div>

              <div className="space-y-1 text-[11px] text-slate-600 ps-9">
                {teacher.phone && <p className="flex items-center gap-1.5"><Phone className="w-3 h-3 text-slate-400" />{teacher.phone}</p>}
              </div>

              <div className="flex items-center justify-between border-t border-slate-100 pt-3 ps-9" onClick={(e) => e.stopPropagation()}>
                <div>
                  <p className="text-[10px] text-slate-400 font-semibold">Monthly Total</p>
                  <p className="text-sm font-extrabold text-indigo-700 font-mono">
                    {monthly === null ? 'Calculated by Rule Engine' : formatAFN(monthly)}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5 justify-end">
                  {isOwnerOrFinance && <button onClick={() => onPay(teacher)} className="p-1.5 rounded-lg bg-emerald-50 text-emerald-700 hover:bg-emerald-100" title="Pay"><DollarSign className="w-3.5 h-3.5" /></button>}
                  {isOwnerOrManager && <button onClick={() => onEvaluate(teacher)} className="p-1.5 rounded-lg bg-amber-50 text-amber-700 hover:bg-amber-100" title="Evaluate"><ClipboardCheck className="w-3.5 h-3.5" /></button>}
                  <button onClick={() => onManageSkills(teacher)} className="p-1.5 rounded-lg bg-slate-50 text-slate-700 hover:bg-slate-100" title="Skills"><ListPlus className="w-3.5 h-3.5" /></button>
                  {isOwnerOrManager && <button onClick={() => onTransfer(teacher)} className="p-1.5 rounded-lg bg-sky-50 text-sky-700 hover:bg-sky-100" title="Transfer"><ArrowRightLeft className="w-3.5 h-3.5" /></button>}
                  <button onClick={() => onEdit(teacher)} className="p-1.5 rounded-lg bg-indigo-50 text-indigo-700 hover:bg-indigo-100" title="Edit"><Edit className="w-3.5 h-3.5" /></button>
                  {isOwnerOrManager && <button onClick={() => onDelete(teacher.id, teacher.fullName)} className="p-1.5 rounded-lg bg-rose-50 text-rose-700 hover:bg-rose-100" title="Delete"><Trash2 className="w-3.5 h-3.5" /></button>}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}