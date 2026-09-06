import { FormEvent, useEffect, useMemo, useState } from 'react';

export type AcademicClass = {
  id: string;
  branch_id: string;
  organization_id: string | null;
  campus_id: string | null;
  program_version_id: string;
  program_version_level_id: string | null;
  period_id: string;
  offering_id: string | null;
  capacity: number;
  requested_seats: number;
  active_seats: number;
  frozen_seats: number;
  claimed_seats: number;
  remaining_seats: number;
  open_waitlist_entries: number;
  lifecycle_state: string;
  allowed_transitions: string[];
  offering: { id: string; capacity: number; lifecycle_state: string } | null;
  sections: Array<{ id: string; name: string; capacity: number; lifecycle_state: string }>;
  teachers: Array<{ id: string; teacher_person_id: string; teacher_profile_id: string | null; identity_consistent?: boolean; assignment_branch_id?: string | null; lifecycle_state: string | null; effective_from: string; effective_to: string | null; current: boolean }>;
  capabilities: { schedule: boolean; attendance: boolean; request_enrollment: boolean; approve_enrollment: boolean; assess: boolean; moderate_assessment: boolean; approve_assessment: boolean; release_assessment: boolean; propose_progression: boolean; review_progression: boolean; approve_progression: boolean };
};

type AcademicWorkspace = {
  generated_at: string;
  scope: { branches: Array<{ id: string; name: string; organization_id: string | null; campus_id: string | null }>; branch_ids: string[] };
  capabilities: { structure: boolean; branch_ids: Record<string, string[]>; actions: Record<string, boolean> };
  classes: AcademicClass[];
  offerings: Array<{ id: string; branch_id: string; program_version_level_id: string; academic_period_id: string; capacity: number; requested_seats: number; active_seats: number; frozen_seats: number; claimed_seats: number; remaining_seats: number; open_waitlist_entries: number; lifecycle_state: string; classes_count: number }>;
  availabilities: Array<{ id: string; branch_id: string; program_version_level_id: string; academic_period_id: string; lifecycle_state: string }>;
  sessions: Array<{ id: string; class_id: string; scheduled_on: string; starts_at: string; ends_at: string; room_id: string | null; section_id: string | null; room: { id: string; name: string; code: string } | null; section: { id: string; name: string } | null }>;
  enrollments: Array<{ id: string; student_id: string; class_id: string; offering_id: string | null; lifecycle_state: string; state_reason: string | null }>;
  waitlist: Array<{ id: string; class_id: string; student_id: string; offering_id: string | null; position: number; lifecycle_state: string }>;
  attendance: Array<{ id: string; session_id: string; enrollment_id: string; status: string; corrects_id: string | null; reason: string | null }>;
  attempts: Array<{ id: string; enrollment_id: string; kind: string; evidence_ref: string; lifecycle_state: string }>;
  results: Array<{ id: string; attempt_id: string; score: string; lifecycle_state: string }>;
  progressions: Array<{ id: string; class_id: string; student_id: string; outcome: string; reason: string; lifecycle_state: string; proposed_by: string | null; reviewed_by: string | null; approved_by: string | null; appeal_reviewed_by: string | null; superseded_by_id: string | null; assessment_result_id: string | null }>;
  graduations: Array<{ id: string; student_id: string; program_version_id: string; outcome: string; basis: string; lifecycle_state: string; proposed_by: string | null; reviewed_by: string | null; approved_by: string | null }>;
  transcripts: Array<{ id: string; student_id: string; program_version_id: string; content_hash: string; document_id: string; issued_by: string; issued_at: string | null }>;
  appeals: Array<{ id: string; student_id: string | null; subject_type: string; subject_id: string; reason: string; lifecycle_state: string; assigned_reviewer_id: string | null; outcome: string | null; outcome_evidence: string | null }>;
  students: Array<{ id: string; student_code: string; name: string; branch_id: string }>;
  teachers: Array<{ id: string; name: string; branch_id: string }>;
  rooms: Array<{ id: string; branch_id: string; name: string; code: string; capacity: number }>;
  periods: Array<{ id: string; name: string; starts_on: string; ends_on: string; lifecycle_state: string }>;
  program_versions: Array<{ id: string; program_id: string; program_name: string; version_no: number; summary: string }>;
  levels: Array<{ id: string; program_version_id: string; level_key: string; ordinal: number; title: string; cefr_ref: string | null; lifecycle_state: string }>;
  skills: Array<{ id: string; key: string; name: string }>;
};

type AcademicProps = { getJson: <T>(path: string) => Promise<T>; postJson: <T>(path: string, body?: Record<string, unknown>) => Promise<T>; csrfToken: string };

