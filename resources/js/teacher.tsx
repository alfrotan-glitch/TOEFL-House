import { FormEvent, useEffect, useState } from 'react';

type TeacherApi = {
  getJson: <T>(path: string) => Promise<T>;
  postJson: <T>(path: string, body?: Record<string, unknown>) => Promise<T>;
};
type Qualification = { id: string; type: string; title: string; issuer: string; state: string; valid_from: string | null; valid_to: string | null; evidence_ref: string };
type Assignment = { id: string; class_id: string; teacher_person_id: string; branch_id: string | null; campus_id: string | null; organization_id: string | null; identity_consistent: boolean; lifecycle_state: string | null; effective_from: string; effective_to: string | null; assigned_by: string | null; skills: Array<{ id: string; skill_id: string }> };
type Profile = {
  id: string; person_id: string; legal_name: string; employment_id: string; employment_state: string; effective_state: string;
  lifecycle_state: string; allowed_transitions: string[]; professional_title: string; profile_summary: string | null;
  originating_branch_id: string; current_home_branch_id: string;
  qualifications: Qualification[];
  branch_authorizations: Array<{ id: string; branch_id: string; state: string; effective_from: string; effective_to: string | null }>;
  skill_authorities: Array<{ id: string; skill_id: string; branch_id: string; kind: string; state: string; effective_from: string; effective_to: string | null; evidence_ref: string }>;
  availability: Array<{ id: string; branch_id: string; weekday: number; starts_at: string; ends_at: string; effective_from: string; effective_to: string | null; state: string }>;
  workload_limits: Array<{ id: string; branch_id: string; max_hours_per_week: string; effective_from: string; effective_to: string | null; state: string; evidence_ref: string }>;
  assignments: Assignment[];
};
type TeacherWorkspace = {
  viewer: { person_id: string; teacher_profile_id: string | null };
  capabilities: { manage: boolean; approve: boolean; is_teacher: boolean };
  profiles: Profile[];
};

