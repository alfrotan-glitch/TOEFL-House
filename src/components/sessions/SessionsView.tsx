/**
 * Sessions — class-first timetable.
 * Flow: select class → weekly schedule → open session (skill + teacher + attendance).
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {CalendarDays, Plus, CheckCircle2, Ban, BookOpenCheck, Users, ClipboardCheck, Trash2, Loader2, AlertTriangle, ChevronLeft, ChevronRight, School, Sparkles} from 'lucide-react';
import {api} from '../../api/client';
import {Class, Student, Teacher, Session, UserRole, Skill, ClassTeacherSkill} from '../../types';
import Toast from '../common/Toast';

type AttendanceStatus = 'present' | 'absent' | 'sick' | 'leave' | 'not_marked';

interface RosterEntry {
  id: string;
  sessionId: string;
  studentId: string;
  studentName: string;
  studentCode: string;
  attendanceStatus: AttendanceStatus;
}

interface HomeworkItem {
  id: string;
  sessionId: string;
  title: string;
  description?: string;
  dueDate: string;
}

interface StudentAttendanceStat {
  studentId: string;
  studentName: string;
  studentCode: string;
  attendanceRate: number;
}

interface SessionsViewProps {
  sessions: Session[];
  classes: Class[];
  students: Student[];
  teachers: Teacher[];
  skills: Skill[];
  classTeacherSkills: ClassTeacherSkill[];
  activeRole: UserRole;
  activeBranchId?: string;
}

const ATTENDANCE_CYCLE: AttendanceStatus[] = ['not_marked', 'present', 'absent', 'sick', 'leave'];
const ATTENDANCE_META: Record<AttendanceStatus, { label: string; chip: string }> = {
  present: { label: 'Present', chip: 'bg-emerald-500 text-white' },
  absent: { label: 'Absent', chip: 'bg-rose-500 text-white' },
  sick: { label: 'Sick', chip: 'bg-sky-500 text-white' },
  leave: { label: 'Leave', chip: 'bg-amber-500 text-white' },
  not_marked: { label: 'Unmarked', chip: 'bg-slate-100 text-slate-500' },
};

const todayISO = () => new Date().toISOString().split('T')[0];

/** Local wall-clock vs session start (date + startTime). Attendance only after this. */
function sessionHasStarted(s: { date: string; startTime: string }): boolean {
  const dateParts = String(s.date || '').split('-').map((x) => Number(x));
  if (dateParts.length < 3 || dateParts.some((n) => Number.isNaN(n))) return false;
  const [y, mo, d] = dateParts;
  const raw = String(s.startTime || '00:00').trim();
  const tp = raw.split(':').map((x) => Number(x));
  const hh = Number.isFinite(tp[0]) ? tp[0] : 0;
  const mm = Number.isFinite(tp[1]) ? tp[1] : 0;
  const ss = Number.isFinite(tp[2]) ? tp[2] : 0;
  const start = new Date(y, mo - 1, d, hh, mm, ss, 0);
  return Date.now() >= start.getTime();
}

function sessionStartLabel(s: { date: string; startTime: string }): string {
  return `${s.date} at ${s.startTime}`;
}