function academicHumanize(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function AcademicHeader({ csrfToken }: { csrfToken: string }) {
  return <header className="app-header"><a className="app-brand" href="/workspace">The <span>TOEFL</span> House</a><nav aria-label="Primary navigation"><a href="/workspace">Workspace</a><a href="/students">Students</a><a href="/crm">CRM</a><a href="/management">Management</a><a aria-current="page" href="/academic">Academic</a><a href="/finance">Finance</a><a href="/reporting">Reporting</a></nav><form method="post" action="/logout"><input type="hidden" name="_token" value={csrfToken} /><button className="sign-out" type="submit">Sign out</button></form></header>;
}

export function AcademicApp({ getJson, postJson, csrfToken }: AcademicProps) {
  const [data, setData] = useState<AcademicWorkspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [tab, setTab] = useState('classes');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [branchFilter, setBranchFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [schedule, setSchedule] = useState({ scheduled_on: '', starts_at: '09:00', ends_at: '10:30', room_id: '', section_id: '', skill_id: '' });
  const [attendance, setAttendance] = useState({ session_id: '', enrollment_id: '', status: 'present' });
  const [attendanceCorrection, setAttendanceCorrection] = useState({ fact_id: '', status: 'present', reason: '' });
  const [studentId, setStudentId] = useState('');
  const [newClass, setNewClass] = useState({ program_version_id: '', period_id: '', level_id: '', branch_id: '', offering_id: '', capacity: '1' });
  const [teacher, setTeacher] = useState({ teacher_person_id: '', effective_from: '', effective_to: '' });
  const [section, setSection] = useState({ name: '', capacity: '1' });
  const [assessment, setAssessment] = useState({ enrollment_id: '', kind: 'assessment', evidence_ref: '', attempt_id: '', score: '' });
  const [progression, setProgression] = useState({ student_id: '', outcome: 'advance', reason: '', assessment_result_id: '', basis: '', repeat_count: '' });
  const [supersede, setSupersede] = useState({ outcome: 'advance', reason: '' });
  const [graduation, setGraduation] = useState({ student_id: '', program_version_id: '', outcome: 'eligible', basis: '' });

  const load = () => {
    setLoading(true);
    setError(null);
    void getJson<AcademicWorkspace>('/academic/workspace')
      .then((response) => {
        setData(response);
        setSelectedId((current) => current && response.classes.some((item) => item.id === current) ? current : response.classes[0]?.id ?? null);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'The authorized Academic Classes workspace could not be loaded.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const mutate = (path: string, body?: Record<string, unknown>, success = 'Academic state changed.') => {
    setError(null);
    setMessage(null);
    void postJson(path, body)
      .then(() => { setMessage(success); load(); })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'The academic command was rejected.'));
  };

  const filteredClasses = useMemo(() => (data?.classes ?? []).filter((item) => {
    const matchesBranch = branchFilter === 'all' || item.branch_id === branchFilter;
    const matchesState = statusFilter === 'all' || item.lifecycle_state === statusFilter;
    const haystack = `${item.id} ${item.program_version_id} ${item.program_version_level_id ?? ''} ${item.period_id}`.toLowerCase();
    return matchesBranch && matchesState && haystack.includes(search.toLowerCase());
  }), [data, branchFilter, statusFilter, search]);
  const selected = data?.classes.find((item) => item.id === selectedId) ?? null;
  const selectedBranch = data?.scope.branches.find((branch) => branch.id === selected?.branch_id);
  const levelName = (id: string | null) => data?.levels.find((level) => level.id === id)?.title ?? id ?? 'Unspecified level';
  const periodName = (id: string) => data?.periods.find((period) => period.id === id)?.name ?? id;
  const branchName = (id: string) => data?.scope.branches.find((branch) => branch.id === id)?.name ?? id;
  const selectedEnrollments = selected === null ? [] : (data?.enrollments ?? []).filter((item) => item.class_id === selected.id);
  const selectedWaitlist = selected === null ? [] : (data?.waitlist ?? []).filter((item) => item.class_id === selected.id);
  const selectedSessions = selected === null ? [] : (data?.sessions ?? []).filter((item) => item.class_id === selected.id);

  const submitSchedule = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    mutate('/academic/sessions', { class_id: selected.id, ...schedule, room_id: schedule.room_id || undefined, section_id: schedule.section_id || undefined, skill_id: schedule.skill_id || undefined }, 'Session scheduled; the timetable was re-read from the academic authority.');
  };

  const submitAttendance = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!attendance.session_id || !attendance.enrollment_id) return;
    mutate(`/academic/sessions/${encodeURIComponent(attendance.session_id)}/attendance`, { enrollment_id: attendance.enrollment_id, status: attendance.status }, 'Attendance fact appended; corrections create a new fact rather than rewriting history.');
  };

  const submitAttendanceCorrection = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!attendanceCorrection.fact_id || !attendanceCorrection.reason) return;
    mutate(`/academic/attendance/${encodeURIComponent(attendanceCorrection.fact_id)}/correct`, { status: attendanceCorrection.status, reason: attendanceCorrection.reason }, 'Attendance correction appended; the original fact remains historical.');
    setAttendanceCorrection({ fact_id: '', status: 'present', reason: '' });
  };

  const submitAttempt = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!assessment.enrollment_id || !assessment.evidence_ref) return;
    mutate('/academic/attempts', { enrollment_id: assessment.enrollment_id, kind: assessment.kind, evidence_ref: assessment.evidence_ref }, 'Assessment evidence submitted; scoring remains a separate academic action.');
    setAssessment({ ...assessment, evidence_ref: '' });
  };

  const submitScore = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!assessment.attempt_id || assessment.score === '') return;
    mutate(`/academic/attempts/${encodeURIComponent(assessment.attempt_id)}/score`, { score: Number(assessment.score) }, 'Assessment result scored; independent moderation remains required.');
    setAssessment({ ...assessment, attempt_id: '', score: '' });
  };

  const submitProgression = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected || !progression.student_id || !progression.reason) return;
    mutate('/academic/progressions', {
      student_id: progression.student_id,
      class_id: selected.id,
      outcome: progression.outcome,
      reason: progression.reason,
      assessment_result_id: progression.assessment_result_id || undefined,
      basis: progression.basis || undefined,
      repeat_count: progression.repeat_count === '' ? undefined : Number(progression.repeat_count),
    }, 'Progression proposed; independent review and approval remain required.');
    setProgression({ ...progression, reason: '', assessment_result_id: '', basis: '', repeat_count: '' });
  };

  const submitSupersede = (event: FormEvent<HTMLFormElement>, decisionId: string) => {
    event.preventDefault();
    if (!supersede.reason.trim()) return;
    mutate(`/academic/progressions/${encodeURIComponent(decisionId)}/supersede`, supersede, 'Appeal superseded by a distinct approver; the original progression remains historical.');
    setSupersede({ outcome: 'advance', reason: '' });
  };

  const submitGraduation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!graduation.student_id || !graduation.program_version_id || !graduation.basis) return;
    mutate('/academic/graduations', graduation, 'Graduation proposed; independent review and approval remain required.');
    setGraduation({ ...graduation, basis: '' });
  };

  const submitTranscript = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!graduation.student_id || !graduation.program_version_id) return;
    mutate('/academic/transcripts', { student_id: graduation.student_id, program_version_id: graduation.program_version_id }, 'Official transcript issued from the frozen Academic record.');
  };

  const submitEnrollment = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected || !studentId) return;
    mutate('/academic/enrollments', { student_id: studentId, class_id: selected.id, offering_id: selected.offering_id }, 'Seat request recorded; it remains requested until the enrollment approver activates it.');
    setStudentId('');
  };

  const submitClass = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    mutate('/academic/classes', { ...newClass, capacity: Number(newClass.capacity), program_version_level_id: newClass.level_id }, 'Class defined in planned state from an open offering.');
  };

  const submitTeacher = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    mutate('/academic/teacher-assignments', { class_id: selected.id, ...teacher, effective_to: teacher.effective_to || undefined }, 'Teacher assignment recorded as dated academic history.');
  };

  const submitSection = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    mutate('/academic/sections', { class_id: selected.id, name: section.name, capacity: Number(section.capacity) }, 'Section defined in planned state.');
    setSection({ name: '', capacity: '1' });
  };

  if (loading && data === null) return <><AcademicHeader csrfToken={csrfToken} /><main className="workspace"><div className="panel status">Loading authorized academic scope…</div></main></>;
  if (!data) return <><AcademicHeader csrfToken={csrfToken} /><main className="workspace"><div className="alert" role="alert">{error ?? 'No academic workspace projection is available.'}</div></main></>;

  return <>