function TeacherApp({ getJson, postJson }: TeacherApi) {
  const [workspace, setWorkspace] = useState<TeacherWorkspace | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [qualification, setQualification] = useState({ qualification_type: '', title: '', issuer: '', evidence_ref: '' });
  const [assignmentSkill, setAssignmentSkill] = useState<{ assignmentId: string; skillId: string } | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    void getJson<{ data: TeacherWorkspace }>('/teachers/workspace')
      .then((response) => {
        setWorkspace(response.data);
        setSelectedId((current) => current ?? response.data.viewer.teacher_profile_id ?? response.data.profiles[0]?.id ?? null);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'The Teacher workspace could not be loaded.'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const selected = workspace?.profiles.find((profile) => profile.id === selectedId) ?? null;

  const action = (path: string, body: Record<string, unknown>, success: string) => {
    setSaving(true);
    setError(null);
    setMessage(null);
    void postJson(path, body)
      .then(() => { setMessage(success); load(); })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'The Teacher authority operation was rejected.'))
      .finally(() => setSaving(false));
  };

  const transition = (toState: string) => {
    if (!selected || reason.trim() === '') return;
    action(`/teachers/profiles/${encodeURIComponent(selected.id)}/transition`, { to_state: toState, reason }, `Teacher profile moved to ${toState} by the canonical command.`);
  };

  const addQualification = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected || Object.values(qualification).some((value) => value.trim() === '')) return;
    action(`/teachers/profiles/${encodeURIComponent(selected.id)}/qualifications`, qualification, 'Qualification evidence recorded as pending independent verification.');
    setQualification({ qualification_type: '', title: '', issuer: '', evidence_ref: '' });
  };

  const attributeSkill = (assignmentId: string) => {
    if (assignmentSkill === null || assignmentSkill.assignmentId !== assignmentId || assignmentSkill.skillId.trim() === '') return;
    action(`/teachers/assignments/${encodeURIComponent(assignmentId)}/skills`, { skill_id: assignmentSkill.skillId.trim() }, 'Assignment skill attribution submitted to Teacher authority.');
    setAssignmentSkill(null);
  };

  if (loading) return <main className="workspace"><section className="panel"><p className="muted">Resolving teacher capability, employment, provenance, and assignment facts…</p></section></main>;

  return <>
    <header className="topbar"><div><p className="eyebrow">Canonical Teacher domain</p><h1>Teacher & Faculty workspace</h1><p className="muted">Assignments and capabilities are effective-dated server facts. Identity, position, employment, and browser state do not grant teaching authority.</p></div><span className="source-note">React projection · domain commands own writes</span></header>
    <main className="workspace">
      {error && <div className="error-banner" role="alert">{error}</div>}
      {message && <div className="success-banner" role="status">{message}</div>}
      <section className="metric-grid">
        <div className="panel"><span className="metric">{workspace?.profiles.length ?? 0}</span><span className="metric-label">Visible teacher profiles</span></div>
        <div className="panel"><span className="metric">{workspace?.profiles.reduce((count, profile) => count + profile.assignments.length, 0) ?? 0}</span><span className="metric-label">Effective and historical assignments</span></div>
        <div className="panel"><span className="metric">{workspace?.capabilities.approve ? 'Yes' : 'No'}</span><span className="metric-label">Independent approval authority</span></div>
      </section>
      <div className="workspace-columns">
        <section className="panel" aria-labelledby="teacher-directory-heading">
          <div className="section-heading"><div><p className="eyebrow">Server-derived directory</p><h2 id="teacher-directory-heading">Faculty profiles</h2></div><span className="source-note">Branch-scoped</span></div>
          {workspace?.profiles.length === 0 ? <p className="empty">No teacher profile is visible in your effective scope.</p> : <ul className="work-list">{workspace?.profiles.map((profile) => <li key={profile.id} className={profile.id === selectedId ? 'selected-row' : ''}><button className="text-button" type="button" onClick={() => setSelectedId(profile.id)}><strong>{profile.legal_name || profile.person_id}</strong><small>{profile.professional_title} · {profile.lifecycle_state} · employment {profile.employment_state}</small></button><span className={`status-chip ${profile.lifecycle_state}`}>{profile.assignments.length} assignments</span></li>)}</ul>}
        </section>
        {selected && <section className="panel" aria-labelledby="teacher-detail-heading">
          <div className="section-heading"><div><p className="eyebrow">Capability record</p><h2 id="teacher-detail-heading">{selected.legal_name}</h2><p className="muted">{selected.professional_title} · profile {selected.id}</p></div><span className={`status-chip ${selected.effective_state}`}>{selected.effective_state}</span></div>
          <dl className="detail-list"><div><dt>Identity</dt><dd>{selected.person_id}</dd></div><div><dt>Employment</dt><dd>{selected.employment_id} · {selected.employment_state}</dd></div><div><dt>Origin branch</dt><dd>{selected.originating_branch_id}</dd></div><div><dt>Current branch</dt><dd>{selected.current_home_branch_id}</dd></div></dl>
          {workspace?.capabilities.approve && selected.allowed_transitions.length > 0 && <div className="action-row"><input aria-label="Transition reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason required for transition" />{selected.allowed_transitions.includes('active') && <button className="button" disabled={saving || reason.trim() === ''} type="button" onClick={() => transition('active')}>Activate</button>}{selected.allowed_transitions.includes('suspended') && <button className="button secondary" disabled={saving || reason.trim() === ''} type="button" onClick={() => transition('suspended')}>Suspend</button>}{selected.allowed_transitions.includes('retired') && <button className="button secondary" disabled={saving || reason.trim() === ''} type="button" onClick={() => transition('retired')}>Retire</button>}</div>}
          <div className="section-heading"><h3>Qualifications</h3><span className="source-note">Verified independently</span></div>
          <ul className="compact-list">{selected.qualifications.map((item) => <li key={item.id}><span><strong>{item.title}</strong><small>{item.type} · {item.issuer} · valid {item.valid_from ?? 'open'} to {item.valid_to ?? 'open'} · evidence {item.evidence_ref}</small></span>{item.state === 'pending' && workspace?.capabilities.approve && <button className="text-button" type="button" onClick={() => action(`/teachers/qualifications/${encodeURIComponent(item.id)}/verify`, {}, 'Qualification independently verified.')}>Verify</button>}<span className={`status-chip ${item.state}`}>{item.state}</span></li>)}</ul>
          {workspace?.capabilities.manage && <form className="inline-form" onSubmit={addQualification}><h3>Add qualification evidence</h3><input required placeholder="Qualification type" value={qualification.qualification_type} onChange={(event) => setQualification({ ...qualification, qualification_type: event.target.value })} /><input required placeholder="Title" value={qualification.title} onChange={(event) => setQualification({ ...qualification, title: event.target.value })} /><input required placeholder="Issuer" value={qualification.issuer} onChange={(event) => setQualification({ ...qualification, issuer: event.target.value })} /><input required placeholder="Evidence reference" value={qualification.evidence_ref} onChange={(event) => setQualification({ ...qualification, evidence_ref: event.target.value })} /><button className="button" disabled={saving} type="submit">Record evidence</button></form>}
          <div className="section-heading"><h3>Subject authority</h3><span className="source-note">Qualification and skill authority are separate from assignment</span></div>
          <ul className="compact-list">{selected.skill_authorities.map((authority) => <li key={authority.id}><span><strong>{authority.skill_id}</strong><small>{authority.branch_id} · {authority.kind} · {authority.effective_from} to {authority.effective_to ?? 'open'} · {authority.evidence_ref}</small></span><span className={`status-chip ${authority.state}`}>{authority.state}</span></li>)}</ul>
          <div className="section-heading"><h3>Branch provenance and availability</h3></div>
          <ul className="compact-list">{selected.branch_authorizations.map((item) => <li key={item.id}><span><strong>{item.branch_id}</strong><small>{item.effective_from} to {item.effective_to ?? 'open'}</small></span><span className={`status-chip ${item.state}`}>{item.state}</span></li>)}</ul>
          <ul className="compact-list">{selected.availability.map((item) => <li key={item.id}><span><strong>Day {item.weekday} · {item.starts_at}–{item.ends_at}</strong><small>{item.branch_id} · {item.effective_from} to {item.effective_to ?? 'open'}</small></span><span className={`status-chip ${item.state}`}>{item.state}</span></li>)}</ul>
          <ul className="compact-list">{selected.workload_limits.map((item) => <li key={item.id}><span><strong>{item.max_hours_per_week} hours per week</strong><small>{item.branch_id} · {item.effective_from} to {item.effective_to ?? 'open'} · {item.evidence_ref}</small></span><span className={`status-chip ${item.state}`}>{item.state}</span></li>)}</ul>
          <div className="section-heading"><h3>Assignment history</h3><span className="source-note">Academic class owner remains authoritative</span></div>
          <ul className="compact-list">{selected.assignments.map((item) => <li key={item.id}><span><strong>Class {item.class_id}</strong><small>{item.branch_id ?? 'legacy provenance pending'} · {item.effective_from} to {item.effective_to ?? 'open'} · skills {item.skills.map((skill) => skill.skill_id).join(', ') || 'none'}</small>{!item.identity_consistent && <small className="error-text">Identity mismatch: this legacy relationship is read-only remediation evidence.</small>}{workspace?.capabilities.manage && item.identity_consistent && item.branch_id !== null && item.lifecycle_state !== 'ended' && item.lifecycle_state !== 'cancelled' && <span className="inline-form"><input aria-label={`Skill for assignment ${item.id}`} placeholder="Skill ID" value={assignmentSkill?.assignmentId === item.id ? assignmentSkill.skillId : ''} onChange={(event) => setAssignmentSkill({ assignmentId: item.id, skillId: event.target.value })} /><button className="text-button" type="button" disabled={saving || assignmentSkill?.assignmentId !== item.id || assignmentSkill.skillId.trim() === ''} onClick={() => attributeSkill(item.id)}>Attribute</button></span>}</span><span className={`status-chip ${item.lifecycle_state ?? 'legacy'}`}>{item.lifecycle_state ?? 'legacy'}</span></li>)}</ul>
        </section>}
      </div>
    </main>
  </>;
}

export { TeacherApp };