function startOfWeek(d: Date): Date {
  const x = new Date(d);
  const day = x.getDay();
  const diff = day === 6 ? 0 : -(day + 1);
  x.setDate(x.getDate() + diff);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function iso(d: Date): string {
  return d.toISOString().split('T')[0];
}

function formatDay(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00`);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export default function SessionsView({
  sessions: sessionsProp,
  classes,
  teachers,
  skills,
  classTeacherSkills,
  activeRole,
  activeBranchId,
}: SessionsViewProps) {
  const canManage = ['owner', 'manager', 'registrar', 'head_of_department', 'teacher'].includes(activeRole);

  const [localSessions, setLocalSessions] = useState<Session[]>(sessionsProp);
  const [listLoading, setListLoading] = useState(false);
  const [selectedClassId, setSelectedClassId] = useState<string>(() => {
    // Restore a class id queued by another view (one-shot: cleared below).
    try { return sessionStorage.getItem('erp.openSessionsClassId') || ''; } catch { return ''; }
  });
  const [weekAnchor, setWeekAnchor] = useState<Date>(() => startOfWeek(new Date()));
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [homework, setHomework] = useState<HomeworkItem[]>([]);
  const [classAttendance, setClassAttendance] = useState<StudentAttendanceStat[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [savingRosterId, setSavingRosterId] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [createDate, setCreateDate] = useState(todayISO());
  const [createStart, setCreateStart] = useState('08:00');
  const [createEnd, setCreateEnd] = useState('09:30');
  const [createTopic, setCreateTopic] = useState('');
  const [createSkillId, setCreateSkillId] = useState('');
  const [createTeacherId, setCreateTeacherId] = useState('');
  const [creating, setCreating] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generateWeeks, setGenerateWeeks] = useState(4);
  const [generateSkillIds, setGenerateSkillIds] = useState<string[] | null>(null);
  const [showGenerate, setShowGenerate] = useState(false);

  const [hwTitle, setHwTitle] = useState('');
  const [hwDesc, setHwDesc] = useState('');
  const [hwDue, setHwDue] = useState('');

  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const notify = (message: string, type: 'success' | 'error' | 'info') => setToast({ message, type });

  const activeClasses = useMemo(
    () => classes.filter((c) => !c.status || c.status === 'active'),
    [classes]
  );
  const selectedClass = activeClasses.find((c) => c.id === selectedClassId) || null;

  const skillAssignments = useMemo(
    () => classTeacherSkills.filter((cts) => cts.classId === selectedClassId),
    [classTeacherSkills, selectedClassId]
  );

  const skillOptions = useMemo(() => {
    const map = new Map<string, { skillId: string; skillName: string; teachers: { id: string; name: string }[] }>();
    for (const cts of skillAssignments) {
      const sk = skills.find((s) => s.id === cts.skillId);
      const name = sk?.name || cts.skillId;
      const t = teachers.find((x) => x.id === cts.teacherId);
      if (!map.has(cts.skillId)) {
        map.set(cts.skillId, { skillId: cts.skillId, skillName: name, teachers: [] });
      }
      if (t && !map.get(cts.skillId)!.teachers.some((x) => x.id === t.id)) {
        map.get(cts.skillId)!.teachers.push({ id: t.id, name: t.fullName });
      }
    }
    return Array.from(map.values());
  }, [skillAssignments, skills, teachers]);

  const weekDays = useMemo(() => {
    const start = startOfWeek(weekAnchor);
    return Array.from({ length: 7 }, (_, i) => {
      const d = addDays(start, i);
      return { date: iso(d), label: formatDay(iso(d)), isToday: iso(d) === todayISO() };
    });
  }, [weekAnchor]);

  const weekSessions = useMemo(() => {
    if (!selectedClassId) return [];
    const start = weekDays[0]?.date;
    const end = weekDays[6]?.date;
    return localSessions
      .filter((s) => s.classId === selectedClassId && s.date >= start && s.date <= end)
      .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
  }, [localSessions, selectedClassId, weekDays]);

  const selectedSession = useMemo(
    () => localSessions.find((s) => s.id === selectedId) || null,
    [localSessions, selectedId]
  );

  const todaySessions = useMemo(() => {
    const tday = todayISO();
    return localSessions
      .filter((s) => s.date === tday && s.status !== 'cancelled')
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
  }, [localSessions]);

  const teacherName = (id?: string) => teachers.find((t) => t.id === id)?.fullName || '—';
  const skillName = (id?: string | null) =>
    (id && skills.find((s) => s.id === id)?.name) || null;

  const refreshSessions = useCallback(async () => {
    setListLoading(true);
    try {
      const params: Record<string, string> = {};
      if (activeBranchId) params.branchId = activeBranchId;
      const fresh = await api.get<Session[]>('/sessions', params);
      setLocalSessions(fresh);
    } catch {
      notify('Failed to load sessions.', 'error');
    } finally {
      setListLoading(false);
    }
  }, [activeBranchId]);

  const loadDetail = useCallback(async (sessionId: string, classId: string) => {
    setDetailLoading(true);
    try {
      const [r, h, a] = await Promise.all([
        api.get<RosterEntry[]>(`/sessions/${sessionId}/roster`),
        api.get<HomeworkItem[]>(`/sessions/${sessionId}/homework`),
        api
          .get<StudentAttendanceStat[]>('/sessions/analytics/student-attendance', { classId })
          .catch(() => [] as StudentAttendanceStat[]),
      ]);
      setRoster(r);
      setHomework(h);
      setClassAttendance(a);
    } catch {
      notify('Failed to load session details.', 'error');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  // Keep the editable local copy in sync with the loaded sessions by
  // adjusting state during render (no setState-in-effect).
  const [prevSessionsProp, setPrevSessionsProp] = useState(sessionsProp);
  if (prevSessionsProp !== sessionsProp) {
    setPrevSessionsProp(sessionsProp);
    setLocalSessions(sessionsProp);
  }

  useEffect(() => {
    try { sessionStorage.removeItem('erp.openSessionsClassId'); } catch { /* ignore */ }
    if (sessionsProp.length === 0) {
      void (async () => { await refreshSessions(); })();
    }
  }, [sessionsProp.length, refreshSessions]);

  useEffect(() => {
    void (async () => {
      if (selectedSession) await loadDetail(selectedSession.id, selectedSession.classId);
    })();
  }, [selectedId, selectedSession, loadDetail]);

  // Clear the open session detail whenever the selected class changes.
  const [prevSelectedClassId, setPrevSelectedClassId] = useState<string>(selectedClassId);
  if (prevSelectedClassId !== selectedClassId) {
    setPrevSelectedClassId(selectedClassId);
    setSelectedId(null);
  }

  // When the skill or class changes in the create form, default the teacher,
  // by adjusting state during render (no setState-in-effect).
  const [prevTeacherDefaultKey, setPrevTeacherDefaultKey] = useState('');
  const teacherDefaultKey = `${createSkillId}|${selectedClass?.id ?? ''}`;
  if (prevTeacherDefaultKey !== teacherDefaultKey) {
    setPrevTeacherDefaultKey(teacherDefaultKey);
    const opt = skillOptions.find((s) => s.skillId === createSkillId);
    if (opt?.teachers[0]) setCreateTeacherId(opt.teachers[0].id);
    else if (selectedClass?.teacherId) setCreateTeacherId(selectedClass.teacherId);
    else setCreateTeacherId('');
  }

  const cycleAttendance = async (entry: RosterEntry) => {
    if (!selectedSession || !canManage) return;
    if (!sessionHasStarted(selectedSession)) {
      notify(
        `Attendance opens when the meeting starts (${sessionStartLabel(selectedSession)}).`,
        'error'
      );
      return;
    }
    const next =
      ATTENDANCE_CYCLE[(ATTENDANCE_CYCLE.indexOf(entry.attendanceStatus) + 1) % ATTENDANCE_CYCLE.length];
    const prev = entry.attendanceStatus;
    setRoster((rs) => rs.map((r) => (r.id === entry.id ? { ...r, attendanceStatus: next } : r)));
    setSavingRosterId(entry.id);
    try {
      await api.patch(`/sessions/${selectedSession.id}/roster/${entry.id}`, { status: next });
    } catch {
      setRoster((rs) => rs.map((r) => (r.id === entry.id ? { ...r, attendanceStatus: prev } : r)));
      notify('Failed to save attendance.', 'error');
    } finally {
      setSavingRosterId(null);
    }
  };

  const setSessionStatus = async (status: 'completed' | 'cancelled') => {
    if (!selectedSession) return;
    if (status === 'completed' && !sessionHasStarted(selectedSession)) {
      notify(
        `You can mark complete only after the meeting starts (${sessionStartLabel(selectedSession)}).`,
        'error'
      );
      return;
    }
    try {
      await api.patch(`/sessions/${selectedSession.id}/status`, { status });
      await refreshSessions();
      notify(status === 'completed' ? 'Session completed.' : 'Session cancelled.', 'success');
    } catch {
      notify('Failed to update session.', 'error');
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedClassId) {
      notify('Select a class first.', 'error');
      return;
    }
    const clash = localSessions.find(
      (s) =>
        s.classId === selectedClassId &&
        s.date === createDate &&
        s.startTime === createStart &&
        s.status !== 'cancelled'
    );
    if (clash) {
      notify(`This class already has a meeting on ${createDate} at ${createStart}.`, 'error');
      return;
    }
    setCreating(true);
    try {
      await api.post('/sessions', {
        classId: selectedClassId,
        date: createDate,
        startTime: createStart,
        endTime: createEnd,
        topic: createTopic || undefined,
        teacherId: createTeacherId || selectedClass?.teacherId,
        skillId: createSkillId || undefined,
      });
      await refreshSessions();
      setShowCreate(false);
      setCreateTopic('');
      setCreateSkillId('');
      notify('Session scheduled. Roster filled from class enrollments.', 'success');
    } catch {
      notify('Failed to create session.', 'error');
    } finally {
      setCreating(false);
    }
  };


  const handleGenerateWeek = async () => {
    if (!selectedClassId) return;
    const selectedSkillIds = generateSkillIds === null ? skillOptions.map((s) => s.skillId) : generateSkillIds;
    setGenerating(true);
    try {
      const res = await api.post<{ created: number; skipped: number }>('/sessions/generate', {
        classId: selectedClassId,
        weeks: generateWeeks,
        daysOfWeek: [6, 0, 1, 2, 3, 4], // Sat–Thu
        skillIds: selectedSkillIds.length ? selectedSkillIds : undefined,
        teacherId: selectedClass?.teacherId || undefined,
      });
      await refreshSessions();
      setShowGenerate(false);
      setGenerateSkillIds(null);
      notify(
        `Created ${res.created} meeting(s)` +
          (res.skipped ? `, skipped ${res.skipped} conflict(s)` : '') +
          '.',
        'success'
      );
    } catch (err: unknown) {
      const msg =
        err && typeof err === 'object' && 'message' in err
          ? String((err as { message: string }).message)
          : 'Could not generate timetable.';
      notify(msg, 'error');
    } finally {
      setGenerating(false);
    }
  };

  const handleSyncRoster = async () => {
    if (!selectedSession) return;
    try {
      const res = await api.post<{ added?: number }>(`/sessions/${selectedSession.id}/sync-roster`, {});
      await loadDetail(selectedSession.id, selectedSession.classId);
      notify(
        res && typeof res.added === 'number'
          ? `Roster updated (+${res.added} student(s)).`
          : 'Roster synced with current enrollments.',
        'success'
      );
    } catch {
      notify('Could not sync roster.', 'error');
    }
  };

  const handleAddHomework = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSession || !hwTitle || !hwDue) return;
    try {
      await api.post(`/sessions/${selectedSession.id}/homework`, {
        title: hwTitle,
        description: hwDesc || undefined,
        dueDate: hwDue,
      });
      const fresh = await api.get<HomeworkItem[]>(`/sessions/${selectedSession.id}/homework`);
      setHomework(fresh);
      setHwTitle('');
      setHwDesc('');
      setHwDue('');
      notify('Homework assigned.', 'success');
    } catch {
      notify('Failed to assign homework.', 'error');
    }
  };

  const handleDeleteHomework = async (hwId: string) => {
    if (!selectedSession) return;
    try {
      await api.delete(`/sessions/${selectedSession.id}/homework/${hwId}`);
      setHomework((h) => h.filter((x) => x.id !== hwId));
    } catch {
      notify('Failed to remove homework.', 'error');
    }
  };

  const weekLabel = `${formatDay(weekDays[0]?.date || '')} – ${formatDay(weekDays[6]?.date || '')}`;

  const canCompleteSession =
    !!selectedSession &&
    selectedSession.status === 'scheduled' &&
    sessionHasStarted(selectedSession);
  const canMarkAttendance =
    !!selectedSession &&
    sessionHasStarted(selectedSession) &&
    selectedSession.status !== 'cancelled';


  return (
    <div className="space-y-5 text-left font-sans" dir="ltr">
      {/* Header */}
      <div className="flex flex-col gap-3 border-b border-slate-200 pb-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-extrabold text-slate-900">
            <CalendarDays className="h-6 w-6 text-indigo-600" />
            Class timetable
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            A session is one real meeting (date+time). Steps: 1) pick class  2) plan the week  3) open meeting for skill, teacher, attendance.
          </p>
        </div>
        {canManage && selectedClassId && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setShowGenerate(true)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-indigo-200 bg-white px-4 py-2.5 text-xs font-bold text-indigo-700 shadow-sm hover:bg-indigo-50"
            >
              Build timetable
            </button>
            <button
              type="button"
              onClick={() => {
                setCreateDate(todayISO());
                setShowCreate(true);
              }}
              className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2.5 text-xs font-bold text-white shadow-sm hover:bg-indigo-700"
            >
              <Plus className="h-4 w-4" />
              Add meeting
            </button>
          </div>
        )}
      </div>

      {todaySessions.length > 0 && (
        <div className="rounded-2xl border border-emerald-100 bg-emerald-50/50 p-4">
          <p className="text-[10px] font-bold uppercase tracking-wide text-emerald-700/80">
            Today&apos;s meetings · {todayISO()}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {todaySessions.map((s) => {
              const cls = classes.find((c) => c.id === s.classId);
              const open = sessionHasStarted(s);
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    setSelectedClassId(s.classId);
                    setSelectedId(s.id);
                  }}
                  className={`rounded-xl border px-3 py-2 text-left text-[11px] ${
                    open ? 'border-emerald-300 bg-white shadow-sm' : 'border-slate-200 bg-white/80 text-slate-500'
                  }`}
                >
                  <span className="font-mono font-bold">{s.startTime}</span>
                  <span className="mx-1 text-slate-300">·</span>
                  <span className="font-bold text-slate-800">{cls?.name || s.className || 'Class'}</span>
                  {!open && <span className="ml-1 text-[9px] text-amber-600">locked</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Class picker — entry point */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <label className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
          Step 1 — Which class?
        </label>
        <div className="mt-1.5 flex flex-col gap-2 sm:flex-row sm:items-center">
          <select
            value={selectedClassId}
            onChange={(e) => setSelectedClassId(e.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-semibold text-slate-900 sm:max-w-md"
          >
            <option value="">— Select a class to continue —</option>
            {activeClasses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.level}
                {c.scheduleTime ? ` · ${c.scheduleTime}` : ''}
              </option>
            ))}
          </select>
          {selectedClass && (
            <p className="text-[11px] text-slate-500">
              Lead teacher: <span className="font-bold text-slate-700">{teacherName(selectedClass.teacherId)}</span>
              {skillAssignments.length > 0 && (
                <> · {skillAssignments.length} skill assignment(s)</>
              )}
            </p>
          )}
        </div>
      </div>

      {!selectedClassId ? (
        <div className="rounded-2xl border border-dashed border-indigo-200 bg-indigo-50/40 px-6 py-14 text-center">
          <School className="mx-auto h-10 w-10 text-indigo-400" />
          <h3 className="mt-3 text-sm font-extrabold text-slate-900">Start by picking a class</h3>
          <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
            Select a class above. You will see its weekly timetable, then open any session for attendance,
            homework, and the skill taught that day.
          </p>
          {activeClasses.length === 0 && (
            <p className="mt-3 text-xs font-semibold text-amber-700">
              No active classes yet — create one under Classes first.
            </p>
          )}
        </div>
      ) : (
        <>
          {/* Week navigation */}
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setWeekAnchor((d) => addDays(d, -7))}
              className="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50"
            >
              <ChevronLeft className="h-4 w-4" /> Prev week
            </button>
            <div className="text-center">
              <p className="text-sm font-extrabold text-slate-900">{weekLabel}</p>
              <button
                type="button"
                onClick={() => setWeekAnchor(startOfWeek(new Date()))}
                className="text-[10px] font-bold text-indigo-600 hover:underline"
              >
                Jump to this week
              </button>
            </div>
            <button
              type="button"
              onClick={() => setWeekAnchor((d) => addDays(d, 7))}
              className="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50"
            >
              Next week <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          {listLoading && (
            <div className="flex items-center justify-center gap-2 py-6 text-xs text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading timetable…
            </div>
          )}

          {/* Weekly grid */}
          <div className="grid grid-cols-1 gap-2 md:grid-cols-7">
            {weekDays.map((day) => {
              const daySessions = weekSessions.filter((s) => s.date === day.date);
              return (
                <div
                  key={day.date}
                  className={`min-h-[120px] rounded-2xl border p-2 ${
                    day.isToday ? 'border-indigo-300 bg-indigo-50/40' : 'border-slate-200 bg-white'
                  }`}
                >
                  <p
                    className={`mb-2 text-[10px] font-bold ${
                      day.isToday ? 'text-indigo-700' : 'text-slate-400'
                    }`}
                  >
                    {day.label}
                  </p>
                  <div className="space-y-1.5">
                    {daySessions.length === 0 ? (
                      <p className="text-[10px] italic text-slate-300">—</p>
                    ) : (
                      daySessions.map((s) => {
                        const sk =
                          s.skillName || skillName(s.skillId) || null;
                        return (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => setSelectedId(s.id)}
                            className={`w-full rounded-xl border px-2 py-1.5 text-left transition ${
                              selectedId === s.id
                                ? 'border-indigo-400 bg-indigo-600 text-white shadow-sm'
                                : 'border-slate-100 bg-slate-50 hover:border-indigo-200'
                            }`}
                          >
                            <p className="font-mono text-[10px] font-bold opacity-90">
                              {s.startTime}–{s.endTime}
                            </p>
                            {sk && (
                              <p className={`text-[10px] font-bold ${selectedId === s.id ? 'text-indigo-100' : 'text-indigo-700'}`}>
                                <Sparkles className="mr-0.5 inline h-2.5 w-2.5" />
                                {sk}
                              </p>
                            )}
                            <p className={`truncate text-[10px] ${selectedId === s.id ? 'text-white/80' : 'text-slate-500'}`}>
                              {s.teacherName || teacherName(s.teacherId)}
                            </p>
                            {s.topic && (
                              <p className={`truncate text-[9px] ${selectedId === s.id ? 'text-white/70' : 'text-slate-400'}`}>
                                {s.topic}
                              </p>
                            )}
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {weekSessions.length === 0 && !listLoading && (
            <div className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-6 text-center text-xs text-slate-400">
              No sessions this week for <span className="font-bold text-slate-600">{selectedClass?.name}</span>.
              {canManage && ' Use “Add meeting” to add the first meeting.'}
            </div>
          )}

          {/* Session detail */}
          {selectedSession && (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
              <div className="space-y-4 lg:col-span-3">
                <div className="rounded-2xl border border-slate-200 bg-gradient-to-br from-indigo-950 to-indigo-800 p-5 text-white shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-wide text-indigo-200">
                        {selectedClass?.name} · {formatDay(selectedSession.date)}
                      </p>
                      <h3 className="mt-1 text-lg font-extrabold">
                        {selectedSession.startTime}–{selectedSession.endTime}
                      </h3>
                      <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
                        {(selectedSession.skillName || skillName(selectedSession.skillId)) && (
                          <span className="rounded-full bg-white/15 px-2.5 py-0.5 font-bold">
                            Skill: {selectedSession.skillName || skillName(selectedSession.skillId)}
                          </span>
                        )}
                        <span className="rounded-full bg-white/15 px-2.5 py-0.5 font-bold">
                          Teacher: {selectedSession.teacherName || teacherName(selectedSession.teacherId)}
                        </span>
                        <span className="rounded-full bg-white/15 px-2.5 py-0.5 font-bold capitalize">
                          {selectedSession.status}
                        </span>
                      </div>
                      {selectedSession.topic && (
                        <p className="mt-2 text-xs text-indigo-100">Topic: {selectedSession.topic}</p>
                      )}
                    </div>
                    {canManage && selectedSession.status === 'scheduled' && (
                      <div className="flex flex-col items-end gap-1">
                        {!canCompleteSession && (
                          <p className="text-[10px] text-amber-200 text-right">
                            Complete opens at {sessionStartLabel(selectedSession)}
                          </p>
                        )}
                        <div className="flex gap-2">
                          <button
                            type="button"
                            disabled={!canCompleteSession}
                            onClick={() => setSessionStatus('completed')}
                            className="inline-flex items-center gap-1 rounded-lg bg-emerald-500 px-3 py-1.5 text-[11px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            <CheckCircle2 className="h-3.5 w-3.5" /> Complete
                          </button>
                          <button
                            type="button"
                            onClick={() => setSessionStatus('cancelled')}
                            className="inline-flex items-center gap-1 rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-[11px] font-bold text-white"
                          >
                            <Ban className="h-3.5 w-3.5" /> Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <h4 className="mb-3 flex items-center gap-1.5 text-sm font-extrabold text-slate-900">
                    <ClipboardCheck className="h-4 w-4 text-indigo-600" /> Who attended?
                  </h4>
                  {canManage && (
                    <button
                      type="button"
                      onClick={handleSyncRoster}
                      className="mb-2 text-[10px] font-bold text-indigo-600 hover:underline"
                    >
                      Sync roster with enrollments
                    </button>
                  )}
                  {!canMarkAttendance && selectedSession && selectedSession.status !== 'cancelled' ? (
                    <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
                      <strong>Attendance locked.</strong> Opens at{' '}
                      <span className="font-mono font-bold">{sessionStartLabel(selectedSession)}</span>.
                    </div>
                  ) : (
                    <p className="mb-2 text-[10px] text-slate-400">
                      Tap a name to cycle Present / Absent / Sick / Leave
                    </p>
                  )}
                  {detailLoading ? (
                    <div className="flex items-center gap-2 py-8 text-xs text-slate-400">
                      <Loader2 className="h-4 w-4 animate-spin" /> Loading roster…
                    </div>
                  ) : roster.length === 0 ? (
                    <p className="py-6 text-center text-xs text-slate-400">
                      No students on roster. Enroll students in this class first.
                    </p>
                  ) : (
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {roster.map((entry) => {
                        const meta = ATTENDANCE_META[entry.attendanceStatus];
                        return (
                          <button
                            key={entry.id}
                            type="button"
                            disabled={!canManage || !canMarkAttendance || savingRosterId === entry.id}
                            onClick={() => cycleAttendance(entry)}
                            className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-left hover:border-indigo-200 disabled:opacity-60"
                          >
                            <div>
                              <p className="text-xs font-bold text-slate-800">{entry.studentName}</p>
                              <p className="font-mono text-[10px] text-slate-400">{entry.studentCode}</p>
                            </div>
                            <span className={`rounded-lg px-2 py-0.5 text-[10px] font-bold ${meta.chip}`}>
                              {meta.label}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {canManage && roster.length > 0 && (
                    <p className="mt-2 text-[10px] text-slate-400">Tap a student to cycle attendance status.</p>
                  )}
                </div>
              </div>

              <div className="space-y-4 lg:col-span-2">
                <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <h4 className="mb-3 flex items-center gap-1.5 text-sm font-extrabold text-slate-900">
                    <BookOpenCheck className="h-4 w-4 text-indigo-600" /> Homework
                  </h4>
                  {homework.length === 0 ? (
                    <p className="mb-3 text-xs text-slate-400">No homework for this session.</p>
                  ) : (
                    <ul className="mb-3 space-y-2">
                      {homework.map((hw) => (
                        <li
                          key={hw.id}
                          className="flex items-start justify-between gap-2 rounded-xl border border-slate-100 bg-slate-50 px-3 py-2"
                        >
                          <div>
                            <p className="text-xs font-bold text-slate-800">{hw.title}</p>
                            <p className="text-[10px] text-slate-400">Due {hw.dueDate}</p>
                          </div>
                          {canManage && (
                            <button type="button" onClick={() => handleDeleteHomework(hw.id)} className="text-rose-500">
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {canManage && (
                    <form onSubmit={handleAddHomework} className="space-y-2 border-t border-slate-100 pt-3">
                      <input
                        value={hwTitle}
                        onChange={(e) => setHwTitle(e.target.value)}
                        placeholder="Homework title"
                        className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs"
                      />
                      <input
                        type="date"
                        value={hwDue}
                        onChange={(e) => setHwDue(e.target.value)}
                        className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs"
                      />
                      <button
                        type="submit"
                        className="w-full rounded-lg bg-indigo-600 py-1.5 text-[11px] font-bold text-white"
                      >
                        Assign homework
                      </button>
                    </form>
                  )}
                </div>

                {classAttendance.length > 0 && (
                  <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                    <h4 className="mb-2 flex items-center gap-1.5 text-sm font-extrabold text-slate-900">
                      <Users className="h-4 w-4 text-indigo-600" /> Class attendance rates
                    </h4>
                    <div className="max-h-48 space-y-2 overflow-y-auto">
                      {classAttendance.slice(0, 12).map((st) => (
                        <div key={st.studentId} className="flex items-center gap-2 text-[11px]">
                          <span className="w-24 truncate font-semibold text-slate-700">{st.studentName}</span>
                          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                            <div
                              className={`h-full rounded-full ${
                                st.attendanceRate >= 85
                                  ? 'bg-emerald-500'
                                  : st.attendanceRate >= 70
                                    ? 'bg-amber-500'
                                    : 'bg-rose-500'
                              }`}
                              style={{ width: `${st.attendanceRate}%` }}
                            />
                          </div>
                          <span className="w-8 font-mono font-bold text-slate-600">
                            {Math.round(st.attendanceRate)}%
                          </span>
                          {st.attendanceRate < 85 && (
                            <AlertTriangle className="h-3 w-3 shrink-0 text-amber-500" />
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* Create modal */}
      {showGenerate && selectedClass && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <h3 className="text-sm font-extrabold text-slate-900">Build weekly timetable</h3>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
              Creates Saturday–Thursday meetings for <strong>{selectedClass.name}</strong>.
              Uses class schedule times when set. Conflicts are skipped automatically.
            </p>
            <div className="mt-4">
              <label className="text-xs font-bold text-slate-600">Weeks to generate</label>
              <select
                value={generateWeeks}
                onChange={(e) => setGenerateWeeks(Number(e.target.value))}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-xs"
              >
                {[1, 2, 4, 6, 8, 12].map((n) => (
                  <option key={n} value={n}>{n} week{n > 1 ? 's' : ''}</option>
                ))}
              </select>
            </div>
            <div className="mt-4">
              <div className="flex items-center justify-between">
                <label className="text-xs font-bold text-slate-600">Skills included</label>
                <button
                  type="button"
                  onClick={() => setGenerateSkillIds(generateSkillIds === null ? skillOptions.map((s) => s.skillId) : null)}
                  className="text-[10px] font-bold text-indigo-600"
                >
                  {generateSkillIds === null ? 'Clear selection' : 'Select all'}
                </button>
              </div>
              <div className="mt-2 max-h-40 space-y-2 overflow-y-auto rounded-xl border border-slate-200 p-3">
                {skillOptions.map((s) => {
                  const checked = generateSkillIds === null || generateSkillIds.includes(s.skillId);
                  return (
                    <label key={s.skillId} className="flex items-center gap-2 text-[11px] font-semibold text-slate-700">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => setGenerateSkillIds((prev) => {
                          const effective = prev === null ? skillOptions.map((x) => x.skillId) : prev;
                          if (effective.includes(s.skillId) && effective.length === 1) return effective;
                          return effective.includes(s.skillId)
                            ? effective.filter((id) => id !== s.skillId)
                            : [...effective, s.skillId];
                        })}
                      />
                      {s.skillName}
                    </label>
                  );
                })}
                {skillOptions.length === 0 && <p className="text-[10px] text-amber-700">No class skills are configured. Timetable can only be generated without skill labels.</p>}
              </div>
              <p className="mt-1 text-[10px] leading-relaxed text-slate-500">All selected skills are scheduled across the chosen teaching days in a fair rotation. No skill is silently dropped.</p>
            </div>
            <div className="mt-4 flex gap-2">
              <button type="button" onClick={() => setShowGenerate(false)}
                className="flex-1 rounded-xl border border-slate-200 py-2.5 text-xs font-bold text-slate-600">Cancel</button>
              <button type="button" disabled={generating} onClick={handleGenerateWeek}
                className="flex-1 rounded-xl bg-indigo-600 py-2.5 text-xs font-bold text-white disabled:opacity-50">
                {generating ? 'Building…' : 'Generate'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showCreate && selectedClassId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <h3 className="text-sm font-extrabold text-slate-900">Add meeting</h3>
            <p className="mt-0.5 text-[11px] text-slate-500">{selectedClass?.name}</p>
            <form onSubmit={handleCreate} className="mt-4 space-y-3 text-xs">
              <div>
                <label className="font-bold text-slate-500">Date</label>
                <input
                  type="date"
                  required
                  value={createDate}
                  onChange={(e) => setCreateDate(e.target.value)}
                  className="mt-0.5 w-full rounded-xl border border-slate-200 px-3 py-2"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="font-bold text-slate-500">Start</label>
                  <input
                    type="time"
                    required
                    value={createStart}
                    onChange={(e) => setCreateStart(e.target.value)}
                    className="mt-0.5 w-full rounded-xl border border-slate-200 px-3 py-2"
                  />
                </div>
                <div>
                  <label className="font-bold text-slate-500">End</label>
                  <input
                    type="time"
                    required
                    value={createEnd}
                    onChange={(e) => setCreateEnd(e.target.value)}
                    className="mt-0.5 w-full rounded-xl border border-slate-200 px-3 py-2"
                  />
                </div>
              </div>
              <div>
                <label className="font-bold text-slate-500">Skill taught this session</label>
                <select
                  value={createSkillId}
                  onChange={(e) => setCreateSkillId(e.target.value)}
                  className="mt-0.5 w-full rounded-xl border border-slate-200 px-3 py-2"
                >
                  <option value="">— Optional —</option>
                  {skillOptions.map((s) => (
                    <option key={s.skillId} value={s.skillId}>
                      {s.skillName}
                    </option>
                  ))}
                </select>
                {skillOptions.length === 0 && (
                  <p className="mt-1 text-[10px] text-amber-700">
                    No skill assignments on this class yet. Assign skills under Teachers (class–skill–teacher).
                  </p>
                )}
              </div>
              <div>
                <label className="font-bold text-slate-500">Teacher</label>
                <select
                  value={createTeacherId}
                  onChange={(e) => setCreateTeacherId(e.target.value)}
                  className="mt-0.5 w-full rounded-xl border border-slate-200 px-3 py-2"
                >
                  <option value="">Default class teacher</option>
                  {(skillOptions.find((s) => s.skillId === createSkillId)?.teachers.length
                    ? skillOptions.find((s) => s.skillId === createSkillId)!.teachers
                    : teachers
                        .filter((t) => (t.status || 'active') === 'active')
                        .map((t) => ({ id: t.id, name: t.fullName }))
                  ).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="font-bold text-slate-500">Topic (optional)</label>
                <input
                  value={createTopic}
                  onChange={(e) => setCreateTopic(e.target.value)}
                  placeholder="e.g. Integrated writing practice"
                  className="mt-0.5 w-full rounded-xl border border-slate-200 px-3 py-2"
                />
              </div>
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  className="flex-1 rounded-xl border border-slate-200 py-2 font-bold text-slate-600"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="flex-1 rounded-xl bg-indigo-600 py-2 font-bold text-white disabled:opacity-50"
                >
                  {creating ? 'Saving…' : 'Save meeting'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {toast && (
        <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
      )}
    </div>
  );
}