<AcademicHeader csrfToken={csrfToken} />
    <main className="workspace" aria-labelledby="academic-title">
      <header className="workspace-header"><div><p className="eyebrow">Academic Classes · governed workspace</p><h1 id="academic-title">Classes that tell the whole delivery story.</h1><p className="lede">Offerings, live seat claims, sections, sessions, teachers, attendance and waitlists stay linked to one server authority.</p></div><button className="button secondary" type="button" onClick={load} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh authority'}</button></header>
      {error && <div className="alert" role="alert">{error}</div>}
      {message && <div className="notice" role="status">{message}</div>}
      <div className="source-note academic-authority-note">Last projection: {new Date(data.generated_at).toLocaleString()} · lifecycle, capacity and permitted actions are server-derived · branch scope is fail-closed.</div>

      <section className="summary-grid" aria-label="Academic delivery summary">
        <div className="panel"><span className="metric">{data.classes.length}</span><span className="metric-label">Visible classes</span></div>
        <div className="panel"><span className="metric">{data.classes.reduce((sum, item) => sum + item.claimed_seats, 0)}</span><span className="metric-label">Live seat claims</span></div>
        <div className="panel"><span className="metric">{data.classes.reduce((sum, item) => sum + item.remaining_seats, 0)}</span><span className="metric-label">Remaining seats</span></div>
        <div className="panel"><span className="metric">{data.waitlist.length}</span><span className="metric-label">Open waitlist entries</span></div>
      </section>

      <div className="academic-tabs" role="tablist" aria-label="Academic views">{[['classes', 'Classes'], ['offerings', 'Offerings'], ['timetable', 'Timetable'], ['enrollments', 'Enrollments'], ['waitlist', 'Waitlist'], ['outcomes', 'Outcomes'], ['records', 'Records'], ['setup', 'Setup']].map(([key, label]) => <button key={key} className={`tab-button ${tab === key ? 'active' : ''}`} role="tab" aria-selected={tab === key} type="button" onClick={() => setTab(key)}>{label}</button>)}</div>

      {tab === 'classes' && <section className="academic-layout"><div className="panel academic-list-panel"><div className="section-heading"><div><p className="eyebrow">Delivery registry</p><h2>Classes</h2></div><span className="source-note">{filteredClasses.length} of {data.classes.length}</span></div><div className="filter-row"><label>Branch<select value={branchFilter} onChange={(event) => setBranchFilter(event.target.value)}><option value="all">All authorized branches</option>{data.scope.branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label><label>Lifecycle<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">All states</option>{Array.from(new Set(data.classes.map((item) => item.lifecycle_state))).map((state) => <option key={state} value={state}>{academicHumanize(state)}</option>)}</select></label><label className="grow">Search<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Class, level, period or ID" /></label></div>{filteredClasses.length === 0 ? <p className="empty">No class in the authorized scope matches these filters.</p> : <ul className="academic-class-list">{filteredClasses.map((item) => <li key={item.id} className={item.id === selectedId ? 'selected' : ''}><button type="button" onClick={() => setSelectedId(item.id)}><span><strong>{levelName(item.program_version_level_id)}</strong><small>{branchName(item.branch_id)} · {periodName(item.period_id)}</small></span><span className="class-row-meta"><span className={`status-chip ${item.lifecycle_state}`}>{academicHumanize(item.lifecycle_state)}</span><small>{item.claimed_seats}/{item.capacity} claimed</small></span></button></li>)}</ul>}</div>
        <div className="panel academic-detail-panel">{selected ? <><div className="section-heading"><div><p className="eyebrow">Authoritative class record</p><h2>{levelName(selected.program_version_level_id)}</h2><p className="muted">{branchName(selected.branch_id)} · {periodName(selected.period_id)} · offering {selected.offering_id ?? 'legacy provenance remediation required'}</p></div><span className={`status-chip ${selected.lifecycle_state}`}>{academicHumanize(selected.lifecycle_state)}</span></div><div className="seat-meter"><div><strong>{selected.claimed_seats} / {selected.capacity}</strong><span>live seat claims</span></div><div><strong>{selected.remaining_seats}</strong><span>remaining</span></div><div><strong>{selected.open_waitlist_entries}</strong><span>waiting</span></div></div><div className="action-strip">{selected.allowed_transitions.map((state) => <button key={state} className="button secondary" type="button" disabled={!selected.capabilities.schedule} onClick={() => mutate(`/academic/classes/${encodeURIComponent(selected.id)}/transition`, { to_state: state }, `Class moved to ${academicHumanize(state)}; related state was re-read.`)}>{academicHumanize(state)}</button>)}</div>{!selected.capabilities.schedule && <p className="muted">You can read this class, but Academic Schedule capability is required for delivery changes.</p>}<div className="detail-grid"><div><h3>Teachers</h3>{selected.teachers.length === 0 ? <p className="empty">No teacher assignment. The class cannot activate.</p> : <ul className="fact-list">{selected.teachers.map((item) => <li key={item.id}><strong>{item.teacher_person_id}</strong><span>{item.effective_from} → {item.effective_to ?? 'open'} · {item.lifecycle_state ?? 'legacy'}</span>{item.identity_consistent === false && <small className="error-text">Identity mismatch; read-only remediation evidence.</small>}</li>)}</ul>}<form className="compact-form" onSubmit={submitTeacher}><h4>Assign teacher</h4><select required value={teacher.teacher_person_id} onChange={(event) => setTeacher({ ...teacher, teacher_person_id: event.target.value })}><option value="">Select verified teacher</option>{data.teachers.filter((item) => item.branch_id === selected.branch_id).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><input required type="date" value={teacher.effective_from} onChange={(event) => setTeacher({ ...teacher, effective_from: event.target.value })} /><button className="button" type="submit" disabled={!selected.capabilities.schedule}>Assign</button></form></div><div><h3>Sections</h3>{selected.sections.length === 0 ? <p className="empty">No sections; sessions may run at class level.</p> : <ul className="fact-list">{selected.sections.map((item) => <li key={item.id}><strong>{item.name}</strong><span>{academicHumanize(item.lifecycle_state)} · capacity {item.capacity}</span></li>)}</ul>}<form className="compact-form" onSubmit={submitSection}><h4>Define section</h4><input required value={section.name} onChange={(event) => setSection({ ...section, name: event.target.value })} placeholder="Section name" /><input required min="1" type="number" value={section.capacity} onChange={(event) => setSection({ ...section, capacity: event.target.value })} /><button className="button" type="submit" disabled={!selected.capabilities.schedule}>Define</button></form></div></div></> : <p className="empty">Select a class to inspect its authoritative delivery record.</p>}</div></section>}

      {tab === 'offerings' && <section className="panel"><div className="section-heading"><div><p className="eyebrow">Branch × level × period</p><h2>Offerings</h2></div><span className="source-note">Capacity includes requested, active and frozen claims</span></div>{data.offerings.length === 0 ? <p className="empty">No offering is visible in the current authority scope.</p> : <div className="table-wrap"><table><thead><tr><th>Offering</th><th>Branch / period</th><th>Capacity</th><th>Lifecycle</th><th>Decision</th></tr></thead><tbody>{data.offerings.map((item) => <tr key={item.id}><td><strong>{item.id}</strong><small>{levelName(item.program_version_level_id)}</small></td><td>{branchName(item.branch_id)}<small>{periodName(item.academic_period_id)}</small></td><td>{item.claimed_seats}/{item.capacity}<small>{item.remaining_seats} remaining · {item.classes_count} classes</small></td><td><span className={`status-chip ${item.lifecycle_state}`}>{academicHumanize(item.lifecycle_state)}</span></td><td>{item.lifecycle_state === 'open' && <button className="text-button" type="button" onClick={() => mutate(`/academic/offerings/${item.id}/close`, undefined, 'Offering closed to new decisions.')}>Close</button>}{item.lifecycle_state === 'closed' && <button className="text-button" type="button" onClick={() => mutate(`/academic/offerings/${item.id}/reopen`, undefined, 'Offering reopened after server validation.')}>Reopen</button>}</td></tr>)}</tbody></table></div>}</section>}

      {tab === 'timetable' && <section className="panel"><div className="section-heading"><div><p className="eyebrow">Scheduled delivery</p><h2>Timetable</h2></div><span className="source-note">Room and section overlap is database-guarded</span></div>{selected && selected.capabilities.schedule && <form className="inline-form" onSubmit={submitSchedule}><select required value={selected.id}><option value={selected.id}>{levelName(selected.program_version_level_id)}</option></select><input required type="date" value={schedule.scheduled_on} onChange={(event) => setSchedule({ ...schedule, scheduled_on: event.target.value })} /><input required type="time" value={schedule.starts_at} onChange={(event) => setSchedule({ ...schedule, starts_at: event.target.value })} /><input required type="time" value={schedule.ends_at} onChange={(event) => setSchedule({ ...schedule, ends_at: event.target.value })} /><select value={schedule.room_id} onChange={(event) => setSchedule({ ...schedule, room_id: event.target.value })}><option value="">No room</option>{data.rooms.filter((room) => room.branch_id === selected.branch_id).map((room) => <option key={room.id} value={room.id}>{room.code} · {room.name}</option>)}</select><select value={schedule.section_id} onChange={(event) => setSchedule({ ...schedule, section_id: event.target.value })}><option value="">Class level</option>{selected.sections.filter((item) => item.lifecycle_state === 'open').map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><select value={schedule.skill_id} onChange={(event) => setSchedule({ ...schedule, skill_id: event.target.value })}><option value="">Skill</option>{data.skills.map((skill) => <option key={skill.id} value={skill.id}>{skill.name}</option>)}</select><button className="button" type="submit">Schedule</button></form>}{selected && selectedSessions.length > 0 && selected.capabilities.attendance && <form className="inline-form" onSubmit={submitAttendance}><select required value={attendance.session_id || selectedSessions[0].id} onChange={(event) => setAttendance({ ...attendance, session_id: event.target.value })}>{selectedSessions.map((session) => <option key={session.id} value={session.id}>{session.scheduled_on} · {session.starts_at}</option>)}</select><select required value={attendance.enrollment_id} onChange={(event) => setAttendance({ ...attendance, enrollment_id: event.target.value })}><option value="">Student</option>{selectedEnrollments.filter((item) => item.lifecycle_state === 'active').map((item) => <option key={item.id} value={item.id}>{data.students.find((student) => student.id === item.student_id)?.name ?? item.student_id}</option>)}</select><select value={attendance.status} onChange={(event) => setAttendance({ ...attendance, status: event.target.value })}><option value="present">Present</option><option value="late">Late</option><option value="absent">Absent</option><option value="excused">Excused</option></select><button className="button" type="submit">Record attendance</button></form>}{data.sessions.length === 0 ? <p className="empty">No sessions are scheduled in the authorized scope.</p> : <div className="table-wrap"><table><thead><tr><th>Date</th><th>Class</th><th>Time</th><th>Room</th><th>Section</th></tr></thead><tbody>{data.sessions.map((item) => <tr key={item.id}><td>{item.scheduled_on}</td><td>{levelName(data.classes.find((row) => row.id === item.class_id)?.program_version_level_id ?? null)}</td><td>{item.starts_at}–{item.ends_at}</td><td>{item.room ? `${item.room.code} · ${item.room.name}` : 'Unroomed'}</td><td>{item.section?.name ?? 'Class level'}</td></tr>)}</tbody></table></div>}</section>}

      {tab === 'enrollments' && <section className="panel"><div className="section-heading"><div><p className="eyebrow">Membership authority</p><h2>Enrollments</h2></div><span className="source-note">Finance gates are evaluated by the enrollment command; Finance owns money</span></div>{selected && selected.capabilities.request_enrollment && <form className="inline-form" onSubmit={submitEnrollment}><select required value={studentId} onChange={(event) => setStudentId(event.target.value)}><option value="">Select active student</option>{data.students.filter((student) => student.branch_id === selected.branch_id).map((student) => <option key={student.id} value={student.id}>{student.student_code} · {student.name}</option>)}</select><button className="button" type="submit" disabled={selected.remaining_seats < 1}>Request seat</button>{selected.remaining_seats < 1 && <span className="muted">Class is full; use the Waitlist tab.</span>}</form>}{selectedEnrollments.length === 0 ? <p className="empty">No live seat claims are visible for the selected class.</p> : <div className="table-wrap"><table><thead><tr><th>Student</th><th>State</th><th>Reason</th><th>Decision</th></tr></thead><tbody>{selectedEnrollments.map((item) => <tr key={item.id}><td>{data.students.find((student) => student.id === item.student_id)?.name ?? item.student_id}</td><td><span className={`status-chip ${item.lifecycle_state}`}>{academicHumanize(item.lifecycle_state)}</span></td><td>{item.state_reason ?? '—'}</td><td>{item.lifecycle_state === 'requested' && selected.capabilities.approve_enrollment && <button className="text-button" type="button" onClick={() => mutate(`/academic/enrollments/${item.id}/activate`, undefined, 'Enrollment activated under a fresh Finance gate.')}>Activate</button>}</td></tr>)}</tbody></table></div>}</section>}

      {tab === 'waitlist' && <section className="panel"><div className="section-heading"><div><p className="eyebrow">Ordered demand</p><h2>Waitlist</h2></div><span className="source-note">Waitlist entries never count as seat claims</span></div>{selected && selected.capabilities.request_enrollment && <form className="inline-form" onSubmit={(event) => { event.preventDefault(); if (!selected || !studentId) return; mutate('/academic/waitlist', { student_id: studentId, class_id: selected.id, offering_id: selected.offering_id }, 'Student joined the ordered waitlist.'); setStudentId(''); }}><select required value={studentId} onChange={(event) => setStudentId(event.target.value)}><option value="">Select active student</option>{data.students.filter((student) => student.branch_id === selected.branch_id).map((student) => <option key={student.id} value={student.id}>{student.student_code} · {student.name}</option>)}</select><button className="button" type="submit" disabled={selected.remaining_seats > 0}>Join waitlist</button></form>}{selectedWaitlist.length === 0 ? <p className="empty">No open waitlist entries for the selected class.</p> : <div className="table-wrap"><table><thead><tr><th>Position</th><th>Student</th><th>State</th><th>Decision</th></tr></thead><tbody>{selectedWaitlist.map((item) => <tr key={item.id}><td>{item.position}</td><td>{data.students.find((student) => student.id === item.student_id)?.name ?? item.student_id}</td><td><span className={`status-chip ${item.lifecycle_state}`}>{academicHumanize(item.lifecycle_state)}</span></td><td>{item.lifecycle_state === 'waiting' && selected.capabilities.approve_enrollment && <button className="text-button" type="button" onClick={() => mutate(`/academic/waitlist/${item.id}/offer`, undefined, 'Waitlist offer recorded.')}>Offer</button>}{item.lifecycle_state === 'offered' && selected.capabilities.approve_enrollment && <button className="text-button" type="button" onClick={() => mutate(`/academic/waitlist/${item.id}/promote`, undefined, 'Offer promoted to a requested enrollment; approval remains explicit.')}>Promote</button>}</td></tr>)}</tbody></table></div>}</section>}

      {tab === 'outcomes' && <section className="academic-layout"><div className="panel"><div className="section-heading"><div><p className="eyebrow">Append-only evidence</p><h2>Attendance and assessment</h2></div><span className="source-note">Facts stay with Academic commands; permitted actions are capability-gated</span></div>{selectedSessions.length === 0 ? <p className="empty">Select a class with scheduled sessions to inspect delivery evidence.</p> : selectedSessions.map((session) => <div key={session.id}><h3>{session.scheduled_on} · {session.starts_at}–{session.ends_at}</h3>{data.attendance.filter((fact) => fact.session_id === session.id).length === 0 ? <p className="empty">No attendance fact is visible.</p> : <ul className="fact-list">{data.attendance.filter((fact) => fact.session_id === session.id).map((fact) => <li key={fact.id}><strong>{data.enrollments.find((item) => item.id === fact.enrollment_id)?.student_id ?? fact.enrollment_id} · {academicHumanize(fact.status)}</strong><span>{fact.corrects_id ? `Correction of ${fact.corrects_id}` : 'Original fact'}{fact.reason ? ` · ${fact.reason}` : ''}</span>{selected?.capabilities.attendance && <>{attendanceCorrection.fact_id === fact.id ? <form className="inline-form" onSubmit={submitAttendanceCorrection}><select value={attendanceCorrection.status} onChange={(event) => setAttendanceCorrection({ ...attendanceCorrection, status: event.target.value })}><option value="present">Present</option><option value="late">Late</option><option value="absent">Absent</option><option value="excused">Excused</option></select><input required value={attendanceCorrection.reason} onChange={(event) => setAttendanceCorrection({ ...attendanceCorrection, reason: event.target.value })} placeholder="Correction reason" /><button className="text-button" type="submit">Append correction</button></form> : <button className="text-button" type="button" onClick={() => setAttendanceCorrection({ fact_id: fact.id, status: fact.status, reason: '' })}>Correct</button>}</>}</li>)}</ul>}</div>)}</div><div className="panel"><div className="section-heading"><div><p className="eyebrow">Assessment authority</p><h2>Results and progression</h2></div></div>{selected?.capabilities.assess && selectedEnrollments.length > 0 && <form className="compact-form" onSubmit={submitAttempt}><h4>Submit assessment evidence</h4><select required value={assessment.enrollment_id} onChange={(event) => setAssessment({ ...assessment, enrollment_id: event.target.value })}><option value="">Select active enrollment</option>{selectedEnrollments.filter((item) => item.lifecycle_state === 'active').map((item) => <option key={item.id} value={item.id}>{data.students.find((student) => student.id === item.student_id)?.name ?? item.student_id}</option>)}</select><select value={assessment.kind} onChange={(event) => setAssessment({ ...assessment, kind: event.target.value })}><option value="assessment">Assessment</option><option value="placement">Placement</option></select><input required value={assessment.evidence_ref} onChange={(event) => setAssessment({ ...assessment, evidence_ref: event.target.value })} placeholder="Evidence reference" /><button className="button" type="submit">Submit evidence</button></form>}{selected?.capabilities.assess && data.attempts.filter((attempt) => selectedEnrollments.some((enrollment) => enrollment.id === attempt.enrollment_id) && attempt.lifecycle_state === 'submitted').length > 0 && <form className="compact-form" onSubmit={submitScore}><h4>Score submitted attempt</h4><select required value={assessment.attempt_id} onChange={(event) => setAssessment({ ...assessment, attempt_id: event.target.value })}><option value="">Select submitted attempt</option>{data.attempts.filter((attempt) => selectedEnrollments.some((enrollment) => enrollment.id === attempt.enrollment_id) && attempt.lifecycle_state === 'submitted').map((attempt) => <option key={attempt.id} value={attempt.id}>{attempt.kind} · {attempt.evidence_ref}</option>)}</select><input required min="0" step="any" type="number" value={assessment.score} onChange={(event) => setAssessment({ ...assessment, score: event.target.value })} placeholder="Score" /><button className="button" type="submit">Score</button></form>}{data.results.filter((result) => data.attempts.some((attempt) => attempt.id === result.attempt_id && selectedEnrollments.some((enrollment) => enrollment.id === attempt.enrollment_id))).length === 0 && data.progressions.filter((item) => item.class_id === selected?.id).length === 0 ? <p className="empty">No assessment result or progression decision is visible for this class.</p> : <><ul className="fact-list">{data.results.filter((result) => data.attempts.some((attempt) => attempt.id === result.attempt_id && selectedEnrollments.some((enrollment) => enrollment.id === attempt.enrollment_id))).map((result) => <li key={result.id}><strong>{result.score} · {academicHumanize(result.lifecycle_state)}</strong><span>Assessment result {result.id}</span><span className="action-strip">{result.lifecycle_state === 'scored' && selected?.capabilities.moderate_assessment && <button className="text-button" type="button" onClick={() => mutate(`/academic/results/${result.id}/moderate`, undefined, 'Result moderated; independent approval remains required.')}>Moderate</button>}{result.lifecycle_state === 'moderated' && selected?.capabilities.approve_assessment && <button className="text-button" type="button" onClick={() => mutate(`/academic/results/${result.id}/approve`, undefined, 'Result approved; release remains a separate action.')}>Approve</button>}{result.lifecycle_state === 'approved' && selected?.capabilities.release_assessment && <button className="text-button" type="button" onClick={() => mutate(`/academic/results/${result.id}/release`, undefined, 'Result released to the academic record.')}>Release</button>}{result.lifecycle_state === 'released' && selected?.capabilities.moderate_assessment && <button className="text-button" type="button" onClick={() => mutate(`/academic/results/${result.id}/mark-appealed`, undefined, 'Result marked appealed; correction remains a separate approval chain.')}>Appeal</button>}</span></li>)}</ul>{selected?.capabilities.propose_progression && selectedEnrollments.length > 0 && <form className="compact-form" onSubmit={submitProgression}><h4>Propose progression</h4><select required value={progression.student_id} onChange={(event) => setProgression({ ...progression, student_id: event.target.value })}><option value="">Select active student</option>{selectedEnrollments.filter((item) => item.lifecycle_state === 'active').map((item) => <option key={item.student_id} value={item.student_id}>{data.students.find((student) => student.id === item.student_id)?.name ?? item.student_id}</option>)}</select><select value={progression.outcome} onChange={(event) => setProgression({ ...progression, outcome: event.target.value })}><option value="advance">Advance</option><option value="repeat">Repeat</option></select><textarea required value={progression.reason} onChange={(event) => setProgression({ ...progression, reason: event.target.value })} placeholder="Reason" /><input value={progression.assessment_result_id} onChange={(event) => setProgression({ ...progression, assessment_result_id: event.target.value })} placeholder="Assessment result ID (optional)" /><input value={progression.basis} onChange={(event) => setProgression({ ...progression, basis: event.target.value })} placeholder="Basis (optional)" /><button className="button" type="submit">Propose progression</button></form>}{data.progressions.filter((item) => item.class_id === selected?.id).map((item) => <div className="workflow-item" key={item.id}><strong>{academicHumanize(item.outcome)} · {academicHumanize(item.lifecycle_state)}</strong><br />{item.reason}<span className="action-strip">{item.lifecycle_state === 'proposed' && selected?.capabilities.review_progression && <button className="text-button" type="button" onClick={() => mutate(`/academic/progressions/${item.id}/review`, undefined, 'Progression reviewed; independent approval remains required.')}>Review</button>}{item.lifecycle_state === 'reviewed' && selected?.capabilities.approve_progression && <button className="text-button" type="button" onClick={() => mutate(`/academic/progressions/${item.id}/approve`, undefined, 'Progression approved and recorded in academic history.')}>Approve</button>}{(item.lifecycle_state === 'approved' || item.lifecycle_state === 'rejected') && selected?.capabilities.review_progression && <button className="text-button" type="button" onClick={() => mutate(`/academic/progressions/${item.id}/mark-appealed`, undefined, 'Progression marked appealed; resolution requires distinct signers.')}>Appeal</button>}{item.lifecycle_state === 'appealed' && selected?.capabilities.approve_progression && <form className="inline-form" onSubmit={(event) => submitSupersede(event, item.id)}><select value={supersede.outcome} onChange={(event) => setSupersede({ ...supersede, outcome: event.target.value })}><option value="advance">Advance</option><option value="repeat">Repeat</option></select><input required value={supersede.reason} onChange={(event) => setSupersede({ ...supersede, reason: event.target.value })} placeholder="Appeal resolution reason" /><button className="text-button" type="submit">Supersede</button></form>}</span></div>)}</>}</div></section>}

      {tab === 'records' && <section className="academic-layout"><div className="panel"><div className="section-heading"><div><p className="eyebrow">Completion authority</p><h2>Graduation and official records</h2></div><span className="source-note">Lifecycle and signer identity come from Academic commands</span></div>{(data.capabilities.actions.propose_graduation || data.capabilities.actions.issue_transcript) && <form className="compact-form" onSubmit={submitGraduation}><h4>Start a completion record</h4><select required value={graduation.student_id} onChange={(event) => setGraduation({ ...graduation, student_id: event.target.value })}><option value="">Student</option>{data.students.map((student) => <option key={student.id} value={student.id}>{student.student_code} · {student.name}</option>)}</select><select required value={graduation.program_version_id} onChange={(event) => setGraduation({ ...graduation, program_version_id: event.target.value })}><option value="">Program version</option>{data.program_versions.map((version) => <option key={version.id} value={version.id}>{version.program_name} · v{version.version_no}</option>)}</select>{data.capabilities.actions.propose_graduation && <><select value={graduation.outcome} onChange={(event) => setGraduation({ ...graduation, outcome: event.target.value })}><option value="eligible">Eligible</option><option value="not_eligible">Not eligible</option></select><textarea required value={graduation.basis} onChange={(event) => setGraduation({ ...graduation, basis: event.target.value })} placeholder="Requirements basis" /><button className="button" type="submit">Propose graduation</button></>}{data.capabilities.actions.issue_transcript && <button className="button secondary" type="button" onClick={() => submitTranscript({ preventDefault: () => undefined } as FormEvent<HTMLFormElement>)}>Issue transcript</button>}</form>}{data.graduations.length === 0 ? <p className="empty">No graduation decisions are visible in the authorized scope.</p> : <ul className="fact-list">{data.graduations.map((item) => <li key={item.id}><strong>{academicHumanize(item.outcome)} · {academicHumanize(item.lifecycle_state)}</strong><span>{item.student_id} · {item.basis}</span><span className="action-strip">{item.lifecycle_state === 'proposed' && data.capabilities.actions.review_graduation && <button className="text-button" type="button" onClick={() => mutate(`/academic/graduations/${item.id}/review`, undefined, 'Graduation reviewed; independent approval remains required.')}>Review</button>}{item.lifecycle_state === 'reviewed' && data.capabilities.actions.approve_graduation && <><button className="text-button" type="button" onClick={() => mutate(`/academic/graduations/${item.id}/approve`, undefined, 'Graduation approved after independent review.')}>Approve</button><button className="text-button" type="button" onClick={() => mutate(`/academic/graduations/${item.id}/reject`, undefined, 'Graduation rejected and retained as history.')}>Reject</button></>}{item.lifecycle_state === 'approved' && item.outcome === 'eligible' && data.capabilities.actions.issue_certificate && <button className="text-button" type="button" onClick={() => mutate(`/academic/graduations/${item.id}/certificate`, undefined, 'Certificate issued with its immutable serial.')}>Issue certificate</button>}</span></li>)}</ul>}<h3>Issued transcripts</h3>{data.transcripts.length === 0 ? <p className="empty">No transcript has been issued in the authorized scope.</p> : <ul className="fact-list">{data.transcripts.map((item) => <li key={item.id}><strong>{item.student_id} · {item.issued_at ?? 'issued'}</strong><span>Frozen content hash {item.content_hash}</span></li>)}</ul>}</div><div className="panel"><div className="section-heading"><div><p className="eyebrow">Independent review</p><h2>Appeals</h2></div><span className="source-note">Redress remains on the contested subject authority</span></div>{data.appeals.length === 0 ? <p className="empty">No appeals are visible in the authorized scope.</p> : <ul className="fact-list">{data.appeals.map((item) => <li key={item.id}><strong>{academicHumanize(item.lifecycle_state)} · {academicHumanize(item.subject_type)}</strong><span>{item.reason}</span><span className="action-strip">{item.lifecycle_state === 'assigned' && data.capabilities.actions.manage_appeal && <button className="text-button" type="button" onClick={() => mutate(`/academic/appeals/${item.id}/investigate`, undefined, 'Appeal investigation opened for the assigned reviewer.')}>Investigate</button>}{item.lifecycle_state === 'investigating' && data.capabilities.actions.manage_appeal && <button className="text-button" type="button" onClick={() => mutate(`/academic/appeals/${item.id}/escalate`, undefined, 'Appeal escalated for independent reassignment.')}>Escalate</button>}</span></li>)}</ul>}</div></section>}

      {tab === 'setup' && <section className="academic-layout"><div className="panel"><div className="section-heading"><div><p className="eyebrow">Class definition</p><h2>Define from an offering</h2></div></div>{!data.capabilities.actions.define_class && <p className="muted">Class definition is unavailable in your authorized branch scope.</p>}<form className="compact-form" onSubmit={submitClass}><select required value={newClass.program_version_id} onChange={(event) => setNewClass({ ...newClass, program_version_id: event.target.value, level_id: '' })}><option value="">Program version</option>{data.program_versions.map((item) => <option key={item.id} value={item.id}>{item.program_name} · v{item.version_no}</option>)}</select><select required value={newClass.level_id} onChange={(event) => setNewClass({ ...newClass, level_id: event.target.value })}><option value="">Program level</option>{data.levels.filter((item) => item.program_version_id === newClass.program_version_id).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select><select required value={newClass.period_id} onChange={(event) => setNewClass({ ...newClass, period_id: event.target.value })}><option value="">Published period</option>{data.periods.filter((item) => item.lifecycle_state === 'published').map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><select required value={newClass.branch_id} onChange={(event) => setNewClass({ ...newClass, branch_id: event.target.value, offering_id: '' })}><option value="">Authorized branch</option>{data.scope.branches.filter((item) => data.capabilities.branch_ids.schedule?.includes(item.id)).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><select required value={newClass.offering_id} onChange={(event) => setNewClass({ ...newClass, offering_id: event.target.value })}><option value="">Open offering</option>{data.offerings.filter((item) => item.branch_id === newClass.branch_id && item.academic_period_id === newClass.period_id && item.program_version_level_id === newClass.level_id && item.lifecycle_state === 'open').map((item) => <option key={item.id} value={item.id}>{item.id} · {item.remaining_seats} remaining</option>)}</select><input required min="1" type="number" value={newClass.capacity} onChange={(event) => setNewClass({ ...newClass, capacity: event.target.value })} /><button className="button" type="submit" disabled={!data.capabilities.actions.define_class}>Define planned class</button></form></div><div className="panel"><div className="section-heading"><div><p className="eyebrow">Validation state</p><h2>Authority rules</h2></div></div><ul className="rule-list"><li>New classes require an open offering with the same branch, level and published period.</li><li>Requested, active and frozen enrollments all claim finite capacity; waitlist entries do not.</li><li>Activation requires a teacher, an active class, a fresh Finance gate and available capacity.</li><li>Session dates must be inside the period; room and section overlaps are database guarded.</li><li>Every command re-reads and locks its authoritative record; actions reload this projection after success.</li></ul></div></section>}
    </main>
  </>;
}
