/**
 * @license SPDX-License-Identifier: Apache-2.0
 *
 * Classes module — operational classes driven by Academic Setup rules.
 * Fee / schedule / capacity from config are read-only rules, not free fields.
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Plus, X, Trash2, Save, UserCog,
} from 'lucide-react';
import { Class, Teacher, Student, UserRole, Skill, ClassTeacherSkill } from '../../types';
import { formatAFN } from '../../utils/format';
import { ClassDirectoryPanel } from './ClassDirectoryPanel';
import { ClassDetailDrawer } from './ClassDetailDrawer'; // NEW: LMS Drawer
import { api } from '../../api/client';
import { useDatasetVersion } from '../../state/serverStateFreshness';
import { ShamsiDateInput } from '../common/ShamsiDateInput';

interface ClassesViewProps {
  classes: Class[];
  teachers: Teacher[];
  students: Student[];
  activeRole: UserRole;
  branchId?: string;
  addClass: (
    name: string, teacherId: string, level: string, capacity: number,
    scheduleTime: string, startDate: string, endDate: string, fee: number,
    extras?: {
      programId?: string; levelId?: string; roomId?: string; timeSlotId?: string;
      academicTermId?: string; activationDate?: string;
      genderPolicy?: 'female' | 'male' | 'mixed'; minViableSize?: number; branchId?: string;
    }
  ) => Promise<void> | void;
  editClass: (
    id: string, name: string, teacherId: string, level: string, capacity: number,
    scheduleTime: string, startDate: string, endDate: string, fee: number,
    status?: 'active' | 'completed', genderPolicy?: 'female' | 'male' | 'mixed'
  ) => Promise<void> | void;
  deleteClass?: (id: string) => Promise<void> | void;
  mergeClass?: (sourceId: string, targetClassId: string) => Promise<{ movedStudents?: number } | void> | void;
  getClassMergeCandidates?: (classId: string) => Promise<{
    source: { id: string; name: string; enrolled: number; capacity: number; minViableSize: number; underMin: boolean };
    candidates: Array<{ id: string; name: string; level: string; scheduleTime: string; capacity: number; enrolled: number; freeSeats: number }>;
  }>;
  onOpenTimetable?: (classId: string) => void;
  skills: Skill[];
  classTeacherSkills: ClassTeacherSkill[];
  addSkill?: (name: string) => Promise<void> | void;
  assignTeacherSkill?: (classId: string, teacherId: string, skillId: string, monthlyRate: number) => Promise<void> | void;
  editTeacherSkillRate?: (assignmentId: string, monthlyRate: number) => Promise<void> | void;
  removeTeacherSkill?: (assignmentId: string) => Promise<void> | void;
  // NEW: LMS & Gradebook Props
  activateClass?: (classId: string) => Promise<void>;
  getClassGradebook?: (classId: string) => Promise<any>;
  createClassAssessment?: (classId: string, payload: { title: string; type: string; weight: number; maxScore: number; date?: string }) => Promise<void>;
  saveClassGrades?: (classId: string, grades: Array<{ assessmentId: string; studentId: string; score: number; status: string }>) => Promise<void>;
  completeClassSemester?: (classId: string) => Promise<void>;
  triggerToast?: (message: string, type: 'success' | 'error' | 'info') => void;
}

export default function ClassesView({
  classes, teachers, students, activeRole, branchId,
  addClass, editClass, deleteClass, mergeClass, getClassMergeCandidates,
  onOpenTimetable, skills, classTeacherSkills, addSkill,
  assignTeacherSkill, editTeacherSkillRate, removeTeacherSkill,
  // LMS Props
  activateClass, getClassGradebook, createClassAssessment, saveClassGrades, completeClassSemester, triggerToast,
}: ClassesViewProps) {
  
  // UI States
  const [showAddForm, setShowAddForm] = useState(false);
  const [genderFilter, setGenderFilter] = useState<'all' | 'female' | 'male' | 'mixed'>('all');
  const [editingClass, setEditingClass] = useState<Class | null>(null);
  const [mergeSource, setMergeSource] = useState<Class | null>(null);
  const [skillTeacherClass, setSkillTeacherClass] = useState<Class | null>(null);
  
  // NEW: LMS Drawer State
  const [detailClass, setDetailClass] = useState<Class | null>(null);

  // Form States
  const [className, setClassName] = useState('');
  const [teacherId, setTeacherId] = useState('');
  const [level, setLevel] = useState('');
  const [capacity, setCapacity] = useState(20);
  const [scheduleTime, setScheduleTime] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [activationDate, setActivationDate] = useState('');
  const [fee, setFee] = useState(0);
  const [genderPolicy, setGenderPolicy] = useState<'female' | 'male' | 'mixed'>('mixed');

  const [acadLevels, setAcadLevels] = useState<Array<{ id: string; programId: string; name: string; effectiveFee?: number; isActive?: boolean }>>([]);
  const [acadPrograms, setAcadPrograms] = useState<Array<{ id: string; name: string }>>([]);
  const [acadSlots, setAcadSlots] = useState<Array<{ id: string; label: string; startTime: string; endTime: string }>>([]);
  const [acadRooms, setAcadRooms] = useState<Array<{ id: string; name: string; capacity: number }>>([]);
  const [selectedLevelId, setSelectedLevelId] = useState('');
  const [selectedSlotId, setSelectedSlotId] = useState('');
  const [selectedRoomId, setSelectedRoomId] = useState('');
  const [selectedProgramId, setSelectedProgramId] = useState('');

  const [editName, setEditName] = useState('');
  const [editTeacherId, setEditTeacherId] = useState('');
  const [editLevel, setEditLevel] = useState('');
  const [editCapacity, setEditCapacity] = useState(20);
  const [editScheduleTime, setEditScheduleTime] = useState('');
  const [editStartDate, setEditStartDate] = useState('');
  const [editEndDate, setEditEndDate] = useState('');
  const [editFee, setEditFee] = useState(0);
  const [editStatus, setEditStatus] = useState<'active' | 'completed'>('active');
  const [editGenderPolicy, setEditGenderPolicy] = useState<'female' | 'male' | 'mixed'>('mixed');

  const [mergeCandidates, setMergeCandidates] = useState<Array<{ id: string; name: string; level: string; scheduleTime: string; capacity: number; enrolled: number; freeSeats: number }>>([]);
  const [mergeSourceMeta, setMergeSourceMeta] = useState<{ enrolled: number; minViableSize: number; underMin: boolean } | null>(null);
  
  // Async & Error States
  const [mergeBusy, setMergeBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [skillTeacherBusy, setSkillTeacherBusy] = useState(false);
  const [skillTeacherError, setSkillTeacherError] = useState<string | null>(null);

  // Skill Teacher Form States
  const [newAssignSkillId, setNewAssignSkillId] = useState('');
  const [newAssignTeacherId, setNewAssignTeacherId] = useState('');
  const [newAssignRate, setNewAssignRate] = useState<number | ''>('');
  const [newSkillName, setNewSkillName] = useState('');
  const [editingRateFor, setEditingRateFor] = useState<string | null>(null);
  const [editingRateValue, setEditingRateValue] = useState<number | ''>('');

  const isOwnerOrManager = activeRole === 'owner' || activeRole === 'manager';
  const canManageSkillTeachers = ['owner', 'manager', 'head_of_department'].includes(activeRole);
  const isTeacherOrAdmin = ['owner', 'manager', 'registrar', 'head_of_department', 'teacher'].includes(activeRole);

  /** PERFORMANCE FIX: O(1) lookup for student counts per class */

  const loadAcademicConfig = useCallback(() => {
    api
      .get<{
        programs: Array<{ id: string; name: string; isActive?: boolean }>;
        levels: Array<{ id: string; programId: string; name: string; effectiveFee?: number; isActive?: boolean }>;
        timeSlots: Array<{ id: string; label: string; startTime: string; endTime: string }>;
        rooms: Array<{ id: string; name: string; capacity: number }>;
      }>('/academic/branch-config', branchId ? { branchId } : undefined)
      .then((cfg) => {
        setAcadPrograms((cfg.programs || []).filter((p) => p.isActive !== false));
        setAcadLevels((cfg.levels || []).filter((l) => l.isActive !== false));
        setAcadSlots(cfg.timeSlots || []);
        setAcadRooms(cfg.rooms || []);
      })
      .catch(() => {
        setAcadPrograms([]);
        setAcadLevels([]);
        setAcadSlots([]);
        setAcadRooms([]);
      });
  }, [branchId]);

  // Subscribes to the `academic` dataset: adding a room, term, slot, level or
  // program in Academic Setup bumps that version and this picker data refetches
  // from the server. Previously this effect only depended on `loadAcademicConfig`
  // (i.e. `branchId`), so an academic change made elsewhere stayed invisible
  // here until a full page reload.
  const academicVersion = useDatasetVersion('academic');
  useEffect(() => {
    void (async () => { await loadAcademicConfig(); })();
  }, [loadAcademicConfig, academicVersion]);

  // Reset the skill-assignment form whenever a different class is selected,
  // by adjusting state during render (no setState-in-effect).
  const [prevSkillTeacherClassId, setPrevSkillTeacherClassId] = useState<string | undefined>(skillTeacherClass?.id);
  if (prevSkillTeacherClassId !== skillTeacherClass?.id) {
    setPrevSkillTeacherClassId(skillTeacherClass?.id);
    setNewAssignSkillId('');
    setNewAssignTeacherId('');
    setNewAssignRate('');
    setNewSkillName('');
    setSkillTeacherError(null);
    setEditingRateFor(null);
    setEditingRateValue('');
  }

  const visibleClasses = useMemo(() => {
    return classes.filter((c) => {
      if (genderFilter === 'all') return true;
      const pol = c.genderPolicy || 'mixed';
      return pol === genderFilter;
    });
  }, [classes, genderFilter]);

  const resetAddForm = () => {
    setClassName(''); setTeacherId(''); setFee(0); setSelectedLevelId('');
    setSelectedSlotId(''); setSelectedRoomId(''); setSelectedProgramId('');
    setLevel(''); setScheduleTime(''); setCapacity(20); setGenderPolicy('mixed');
    setStartDate(''); setEndDate(''); setActivationDate('');
  };

  const handleCreateClass = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!className || !teacherId) {
      setActionError('Class title and teacher are required.');
      return;
    }
    if (acadLevels.length > 0 && !selectedLevelId) {
      setActionError('Select a level from Academic Setup.');
      return;
    }
    if (!level) {
      setActionError('Level is required.');
      return;
    }

    setFormBusy(true);
    setActionError(null);
    try {
      await addClass(className, teacherId, level, capacity, scheduleTime, startDate, endDate, fee, {
        programId: selectedProgramId || undefined,
        levelId: selectedLevelId || undefined,
        roomId: selectedRoomId || undefined,
        timeSlotId: selectedSlotId || undefined,
        activationDate: activationDate || startDate || undefined,
        genderPolicy,
      });
      resetAddForm();
      setShowAddForm(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to create class.');
    } finally {
      setFormBusy(false);
    }
  };

  const openEdit = (c: Class) => {
    setEditingClass(c);
    setEditName(c.name);
    setEditTeacherId(c.teacherId || '');
    setEditLevel(c.level);
    setEditCapacity(c.capacity);
    setEditScheduleTime(c.scheduleTime || '');
    setEditStartDate(c.startDate || '');
    setEditEndDate(c.endDate || '');
    setEditFee(c.fee || 0);
    setEditStatus((c.status as 'active' | 'completed') || 'active');
    setEditGenderPolicy((c.genderPolicy as 'female' | 'male' | 'mixed') || 'mixed');
  };

  const handleEditClassSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingClass) return;
    
    setFormBusy(true);
    setActionError(null);
    try {
      await editClass(
        editingClass.id, editName, editTeacherId, editLevel, editCapacity,
        editScheduleTime, editStartDate, editEndDate, editFee, editStatus, editGenderPolicy
      );
      setEditingClass(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update class.');
    } finally {
      setFormBusy(false);
    }
  };

  const teacherName = (id?: string) => teachers.find((t) => t.id === id)?.fullName || '—';
  const skillName = (id?: string) => skills.find((s) => s.id === id)?.name || '—';

  const classSkillTeachers = useMemo(() => 
    skillTeacherClass ? classTeacherSkills.filter((cts) => cts.classId === skillTeacherClass.id) : [],
    [skillTeacherClass, classTeacherSkills]
  );

  const assignedSkillIds = useMemo(() => 
    new Set(classSkillTeachers.map((cts) => cts.skillId)),
    [classSkillTeachers]
  );

  const skillCapReached = assignedSkillIds.size >= 3 && !assignedSkillIds.has(newAssignSkillId);

  // SKILL != CONTRACT TYPE. A Skill records real teaching workload, so every
  // contract type — fixed included — is eligible. Only employment status and
  // an existing identical assignment can exclude a teacher. (The backend
  // enforces the same rule; this list must not disagree with it.)
  const eligibleTeachers = useMemo(() => 
    teachers.filter(
      (t) => t.status === 'active' &&
      !classSkillTeachers.some((cts) => cts.teacherId === t.id && cts.skillId === newAssignSkillId)
    ),
    [teachers, classSkillTeachers, newAssignSkillId]
  );

  const handleAssignSkillTeacher = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!skillTeacherClass || !assignTeacherSkill) return;
    if (!newAssignSkillId || !newAssignTeacherId) {
      setSkillTeacherError('Select a skill and a teacher.');
      return;
    }
    setSkillTeacherBusy(true);
    setSkillTeacherError(null);
    try {
      await assignTeacherSkill(
        skillTeacherClass.id, newAssignTeacherId, newAssignSkillId,
        newAssignRate === '' ? 0 : Number(newAssignRate)
      );
      setNewAssignSkillId('');
      setNewAssignTeacherId('');
      setNewAssignRate('');
    } catch (err) {
      setSkillTeacherError(err instanceof Error ? err.message : 'Failed to assign teacher.');
    } finally {
      setSkillTeacherBusy(false);
    }
  };

  const handleRemoveSkillTeacher = async (assignmentId: string) => {
    if (!removeTeacherSkill) return;
    if (!window.confirm('Remove this skill-teacher assignment?')) return;
    setSkillTeacherBusy(true);
    setSkillTeacherError(null);
    try {
      await removeTeacherSkill(assignmentId);
    } catch (err) {
      setSkillTeacherError(err instanceof Error ? err.message : 'Failed to remove assignment.');
    } finally {
      setSkillTeacherBusy(false);
    }
  };

  const handleSaveRate = async (assignmentId: string) => {
    if (!editTeacherSkillRate) return;
    setSkillTeacherBusy(true);
    setSkillTeacherError(null);
    try {
      await editTeacherSkillRate(assignmentId, editingRateValue === '' ? 0 : Number(editingRateValue));
      setEditingRateFor(null);
    } catch (err) {
      setSkillTeacherError(err instanceof Error ? err.message : 'Failed to update rate.');
    } finally {
      setSkillTeacherBusy(false);
    }
  };

  const handleQuickAddSkill = async () => {
    if (!addSkill || !newSkillName.trim()) return;
    setSkillTeacherBusy(true);
    setSkillTeacherError(null);
    try {
      await addSkill(newSkillName.trim());
      setNewSkillName('');
    } catch (err) {
      setSkillTeacherError(err instanceof Error ? err.message : 'Failed to add skill.');
    } finally {
      setSkillTeacherBusy(false);
    }
  };

  return (
    <div className="space-y-5 font-sans text-left" dir="ltr">
      <div className="flex flex-col sm:flex-row items-center justify-between border-b border-slate-200 pb-4 gap-4">
        <div>
          <h2 className="text-xl font-extrabold text-slate-900">Class schedule management</h2>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-bold text-slate-500 uppercase">Gender</span>
            {(['all', 'mixed', 'female', 'male'] as const).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setGenderFilter(g)}
                className={`text-[10px] font-bold px-2.5 py-1 rounded-full border ${
                  genderFilter === g
                    ? 'bg-slate-900 text-white border-slate-900'
                    : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                }`}
              >
                {g === 'all' ? 'All' : g === 'female' ? '♀ Female' : g === 'male' ? '♂ Male' : 'Mixed'}
              </button>
            ))}
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Classes use Academic Setup rules (level, fee, time slot, room). Those fields are not editable here.
          </p>
        </div>
        {isTeacherOrAdmin && activeRole !== 'teacher' && (
          <button
            type="button"
            onClick={() => {
              setShowAddForm(!showAddForm);
              loadAcademicConfig();
            }}
            className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-xs px-4 py-2.5 rounded-xl cursor-pointer shadow-sm"
          >
            <Plus className="w-4 h-4" />
            Create new class
          </button>
        )}
      </div>

      {actionError && (
        <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2 flex justify-between gap-2">
          <span>{actionError}</span>
          <button type="button" className="font-bold underline" onClick={() => setActionError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {showAddForm && (
        <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm max-w-xl mx-auto">
          <h3 className="text-sm font-bold text-slate-900 border-b border-slate-100 pb-2 mb-4">
            Create new class
          </h3>
          <form onSubmit={handleCreateClass} className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
            <div className="sm:col-span-2 text-[11px] text-amber-800 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2">
              Configure programs, levels, time slots, and rooms in{' '}
              <strong>Administration → Academic Setup</strong> first. Fee, hours, and capacity are applied as
              rules and cannot be changed on the class.
            </div>

            <div>
              <label className="block text-slate-600 mb-1 font-medium">Class title:</label>
              <input
                type="text"
                placeholder="e.g. GE-Starter-Morning"
                value={className}
                onChange={(e) => setClassName(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2"
                required
              />
            </div>

            <div>
              <label className="block text-slate-600 mb-1 font-medium">Class teacher:</label>
              <select
                value={teacherId}
                onChange={(e) => setTeacherId(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2"
                required
              >
                <option value="">Select…</option>
                {teachers
                  .filter((t) => t.status === 'active')
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.fullName}
                    </option>
                  ))}
              </select>
            </div>

            {acadPrograms.length > 0 && (
              <div>
                <label className="block text-slate-600 mb-1 font-medium">Program:</label>
                <select
                  value={selectedProgramId}
                  onChange={(e) => {
                    setSelectedProgramId(e.target.value);
                    setSelectedLevelId('');
                    setLevel('');
                    setFee(0);
                  }}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2"
                >
                  <option value="">All programs</option>
                  {acadPrograms.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label className="block text-slate-600 mb-1 font-medium">Level *:</label>
              {acadLevels.length === 0 ? (
                <p className="text-[11px] text-rose-600 bg-rose-50 border border-rose-100 rounded-lg px-2 py-2">
                  No levels configured. Open Academic Setup and add a program with levels.
                </p>
              ) : (
                <select
                  value={selectedLevelId}
                  onChange={(e) => {
                    const id = e.target.value;
                    setSelectedLevelId(id);
                    const lvl = acadLevels.find((x) => x.id === id);
                    if (lvl) {
                      setLevel(lvl.name);
                      setFee(Number(lvl.effectiveFee ?? 0));
                      if (!selectedProgramId) setSelectedProgramId(lvl.programId);
                    } else {
                      setLevel('');
                      setFee(0);
                    }
                  }}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2"
                  required
                >
                  <option value="">Select level…</option>
                  {acadLevels
                    .filter((l) => !selectedProgramId || l.programId === selectedProgramId)
                    .map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                </select>
              )}
            </div>

            <div>
              <label className="block text-slate-600 mb-1 font-medium">Time slot:</label>
              {acadSlots.length === 0 ? (
                <p className="text-[11px] text-slate-500">No time slots in Academic Setup for this branch.</p>
              ) : (
                <select
                  value={selectedSlotId}
                  onChange={(e) => {
                    const id = e.target.value;
                    setSelectedSlotId(id);
                    const s = acadSlots.find((x) => x.id === id);
                    if (s) setScheduleTime(`${s.startTime}-${s.endTime}`);
                    else setScheduleTime('');
                  }}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2"
                >
                  <option value="">Select time slot…</option>
                  {acadSlots.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label} ({s.startTime}–{s.endTime})
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div>
              <label className="block text-slate-600 mb-1 font-medium">Room:</label>
              {acadRooms.length === 0 ? (
                <p className="text-[11px] text-slate-500">No rooms in Academic Setup for this branch.</p>
              ) : (
                <select
                  value={selectedRoomId}
                  onChange={(e) => {
                    const id = e.target.value;
                    setSelectedRoomId(id);
                    const r = acadRooms.find((x) => x.id === id);
                    if (r?.capacity) setCapacity(r.capacity);
                  }}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2"
                >
                  <option value="">Select room…</option>
                  {acadRooms.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} (cap {r.capacity})
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div>
              <label className="block text-slate-600 mb-1 font-medium">
                Capacity — from room (read-only):
              </label>
              <input
                type="number"
                value={capacity}
                readOnly
                className="w-full bg-slate-100 border border-slate-200 rounded-lg px-3 py-2 font-mono text-slate-600 cursor-not-allowed"
              />
            </div>

            <div>
              <label className="block text-slate-600 mb-1 font-medium">Class type (gender policy):</label>
              <select
                value={genderPolicy}
                onChange={(e) => setGenderPolicy(e.target.value as 'female' | 'male' | 'mixed')}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 font-semibold"
              >
                <option value="mixed">Mixed</option>
                <option value="female">Female only</option>
                <option value="male">Male only</option>
              </select>
              <p className="text-[10px] text-slate-400 mt-0.5">Enrollment is blocked if student gender does not match.</p>
            </div>

            <div>
              <label className="block text-slate-600 mb-1 font-medium">
                Class hours — from time slot (read-only):
              </label>
              <input
                type="text"
                value={scheduleTime}
                readOnly
                className="w-full bg-slate-100 border border-slate-200 rounded-lg px-3 py-2 font-mono text-slate-600 cursor-not-allowed"
              />
            </div>

            <div>
              <label className="block text-slate-600 mb-1 font-medium">Start date:</label>
              <ShamsiDateInput value={startDate} onChange={(v) => setStartDate(v)} />
            </div>

            <div>
              <label className="block text-slate-600 mb-1 font-medium">Activation date:</label>
              <ShamsiDateInput value={activationDate} onChange={(v) => setActivationDate(v)} />
              <p className="text-[10px] text-slate-400 mt-0.5">Class becomes operational on this date. Payroll only counts after activation.</p>
            </div>

            <div>
              <label className="block text-slate-600 mb-1 font-medium">End date:</label>
              <ShamsiDateInput value={endDate} onChange={(v) => setEndDate(v)} />
            </div>

            <div className="sm:col-span-2">
              <label className="block text-slate-600 mb-1 font-medium">
                Official fee (AFN) — Academic rule (not editable):
              </label>
              <input
                type="number"
                value={fee}
                readOnly
                tabIndex={-1}
                className="w-full bg-slate-100 border border-slate-200 rounded-lg px-3 py-2 font-mono text-slate-600 cursor-not-allowed"
              />
              <p className="text-[10px] text-slate-400 mt-1">
                Tuition comes from the level / branch fee in Academic Setup. Edit it there, not on the class.
              </p>
            </div>

            <div className="sm:col-span-2 flex justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setShowAddForm(false)}
                className="px-4 py-2 bg-slate-100 text-slate-600 rounded-lg font-semibold"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={formBusy}
                className="px-4 py-2 bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {formBusy ? 'Creating...' : 'Create class'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Class cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        <ClassDirectoryPanel
          classes={visibleClasses}
          teachers={teachers}
          students={students}
          classTeacherSkills={classTeacherSkills}
          canManage={isOwnerOrManager}
          onManageSkillTeachers={(c) => setSkillTeacherClass(c)}
          onEdit={openEdit}
          onDelete={async (c) => {
            if (!deleteClass) return;
            if (!window.confirm(`Delete class "${c.name}"? Only allowed if no active enrollments.`)) return;
            setActionError(null);
            try {
              await deleteClass(c.id);
            } catch (err) {
              setActionError(err instanceof Error ? err.message : 'Delete failed');
            }
          }}
          onMerge={async (c) => {
            if (!getClassMergeCandidates) return;
            setMergeSource(c);
            setActionError(null);
            try {
              const data = await getClassMergeCandidates(c.id);
              setMergeCandidates(data.candidates || []);
              setMergeSourceMeta({
                enrolled: data.source.enrolled,
                minViableSize: data.source.minViableSize,
                underMin: data.source.underMin,
              });
            } catch (err) {
              setActionError(err instanceof Error ? err.message : 'Failed to load merge candidates');
              setMergeCandidates([]);
            }
          }}
          onOpenTimetable={onOpenTimetable ? (c) => onOpenTimetable(c.id) : undefined}
          onManageClass={(c: Class) => setDetailClass(c)} // NEW: Open LMS Drawer
        />
      </div>

      {/* NEW: Class Detail Drawer (LMS & Gradebook) */}
      {detailClass && (
        <ClassDetailDrawer
          classData={detailClass}
          onClose={() => setDetailClass(null)}
          activateClass={activateClass}
          getClassGradebook={getClassGradebook || (async () => ({ students: [], assessments: [], grades: [] }))}
          createClassAssessment={createClassAssessment}
          saveClassGrades={saveClassGrades}
          completeClassSemester={completeClassSemester}
          triggerToast={triggerToast || (() => {})}
        />
      )}

      {mergeSource && (
        <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center p-4 z-50 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg my-8 text-xs p-5 space-y-3">
            <div className="flex justify-between items-start">
              <div>
                <h3 className="font-extrabold text-slate-900 text-sm">Merge class</h3>
                <p className="text-[11px] text-slate-500 mt-1">
                  Move students from <strong>{mergeSource.name}</strong> into another class of the same level
                  (different time). Use when enrollment is below the minimum viable size.
                </p>
              </div>
              <button type="button" onClick={() => setMergeSource(null)} className="text-slate-400">
                <X className="w-4 h-4" />
              </button>
            </div>
            {mergeSourceMeta && (
              <div className="bg-slate-50 border border-slate-100 rounded-xl px-3 py-2 text-[11px]">
                <p>
                  Enrolled: <strong>{mergeSourceMeta.enrolled}</strong> · Min viable:{' '}
                  <strong>{mergeSourceMeta.minViableSize}</strong>
                  {mergeSourceMeta.underMin && (
                    <span className="ml-2 text-amber-700 font-bold">Below minimum — merge recommended</span>
                  )}
                </p>
              </div>
            )}
            {mergeCandidates.length === 0 ? (
              <p className="text-slate-500 italic py-4 text-center">
                No suitable target class found (same level, active, enough free seats).
              </p>
            ) : (
              <div className="space-y-2 max-h-72 overflow-y-auto">
                {mergeCandidates.map((cand) => (
                  <div
                    key={cand.id}
                    className="flex justify-between items-center border border-slate-150 rounded-xl px-3 py-2 gap-2"
                  >
                    <div>
                      <p className="font-bold text-slate-900">{cand.name}</p>
                      <p className="text-[10px] text-slate-500">
                        {cand.scheduleTime || '—'} · {cand.enrolled}/{cand.capacity} · free {cand.freeSeats}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={mergeBusy || !mergeClass}
                      className="text-[10px] font-bold px-3 py-1.5 rounded-lg bg-amber-600 text-white disabled:opacity-50"
                      onClick={async () => {
                        if (!mergeClass) return;
                        if (
                          !window.confirm(
                            `Merge "${mergeSource.name}" into "${cand.name}"? Students move; source class is cancelled.`
                          )
                        )
                          return;
                        setMergeBusy(true);
                        setActionError(null);
                        try {
                          await mergeClass(mergeSource.id, cand.id);
                          setMergeSource(null);
                        } catch (err) {
                          setActionError(err instanceof Error ? err.message : 'Merge failed');
                        } finally {
                          setMergeBusy(false);
                        }
                      }}
                    >
                      Merge here
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Edit modal */}
      {editingClass && (
        <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center p-4 z-50 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg my-8 text-xs">
            <div className="flex justify-between items-center p-5 border-b border-slate-100">
              <h3 className="font-extrabold text-slate-900 text-sm">Edit class: {editingClass.name}</h3>
              <button type="button" onClick={() => setEditingClass(null)} className="text-slate-400">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleEditClassSubmit} className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2">
                <label className="block text-slate-600 mb-1 font-medium">Class title:</label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2"
                  required
                />
              </div>
              <div>
                <label className="block text-slate-600 mb-1 font-medium">Teacher:</label>
                <select
                  value={editTeacherId}
                  onChange={(e) => setEditTeacherId(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2"
                >
                  <option value="">Select…</option>
                  {teachers.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.fullName}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-slate-600 mb-1 font-medium">Status:</label>
                <select
                  value={editStatus}
                  onChange={(e) => setEditStatus(e.target.value as 'active' | 'completed')}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2"
                >
                  <option value="active">Active</option>
                  <option value="completed">Completed</option>
                </select>
              </div>
              <div>
                <label className="block text-slate-600 mb-1 font-medium">Level — rule (read-only):</label>
                <input
                  type="text"
                  value={editLevel}
                  readOnly
                  className="w-full bg-slate-100 border border-slate-200 rounded-lg px-3 py-2 text-slate-600 cursor-not-allowed"
                />
              </div>
              <div>
                <label className="block text-slate-600 mb-1 font-medium">Fee — rule (read-only):</label>
                <input
                  type="number"
                  value={editFee}
                  readOnly
                  className="w-full bg-slate-100 border border-slate-200 rounded-lg px-3 py-2 font-mono text-slate-600 cursor-not-allowed"
                />
              </div>
              <div>
                <label className="block text-slate-600 mb-1 font-medium">Hours — rule (read-only):</label>
                <input
                  type="text"
                  value={editScheduleTime}
                  readOnly
                  className="w-full bg-slate-100 border border-slate-200 rounded-lg px-3 py-2 font-mono text-slate-600 cursor-not-allowed"
                />
              </div>
              <div>
                <label className="block text-slate-600 mb-1 font-medium">Capacity — rule (read-only):</label>
                <input
                  type="number"
                  value={editCapacity}
                  readOnly
                  className="w-full bg-slate-100 border border-slate-200 rounded-lg px-3 py-2 font-mono text-slate-600 cursor-not-allowed"
                />
              </div>
              <div>
                <label className="block text-[10px] font-bold text-slate-500 mb-1">Class type (gender)</label>
                <select
                  value={editGenderPolicy}
                  onChange={(e) => setEditGenderPolicy(e.target.value as 'female' | 'male' | 'mixed')}
                  className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm font-semibold"
                >
                  <option value="mixed">Mixed</option>
                  <option value="female">Female only</option>
                  <option value="male">Male only</option>
                </select>
              </div>

              <div>
                <label className="block text-slate-600 mb-1 font-medium">Start date:</label>
                <ShamsiDateInput value={editStartDate} onChange={(v) => setEditStartDate(v)} />
              </div>
              <div>
                <label className="block text-slate-600 mb-1 font-medium">End date:</label>
                <ShamsiDateInput value={editEndDate} onChange={(v) => setEditEndDate(v)} />
              </div>
              <p className="sm:col-span-2 text-[10px] text-slate-400">
                Level, fee, hours, and capacity are Academic Setup rules. Change them in Academic Setup, not here.
              </p>
              <div className="sm:col-span-2 flex justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setEditingClass(null)}
                  className="px-4 py-2 bg-slate-100 text-slate-600 rounded-lg font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={formBusy}
                  className="px-4 py-2 bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700 disabled:opacity-50"
                >
                  {formBusy ? 'Saving...' : 'Save changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Skill teachers modal */}
      {skillTeacherClass && (
        <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center p-4 z-50 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg my-8 text-xs p-5 space-y-3">
            <div className="flex justify-between items-start">
              <div>
                <h3 className="font-extrabold text-slate-900 text-sm">
                  Skill teachers — {skillTeacherClass.name}
                </h3>
                <p className="text-[11px] text-slate-500 mt-1">
                  Up to 3 skills per class (e.g. Reading, Writing, Speaking), each with its own teacher and
                  monthly rate.
                </p>
              </div>
              <button type="button" onClick={() => setSkillTeacherClass(null)} className="text-slate-400">
                <X className="w-4 h-4" />
              </button>
            </div>

            {skillTeacherError && (
              <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-lg px-3 py-2 text-[11px] font-medium">
                {skillTeacherError}
              </div>
            )}

            <div className="space-y-2">
              {classSkillTeachers.length === 0 ? (
                <p className="text-slate-400 italic text-center py-4">
                  No skill teachers assigned to this class yet.
                </p>
              ) : (
                classSkillTeachers.map((cts) => (
                  <div
                    key={cts.id}
                    className="flex justify-between items-center border border-slate-150 rounded-xl px-3 py-2 gap-2"
                  >
                    <div>
                      <p className="font-bold text-slate-900">{skillName(cts.skillId)}</p>
                      <p className="text-[10px] text-slate-500">{teacherName(cts.teacherId)}</p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {editingRateFor === cts.id ? (
                        <>
                          <input
                            type="number"
                            autoFocus
                            value={editingRateValue}
                            onChange={(e) =>
                              setEditingRateValue(e.target.value === '' ? '' : Number(e.target.value))
                            }
                            className="w-20 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 font-mono text-[11px]"
                          />
                          <button
                            type="button"
                            disabled={skillTeacherBusy}
                            onClick={() => handleSaveRate(cts.id)}
                            className="p-1.5 rounded-lg bg-emerald-50 text-emerald-700 disabled:opacity-50"
                            title="Save rate"
                          >
                            <Save className="w-3.5 h-3.5" />
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          disabled={!canManageSkillTeachers}
                          onClick={() => {
                            setEditingRateFor(cts.id);
                            setEditingRateValue(cts.monthlyRate);
                          }}
                          className="font-mono font-bold text-indigo-700 px-1.5 disabled:cursor-default"
                          title={canManageSkillTeachers ? 'Click to edit rate' : undefined}
                        >
                          {formatAFN(cts.monthlyRate || 0)}
                        </button>
                      )}
                      {canManageSkillTeachers && (
                        <button
                          type="button"
                          disabled={skillTeacherBusy}
                          onClick={() => handleRemoveSkillTeacher(cts.id)}
                          className="p-1.5 rounded-lg bg-rose-50 text-rose-700 disabled:opacity-50"
                          title="Remove assignment"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>

            {canManageSkillTeachers && (
              <div className="pt-3 border-t border-slate-100 space-y-2">
                <p className="font-bold text-slate-700 text-[11px]">Add skill teacher</p>

                {skills.length === 0 && (
                  <p className="text-[10px] text-slate-400 italic">
                    No skills defined yet — add one below (e.g. Reading, Writing, Listening, Speaking).
                  </p>
                )}
                {addSkill && (
                  <div className="flex gap-1.5">
                    <input
                      type="text"
                      placeholder="New skill name (e.g. Reading)"
                      value={newSkillName}
                      onChange={(e) => setNewSkillName(e.target.value)}
                      className="flex-1 bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5"
                    />
                    <button
                      type="button"
                      disabled={skillTeacherBusy || !newSkillName.trim()}
                      onClick={handleQuickAddSkill}
                      className="px-2.5 py-1.5 rounded-lg bg-slate-100 text-slate-700 font-bold disabled:opacity-50 flex items-center gap-1"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Skill
                    </button>
                  </div>
                )}

                {skillCapReached && (
                  <p className="text-[10px] text-amber-700 font-semibold flex items-center gap-1">
                    3 skills already assigned to this class. Pick one of the existing skills above to add
                    another teacher to it, or remove one first.
                  </p>
                )}

                <form onSubmit={handleAssignSkillTeacher} className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <select
                    value={newAssignSkillId}
                    onChange={(e) => setNewAssignSkillId(e.target.value)}
                    className="bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5"
                    required
                  >
                    <option value="">Skill…</option>
                    {skills.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  <select
                    value={newAssignTeacherId}
                    onChange={(e) => {
                      setNewAssignTeacherId(e.target.value);
                      const t = teachers.find((tt) => tt.id === e.target.value);
                      if (t?.defaultSkillRate) setNewAssignRate(t.defaultSkillRate);
                    }}
                    className="bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5"
                    required
                  >
                    <option value="">Teacher…</option>
                    {eligibleTeachers.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.fullName}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    placeholder="Monthly rate"
                    value={newAssignRate}
                    onChange={(e) => setNewAssignRate(e.target.value === '' ? '' : Number(e.target.value))}
                    className="bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 font-mono"
                  />
                  <button
                    type="submit"
                    disabled={skillTeacherBusy || skillCapReached || !newAssignSkillId || !newAssignTeacherId}
                    className="sm:col-span-3 flex items-center justify-center gap-1.5 px-4 py-2 bg-violet-600 text-white rounded-lg font-bold disabled:opacity-50"
                  >
                    <UserCog className="w-3.5 h-3.5" />
                    Assign
                  </button>
                </form>
                {eligibleTeachers.length === 0 && newAssignSkillId && (
                  <p className="text-[10px] text-slate-400 italic">
                    No eligible teachers for this skill (teachers on a fixed monthly contract can't take skill
                    rates, and everyone else is already assigned to it here).
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}