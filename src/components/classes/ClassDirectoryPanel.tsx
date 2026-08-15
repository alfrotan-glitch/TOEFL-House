import React, { useMemo } from 'react';
import {
  School, Users, Clock, GraduationCap, UserCog, Gauge,
} from 'lucide-react';
import { Class, Teacher, Student, ClassTeacherSkill } from '../../types';
import { formatAFN } from '../../utils/format';

// Helper type to avoid using `any` and ensure type safety
type EnrichedStudent = Student & { classId?: string; currentClassId?: string | null };

export interface ClassDirectoryPanelProps {
  classes: Class[];
  teachers: Teacher[];
  students: Student[];
  classTeacherSkills: ClassTeacherSkill[];
  canManage: boolean;
  onEdit: (c: Class) => void;
  onDelete: (c: Class) => void | Promise<void>;
  onMerge: (c: Class) => void | Promise<void>;
  onManageSkillTeachers: (c: Class) => void;
  onOpenTimetable?: (c: Class) => void;
  onManageClass?: (c: Class) => void;
}

export function ClassDirectoryPanel({
  classes,
  teachers,
  students,
  classTeacherSkills,
  canManage,
  onEdit,
  onDelete,
  onMerge,
  onManageSkillTeachers,
  onOpenTimetable,
}: ClassDirectoryPanelProps) {
  const studentCountMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of students as EnrichedStudent[]) {
      const classIds = new Set<string>();
      if (s.currentClassId) classIds.add(s.currentClassId);
      if (s.classId) classIds.add(s.classId);
      
      s.semesters?.forEach((sem) => {
        if (sem.status === 'active' && sem.classId) classIds.add(sem.classId);
      });

      classIds.forEach((id) => {
        map.set(id, (map.get(id) || 0) + 1);
      });
    }
    return map;
  }, [students]);

  const skillCountMap = useMemo(() => {
    const map = new Map<string, Set<string>>(); // Use Set to count unique skills
    for (const cts of classTeacherSkills) {
      if (!map.has(cts.classId)) map.set(cts.classId, new Set());
      map.get(cts.classId)!.add(cts.skillId);
    }
    
    // Convert Sets to sizes
    const countMap = new Map<string, number>();
    map.forEach((skillSet, classId) => {
      countMap.set(classId, skillSet.size);
    });
    return countMap;
  }, [classTeacherSkills]);

  const teacherName = (id?: string) =>
    teachers.find((t) => t.id === id)?.fullName || 'Unassigned';

  if (classes.length === 0) {
    return (
      <div className="col-span-full text-center py-12 bg-slate-50 border border-dashed border-slate-200 rounded-2xl">
        <School className="w-8 h-8 text-slate-300 mx-auto mb-2" />
        <p className="text-sm font-bold text-slate-600">No classes yet</p>
        <p className="text-xs text-slate-400 mt-1 max-w-md mx-auto">
          Create a class after configuring levels, slots, and rooms in Academic Setup. Nothing is pre-loaded.
        </p>
      </div>
    );
  }

  return (
    <>
      {classes.map((c) => {
        const mapEnrolled = studentCountMap.get(c.id) || 0;
        const enrolled = typeof c.enrolled === 'number' ? c.enrolled : mapEnrolled;
        const skillCount = skillCountMap.get(c.id) || 0;

        return (
          <div
            key={c.id}
            className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm hover:shadow-md transition-shadow flex flex-col"
          >
            <div className="flex justify-between items-start gap-2 mb-2">
              <div>
                <h3 className="font-extrabold text-slate-900 text-sm">{c.name}</h3>
                <div className="flex flex-wrap items-center gap-1 mt-1">
                  <span className="text-[10px] font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full">
                    {c.level}
                  </span>
                  {c.genderPolicy && c.genderPolicy !== 'mixed' && (
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                        c.genderPolicy === 'female'
                          ? 'bg-pink-50 text-pink-700'
                          : 'bg-sky-50 text-sky-700'
                      }`}
                    >
                      {c.genderPolicy === 'female' ? '♀ Female' : '♂ Male'}
                    </span>
                  )}
                  {(!c.genderPolicy || c.genderPolicy === 'mixed') && (
                    <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-slate-50 text-slate-500">
                      Mixed
                    </span>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-1">
                <span
                  className={`text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap ${
                    c.status === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'
                  }`}
                >
                  {c.status}
                </span>
                {c.lifecycleStage && (
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap bg-sky-50 text-sky-700">
                    {c.lifecycleStage.replace(/_/g, ' ')}
                  </span>
                )}
              </div>
            </div>

            <div className="space-y-1 text-[11px] text-slate-600 flex-grow">
              <p className="flex items-center gap-1.5">
                <GraduationCap className="w-3.5 h-3.5 text-slate-400" />
                {teacherName(c.teacherId)}
              </p>
              <p className="flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-slate-400" />
                {c.scheduleTime || '—'}
              </p>
              <p className="flex items-center gap-1.5">
                <Users className="w-3.5 h-3.5 text-slate-400" />
                {enrolled} / {c.capacity || '—'} enrolled
              </p>
              {c.capacity > 0 && (
                <div className="pt-1">
                  <div className="flex items-center justify-between text-[10px] font-semibold text-slate-500 mb-1">
                    <span className="inline-flex items-center gap-1"><Gauge className="w-3 h-3" /> Utilization</span>
                    <span>{Math.min(100, Math.round((enrolled / c.capacity) * 100))}%</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${enrolled >= c.capacity ? 'bg-rose-500' : enrolled >= c.capacity * 0.85 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                      style={{ width: `${Math.min(100, Math.round((enrolled / c.capacity) * 100))}%` }}
                    />
                  </div>
                </div>
              )}
              <p className="font-mono text-indigo-700 font-bold pt-1">{formatAFN(c.fee || 0)}</p>
              <p className="flex items-center gap-1.5">
                <UserCog className="w-3.5 h-3.5 text-slate-400" />
                Skill teachers: {skillCount}/3
              </p>
            </div>

            <div className="flex flex-wrap gap-1.5 mt-3 pt-3 border-t border-slate-100">
              {canManage && (
                <>
                  <button
                    type="button"
                    onClick={() => onEdit(c)}
                    className="text-[10px] font-bold px-2.5 py-1.5 rounded-lg bg-indigo-50 text-indigo-700 hover:bg-indigo-100 transition-colors"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => onManageSkillTeachers(c)}
                    className="text-[10px] font-bold px-2.5 py-1.5 rounded-lg bg-violet-50 text-violet-700 hover:bg-violet-100 transition-colors flex items-center gap-1"
                  >
                    <UserCog className="w-3 h-3" />
                    Skill teachers
                  </button>
                  <button
                    type="button"
                    onClick={() => onMerge(c)}
                    className="text-[10px] font-bold px-2.5 py-1.5 rounded-lg bg-amber-50 text-amber-800 hover:bg-amber-100 transition-colors"
                  >
                    Merge
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(c)}
                    className="text-[10px] font-bold px-2.5 py-1.5 rounded-lg bg-rose-50 text-rose-700 hover:bg-rose-100 transition-colors"
                  >
                    Delete
                  </button>
                </>
              )}
              {onOpenTimetable && (
                <button
                  type="button"
                  onClick={() => onOpenTimetable(c)}
                  className="text-[10px] font-bold px-2.5 py-1.5 rounded-lg bg-sky-50 text-sky-800 hover:bg-sky-100 transition-colors flex items-center gap-1"
                >
                  <Clock className="w-3 h-3" />
                  Timetable
                </button>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}