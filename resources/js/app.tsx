import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './app.css';
import { AcademicApp } from './academic';
import { TeacherApp } from './teacher';

type ApiEnvelope<T> = { data: T };
type Me = { username: string; person_id: string; display_name: string };
type Position = { id: string; position_id: string; position_name: string; effective_from: string; effective_to: string | null };
type WorkItem = {
  id?: string;
  organization_id?: string | null;
  branch_id?: string | null;
  kind: string;
  source_type: string;
  source_id: string;
  title: string;
  status: string;
  due_at: string | null;
  route: string;
  reason?: string | null;
};
type NotificationItem = {
  id: string;
  source_type: string;
  source_id: string;
  title: string;
  body_ref: string | null;
  severity: string;
  status: string;
  read_at: string | null;
  created_at: string | null;
};
type EmployeeWorkspace = {
  actor: { id: string; display_name: string };
  positions: Position[];
  scope: { organization_ids: string[]; branch_ids: string[]; scope_known: boolean };
  work: { items: WorkItem[]; count: number };
  notifications: { status: string; unread_count: number; items: NotificationItem[] };
  generated_at: string;
};
type ManagementWorkspace = {
  scope: { type: string; organization_ids: string[]; branch_ids: string[] };
  counts: Record<string, number>;
  operational_health: Record<string, number | string>;
  latest_reports: Array<{ id: string; period_key: string; result: string; created_at: string | null }>;
};
type SearchResult = {
  type: string;
  id: string;
  label: string;
  secondary: string;
  status?: string;
  route: string;
};
type SearchResponse = { term: string; results: SearchResult[]; scope: { branch_ids: string[]; scope_known: boolean } };

const root = document.getElementById('react-console');
const apiBase = root?.getAttribute('data-api-base') ?? '/api/v1';
const csrfToken = root?.getAttribute('data-csrf-token') ?? '';

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `Request failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function postJson<T>(path: string, body?: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      'X-CSRF-TOKEN': csrfToken,
      'X-Requested-With': 'XMLHttpRequest',
      'Idempotency-Key': idempotencyKey ?? `${path.replaceAll('/', '.')}-${crypto.randomUUID()}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `Request failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function humanize(key: string): string {
  return key.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

type CrmVisitor = {
  id: string;
  visitor_code: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  preferred_channel: string;
  visitor_type: string;
  status: string;
  available_transitions: string[];
  rating: string | null;
  interest: string | null;
  notes: string | null;
  person_id: string | null;
  assigned_to: string | null;
  origin_branch_id: string | null;
  origin_branch?: { id: string; name: string } | null;
  source?: { name: string } | null;
  campaign?: { name: string } | null;
};
type CrmTimelineItem = { kind: string; id: string; at: string; direction?: string; type?: string; outcome?: string; summary?: string; scheduled_for?: string; title?: string; status?: string; assigned_to?: string; completed_by?: string | null; completed_at?: string | null };
type CrmTimelineResponse = { timeline: CrmTimelineItem[] };
type CrmCatalogItem = { id: string; key: string; name: string; category?: string | null; channel?: string | null; source_id?: string | null };
type CrmBranch = { id: string; name: string; lifecycle_state: string };
type CrmBranchesResponse = { branches: CrmBranch[]; allow_unassigned: boolean };

type CrmFormState = {
  full_name: string;
  phone: string;
  email: string;
  preferred_channel: string;
  visitor_type: string;
  origin_branch_id: string;
  source_id: string;
  campaign_id: string;
  interest: string;
  notes: string;
};

const emptyCrmForm: CrmFormState = {
  full_name: '', phone: '', email: '', preferred_channel: 'phone', visitor_type: 'walk_in', origin_branch_id: '',
  source_id: '', campaign_id: '', interest: '', notes: '',
};
const interactionTypes = ['call', 'whatsapp', 'email', 'sms', 'visit', 'meeting', 'form_submission', 'document', 'note', 'other', 'payment', 'assessment', 'placement'];
const interactionOutcomes = ['no_answer', 'connected', 'positive', 'neutral', 'negative', 'unreachable', 'requested_info', 'scheduled_visit', 'followup_required', 'not_interested', 'qualified', 'converted', 'other'];

function CrmApp() {
  const [visitors, setVisitors] = useState<CrmVisitor[]>([]);
  const [sources, setSources] = useState<CrmCatalogItem[]>([]);
  const [campaigns, setCampaigns] = useState<CrmCatalogItem[]>([]);
  const [branches, setBranches] = useState<CrmBranch[]>([]);
  const [allowUnassigned, setAllowUnassigned] = useState(false);
  const [branchesLoaded, setBranchesLoaded] = useState(false);
  const [selected, setSelected] = useState<CrmVisitor | null>(null);
  const [timeline, setTimeline] = useState<CrmTimelineItem[]>([]);
  const [form, setForm] = useState<CrmFormState>(emptyCrmForm);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [interaction, setInteraction] = useState({ direction: 'outbound', type: 'call', outcome: 'connected', summary: '' });
  const [followup, setFollowup] = useState({ assigned_to: '', scheduled_for: '', title: '', notes: '' });
  const [personId, setPersonId] = useState('');
  const [transitionReason, setTransitionReason] = useState('');
  const requestKeys = useRef(new Map<string, string>());
  const requestKey = (slot: string): string => {
    const existing = requestKeys.current.get(slot);
    if (existing !== undefined) return existing;
    const created = `crm-${crypto.randomUUID()}`;
    requestKeys.current.set(slot, created);
    return created;
  };
  const clearRequestKey = (slot: string): void => { requestKeys.current.delete(slot); };

  const loadVisitors = () => {
    setLoading(true);
    setError(null);
    void getJson<{ visitors: CrmVisitor[] }>('/crm/visitors?limit=200')
      .then((response) => setVisitors(response.visitors))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'The CRM directory could not be loaded.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadVisitors();
    void getJson<{ sources: CrmCatalogItem[] }>('/crm/sources').then((response) => setSources(response.sources)).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'CRM sources could not be loaded.'));
    void getJson<{ campaigns: CrmCatalogItem[] }>('/crm/campaigns').then((response) => setCampaigns(response.campaigns)).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'CRM campaigns could not be loaded.'));
    void getJson<CrmBranchesResponse>('/crm/branches').then((response) => { setBranches(response.branches); setAllowUnassigned(response.allow_unassigned === true); }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Authorized CRM branches could not be loaded.')).finally(() => setBranchesLoaded(true));
  }, []);

  const openVisitor = (visitor: CrmVisitor) => {
    setSelected(visitor);
    setPersonId(visitor.person_id ?? '');
    setTransitionReason('');
    setFollowup((current) => ({ ...current, assigned_to: visitor.assigned_to ?? current.assigned_to }));
    setError(null);
    void getJson<CrmTimelineResponse>(`/crm/visitors/${encodeURIComponent(visitor.id)}/timeline`)
      .then((response) => setTimeline(response.timeline))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'The visitor timeline could not be loaded.'));
  };

  const capture = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setMessage(null);
    const body = { ...form, origin_branch_id: form.origin_branch_id || undefined, source_id: form.source_id || undefined, campaign_id: form.campaign_id || undefined };
    const requestSlot = `capture-${JSON.stringify(body)}`;
    void postJson('/crm/visitors', body, requestKey(requestSlot))
      .then(() => {
        clearRequestKey(requestSlot);
        setForm(emptyCrmForm);
        setMessage('Visitor captured in the CRM source of truth.');
        loadVisitors();
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'The visitor could not be captured.'))
      .finally(() => setSaving(false));
  };

  const linkPerson = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selected === null || personId.trim() === '') return;
    setSaving(true);
    setError(null);
    const requestSlot = `link-person-${selected.id}-${personId.trim()}`;
    void postJson(`/crm/visitors/${encodeURIComponent(selected.id)}/link-person`, { person_id: personId.trim() }, requestKey(requestSlot))
      .then(() => {
        clearRequestKey(requestSlot);
        setVisitors((current) => current.map((item) => item.id === selected.id ? { ...item, person_id: personId.trim() } : item));
        setSelected((current) => current?.id === selected.id ? { ...current, person_id: personId.trim() } : current);
        setMessage('Visitor linked to the verified identity.');
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'The visitor identity could not be linked.'))
      .finally(() => setSaving(false));
  };

  const transition = (visitor: CrmVisitor, status: string) => {
    setSaving(true);
    setError(null);
    const requestSlot = `transition-${visitor.id}-${status}-${transitionReason.trim()}`;
    void postJson(`/crm/visitors/${encodeURIComponent(visitor.id)}/transition`, { status, reason: transitionReason.trim() || undefined }, requestKey(requestSlot))
      .then(() => getJson<{ visitor: CrmVisitor }>(`/crm/visitors/${encodeURIComponent(visitor.id)}`))
      .then((response) => {
        clearRequestKey(requestSlot);
        setVisitors((current) => current.map((item) => item.id === visitor.id ? response.visitor : item));
        setSelected((current) => current?.id === visitor.id ? response.visitor : current);
        setTransitionReason('');
        setMessage(`Visitor moved to ${humanize(status)}.`);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'The visitor stage could not be changed.'))
      .finally(() => setSaving(false));
  };

  const createFollowup = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selected === null) return;
    setSaving(true);
    setError(null);
    const requestSlot = `followup-${selected.id}-${JSON.stringify(followup)}`;
    void postJson(`/crm/visitors/${encodeURIComponent(selected.id)}/followups`, followup, requestKey(requestSlot))
      .then(() => getJson<CrmTimelineResponse>(`/crm/visitors/${encodeURIComponent(selected.id)}/timeline`))
      .then((response) => { clearRequestKey(requestSlot); setTimeline(response.timeline); setFollowup({ assigned_to: selected.assigned_to ?? '', scheduled_for: '', title: '', notes: '' }); setMessage('Follow-up scheduled in the CRM source of truth.'); })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'The follow-up could not be scheduled.'))
      .finally(() => setSaving(false));
  };

  const transitionFollowup = (followupId: string, status: 'complete' | 'cancel') => {
    if (selected === null) return;
    setSaving(true);
    setError(null);
    const requestSlot = `followup-transition-${followupId}-${status}`;
    void postJson(`/crm/followups/${encodeURIComponent(followupId)}/${status}`, undefined, requestKey(requestSlot))
      .then(() => getJson<CrmTimelineResponse>(`/crm/visitors/${encodeURIComponent(selected.id)}/timeline`))
      .then((response) => { clearRequestKey(requestSlot); setTimeline(response.timeline); setMessage(`Follow-up ${status === 'complete' ? 'completed' : 'cancelled'}.`); })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'The follow-up could not be updated.'))
      .finally(() => setSaving(false));
  };

  const recordInteraction = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selected === null || interaction.summary.trim() === '') return;
    setSaving(true);
    setError(null);
    const interactionBody = {
      ...interaction,
      occurred_on: new Date().toISOString().slice(0, 10),
    };
    const requestSlot = `interaction-${selected.id}-${JSON.stringify(interactionBody)}`;
    void postJson(`/crm/visitors/${encodeURIComponent(selected.id)}/interactions`, interactionBody, requestKey(requestSlot))
      .then(() => getJson<CrmTimelineResponse>(`/crm/visitors/${encodeURIComponent(selected.id)}/timeline`))
      .then((response) => { clearRequestKey(requestSlot); setInteraction((current) => ({ ...current, summary: '' })); setTimeline(response.timeline); setMessage('Interaction appended to the immutable timeline.'); })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'The interaction could not be recorded.'))
      .finally(() => setSaving(false));
  };

  const visibleVisitors = useMemo(() => {
    const term = filter.trim().toLowerCase();
    if (term === '') return visitors;
    return visitors.filter((visitor) => [visitor.full_name, visitor.visitor_code, visitor.email ?? '', visitor.phone ?? '', visitor.status].some((value) => value.toLowerCase().includes(term)));
  }, [filter, visitors]);

  return (
    <>
      <header className="app-header">
        <a className="app-brand" href="/workspace">The <span>TOEFL</span> House</a>
        <nav aria-label="Primary navigation"><a href="/workspace">Workspace</a><a href="/students">Students</a><a aria-current="page" href="/crm">CRM</a><a href="/management">Management</a><a href="/academic">Academic</a><a href="/finance">Finance</a><a href="/reporting">Reporting</a></nav>
        <form method="post" action="/logout"><input type="hidden" name="_token" value={csrfToken} /><button className="sign-out" type="submit">Sign out</button></form>
      </header>
      <main className="workspace" aria-labelledby="crm-title">
        <header className="workspace-header"><div><p className="eyebrow">Canonical CRM workspace</p><h1 id="crm-title">Know the next best conversation.</h1><p className="lede">Visitors, provenance, follow-up, and immutable interaction evidence in one authorized view.</p></div><button className="button secondary" type="button" onClick={loadVisitors}>Refresh directory</button></header>
        {error && <div className="alert" role="alert">{error}</div>}
        {message && <div className="notice" role="status">{message}</div>}
        <section className="crm-layout" aria-label="CRM workspace">
          <div className="crm-main">
            <form className="panel crm-capture" onSubmit={capture}>
              <div className="section-heading"><div><p className="eyebrow">Capture</p><h2>New visitor</h2></div><span className="source-note">Writes go to CRM through the versioned API.</span></div>
              {branchesLoaded && branches.length === 0 && !allowUnassigned && <p className="form-help" role="status">No authorized active branch is available. Capture is disabled so a visitor cannot be created with unreadable provenance.</p>}
              {branchesLoaded && allowUnassigned && <p className="form-help" role="status">Organization-scoped capture may intentionally leave branch provenance unassigned; the server will keep that fact explicit.</p>}
              <div className="form-grid">
                <label>Full name<input required maxLength={160} value={form.full_name} onChange={(event) => setForm({ ...form, full_name: event.target.value })} /></label>
                <label>Phone<input maxLength={40} value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>
                <label>Email<input type="email" maxLength={160} value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
                <label>Preferred channel<select value={form.preferred_channel} onChange={(event) => setForm({ ...form, preferred_channel: event.target.value })}><option value="phone">Phone</option><option value="email">Email</option><option value="whatsapp">WhatsApp</option><option value="in_person">In person</option></select></label>
                <label>Visitor type<select value={form.visitor_type} onChange={(event) => setForm({ ...form, visitor_type: event.target.value })}><option value="walk_in">Walk in</option><option value="online">Online</option><option value="referral">Referral</option><option value="admissions_event">Admissions event</option><option value="social">Social</option></select></label>
                <label>Origin branch<select required={branches.length > 0 && !allowUnassigned} value={form.origin_branch_id} onChange={(event) => setForm({ ...form, origin_branch_id: event.target.value })}><option value="">{allowUnassigned ? 'Unassigned / unknown provenance' : branches.length > 0 ? 'Select a branch…' : 'No branch in scope'}</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>
                <label>Source<select value={form.source_id} onChange={(event) => { const sourceId = event.target.value; const selectedCampaign = campaigns.find((campaign) => campaign.id === form.campaign_id); setForm({ ...form, source_id: sourceId, campaign_id: selectedCampaign?.source_id && selectedCampaign.source_id !== sourceId ? '' : form.campaign_id }); }}><option value="">No source</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select></label>
                <label>Campaign<select value={form.campaign_id} onChange={(event) => setForm({ ...form, campaign_id: event.target.value })}><option value="">No campaign</option>{campaigns.filter((campaign) => form.source_id === '' || campaign.source_id === null || campaign.source_id === form.source_id).map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}</select></label>
                <label>Interest<input maxLength={255} value={form.interest} onChange={(event) => setForm({ ...form, interest: event.target.value })} /></label>
              </div>
              <label>Notes<textarea maxLength={2000} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} rows={2} /></label>
              <button className="button" type="submit" disabled={saving || (branchesLoaded && branches.length === 0 && !allowUnassigned)}> {saving ? 'Saving…' : 'Capture visitor'} </button>
            </form>
            <section className="panel" aria-labelledby="directory-title"><div className="section-heading"><div><p className="eyebrow">Authorized directory</p><h2 id="directory-title">Visitors and leads</h2></div><span className="source-note">{visibleVisitors.length} visible · branch scope enforced server-side</span></div><label className="directory-filter">Filter visible visitors<input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Name, code, phone, email, status" /></label>{loading ? <p className="empty">Loading authorized visitors…</p> : visibleVisitors.length === 0 ? <p className="empty">No visitors match the current scope or filter.</p> : <ul className="visitor-list">{visibleVisitors.map((visitor) => <li key={visitor.id} className={selected?.id === visitor.id ? 'selected' : ''}><button type="button" className="visitor-row" onClick={() => openVisitor(visitor)}><span><strong>{visitor.full_name}</strong><small>{visitor.visitor_code} · {visitor.email ?? visitor.phone ?? 'No contact'}{visitor.origin_branch ? ` · ${visitor.origin_branch.name}` : visitor.origin_branch_id ? ` · branch ${visitor.origin_branch_id}` : ''}</small></span><span className={`status-chip ${visitor.status}`}>{humanize(visitor.status)}</span></button>{visitor.interest && <p className="visitor-interest">{visitor.interest}</p>}</li>)}</ul>}</section>
          </div>
          <aside className="panel crm-detail" aria-labelledby="detail-title">{selected === null ? <div className="empty"><p className="eyebrow">Evidence panel</p><h2 id="detail-title">Select a visitor</h2><p>Review authorized timeline evidence and record the next action without leaving the owning CRM context.</p></div> : <><div className="section-heading"><div><p className="eyebrow">{selected.visitor_code}</p><h2 id="detail-title">{selected.full_name}</h2></div><span className={`status-chip ${selected.status}`}>{humanize(selected.status)}</span></div><dl className="detail-facts"><div><dt>Contact</dt><dd>{selected.email ?? selected.phone ?? 'Not supplied'}</dd></div><div><dt>Provenance</dt><dd>{selected.origin_branch?.name ?? selected.origin_branch_id ?? 'Unassigned'}</dd></div><div><dt>Identity</dt><dd>{selected.person_id ? `Verified person ${selected.person_id}` : 'Anonymous visitor'}</dd></div><div><dt>Acquisition</dt><dd>{selected.campaign?.name ?? selected.source?.name ?? 'Direct'}</dd></div></dl><h3>Verified identity</h3><form onSubmit={linkPerson} className="identity-link"><label>Person id<input required value={personId} onChange={(event) => setPersonId(event.target.value)} placeholder="Verified person id" /></label><button className="button secondary" type="submit" disabled={saving || selected.person_id !== null}> {selected.person_id ? 'Identity linked' : 'Link identity'} </button></form><div className="stage-actions"><label>Move stage<select value={selected.status} disabled={saving || selected.available_transitions.length === 0} onChange={(event) => transition(selected, event.target.value)}><option value={selected.status}>{humanize(selected.status)}</option>{selected.available_transitions.map((status) => <option key={status} value={status}>{humanize(status)}</option>)}</select></label><label>Transition reason<input value={transitionReason} onChange={(event) => setTransitionReason(event.target.value)} placeholder="Required when marking lost" /></label></div><h3>Record interaction</h3><form onSubmit={recordInteraction}><div className="compact-grid"><label>Direction<select value={interaction.direction} onChange={(event) => setInteraction({ ...interaction, direction: event.target.value })}><option value="outbound">Outbound</option><option value="inbound">Inbound</option></select></label><label>Type<select value={interaction.type} onChange={(event) => setInteraction({ ...interaction, type: event.target.value })}>{interactionTypes.map((type) => <option key={type} value={type}>{humanize(type)}</option>)}</select></label><label>Outcome<select value={interaction.outcome} onChange={(event) => setInteraction({ ...interaction, outcome: event.target.value })}>{interactionOutcomes.map((outcome) => <option key={outcome} value={outcome}>{humanize(outcome)}</option>)}</select></label></div><label>Summary<textarea required maxLength={2000} value={interaction.summary} onChange={(event) => setInteraction({ ...interaction, summary: event.target.value })} rows={3} /></label><button className="button" type="submit" disabled={saving}>Append interaction</button></form><h3>Schedule follow-up</h3><form onSubmit={createFollowup}><div className="compact-grid"><label>Assigned person<input required value={followup.assigned_to} onChange={(event) => setFollowup({ ...followup, assigned_to: event.target.value })} placeholder="Verified person id" /></label><label>Scheduled for<input required type="datetime-local" value={followup.scheduled_for} onChange={(event) => setFollowup({ ...followup, scheduled_for: event.target.value })} /></label></div><label>Title<input required maxLength={160} value={followup.title} onChange={(event) => setFollowup({ ...followup, title: event.target.value })} /></label><label>Notes<textarea maxLength={2000} value={followup.notes} onChange={(event) => setFollowup({ ...followup, notes: event.target.value })} rows={2} /></label><button className="button" type="submit" disabled={saving}>Schedule follow-up</button></form><h3>Timeline</h3>{timeline.length === 0 ? <p className="empty">No interaction or follow-up evidence yet.</p> : <ol className="timeline">{timeline.map((item) => <li key={`${item.kind}-${item.id}`}><strong>{item.title ?? `${humanize(item.type ?? item.kind)}${item.outcome ? ` · ${humanize(item.outcome)}` : ''}`}</strong><small>{item.at} · {humanize(item.kind)}{item.status ? ` · ${humanize(item.status)}` : ''}</small><span>{item.summary ?? `Scheduled for ${item.scheduled_for ?? 'later'}${item.assigned_to ? ` · assigned to ${item.assigned_to}` : ''}`}</span>{item.kind === 'followup' && item.status === 'open' && <span className="timeline-actions"><button className="text-button" type="button" disabled={saving} onClick={() => transitionFollowup(item.id, 'complete')}>Complete</button><button className="text-button" type="button" disabled={saving} onClick={() => transitionFollowup(item.id, 'cancel')}>Cancel</button></span>}</li>)}</ol>}</>}
          </aside>
        </section>
      </main>
    </>
  );
}

function ManagementApp() {
  const [management, setManagement] = useState<ManagementWorkspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadManagement = () => {
    setLoading(true);
    setError(null);
    void getJson<ApiEnvelope<ManagementWorkspace>>('/management')
      .then((response) => setManagement(response.data))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Management data could not be loaded.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadManagement(); }, []);

  if (loading) return <main className="workspace"><div className="panel status">Loading your authorized management workspace…</div></main>;

  return (
    <>
      <header className="app-header">
        <a className="app-brand" href="/workspace">The <span>TOEFL</span> House</a>
        <nav aria-label="Primary navigation"><a href="/workspace">Workspace</a><a href="/students">Students</a><a href="/crm">CRM</a><a href="/management" aria-current="page">Management</a><a href="/academic">Academic</a><a href="/finance">Finance</a><a href="/reporting">Reporting</a></nav>
        <form method="post" action="/logout"><input type="hidden" name="_token" value={csrfToken} /><button className="sign-out" type="submit">Sign out</button></form>
      </header>
      <main className="workspace" aria-labelledby="management-title">
        <header className="workspace-header"><div><p className="eyebrow">Governed decision support</p><h1 id="management-title">See the health of the operation.</h1><p className="lede">Management reads source-owned projections, reports, and operational health. It does not create tasks, alter money, or make lifecycle decisions.</p></div><button className="button secondary" type="button" onClick={loadManagement}>Refresh snapshot</button></header>
        {error && <div className="alert" role="alert">{error}</div>}
        {management && <>
          <section className="panel management-scope" aria-labelledby="scope-heading"><div className="section-heading"><div><p className="eyebrow">Effective authorization</p><h2 id="scope-heading">{humanize(management.scope.type)} scope</h2></div><span className="source-note">Snapshot generated by the server</span></div><p className="muted">Organizations: {management.scope.organization_ids.length ? management.scope.organization_ids.join(', ') : 'none in scope'}</p><p className="muted">Branches: {management.scope.branch_ids.length ? management.scope.branch_ids.join(', ') : 'none in scope'}</p></section>
          <section className="panel" aria-labelledby="management-counts-heading"><div className="section-heading"><div><p className="eyebrow">Source-linked measures</p><h2 id="management-counts-heading">Current operating counts</h2></div><span className="source-note">Read-only projection · values are not recalculated in React</span></div><div className="management-grid">{Object.entries(management.counts).map(([key, value]) => <div key={key}><strong>{value}</strong><span>{humanize(key)}</span></div>)}</div></section>
          <section className="panel" aria-labelledby="health-heading"><div className="section-heading"><div><p className="eyebrow">Operational health</p><h2 id="health-heading">Projection and integration signals</h2></div><span className="source-note">Unavailable sources remain explicit</span></div><div className="health-grid">{Object.entries(management.operational_health).map(([key, value]) => <div key={key}><span>{humanize(key)}</span><strong>{String(value)}</strong></div>)}</div></section>
          <section className="panel" aria-labelledby="reports-heading"><div className="section-heading"><div><p className="eyebrow">Governed reporting</p><h2 id="reports-heading">Latest report runs</h2></div><span className="source-note">{management.latest_reports.length} visible run{management.latest_reports.length === 1 ? '' : 's'}</span></div>{management.latest_reports.length === 0 ? <p className="empty">No report run is available in this authorized scope.</p> : <ul className="report-list">{management.latest_reports.map((report) => <li key={report.id}><span><strong>{report.period_key}</strong><small>{report.created_at ?? 'Timestamp unavailable'}</small></span><span className="status-chip">{humanize(report.result)}</span></li>)}</ul>}</section>
        </>}
      </main>
    </>
  );
}

type StudentPerson = { id?: string; person_id?: string; legal_name: string; verification_state?: string };
type StudentRow = { id: string; student_code: string; person?: StudentPerson | null; current_status?: string | null; originating_branch_id?: string | null; current_home_branch_id?: string | null; current_home_branch?: { id: string; name: string } | null };
type ApplicantRow = { id: string; person?: StudentPerson | null; program_interest: string; lifecycle_state: string; originating_branch_id?: string | null; current_home_branch_id?: string | null };
type AdmissionDecisionRow = { id: string; applicant_id: string; outcome: string; reason: string; evidence_ref: string; initiator_id: string; reviewer_id?: string | null; approver_id?: string | null; lifecycle_state: string; created_at?: string | null };
type BranchOption = { id: string; name: string; lifecycle_state: string };
type RegistrationPerson = { id: string; legal_name: string; home_branch_id?: string | null };
type StudentsIndexCapabilities = { directory: boolean; admission_register: boolean; admission_initiate: boolean; admission_review: boolean; admission_approve: boolean; student_transfer: boolean; student_guardian: boolean };
type StudentsIndex = { students: StudentRow[]; applicants: ApplicantRow[]; decisions: AdmissionDecisionRow[]; registration_people: RegistrationPerson[]; guardian_people: RegistrationPerson[]; registration_branches: BranchOption[]; branch_options: BranchOption[]; branch_catalog: BranchOption[]; guardian_permission_options: string[]; capabilities: StudentsIndexCapabilities };
type StudentLifecycle = {
  student_id: string;
  student_code: string;
  person: { person_id: string; legal_name: string; verified: boolean };
  admission: { decision_id: string; applicant_id: string; program_interest: string | null; outcome: string; lifecycle_state: string; reason: string; evidence_ref: string; initiator_id: string; reviewer_id: string; approver_id: string; created_at: string | null } | null;
  originating_branch_id: string;
  current_home_branch_id: string;
  branch_provenance: { originating: { id: string; name: string } | null; current_home: { id: string; name: string } | null };
  placement_profile_id: string;
  placement: { lifecycle_state: string; recommended_level_id: string; overall_cefr_ref: string | null } | null;
  status: string | null;
  available_status_transitions: string[];
  status_history: Array<{ id: string; status: string; effective_from: string; reason: string; actor_id: string }>;
  holds: { open: boolean; history: Array<{ action: string; effective_from: string; reason: string }> };
  branch_transfers: Array<{ from_branch_id: string; to_branch_id: string; effective_from: string; reason: string }>;
  guardians: Array<{ relationship_id: string; guardian_person_id: string; relationship: string; permissions: string[] }>;
  guardian_relationships: Array<{ relationship_id: string; guardian_person_id: string; relationship: string; permissions: string[]; verification_state: string }>;
  communication_preferences: Array<{ channel: string; enabled: boolean }>;
  enrollments: Array<{ id: string; class_id: string; lifecycle_state: string; period_name?: string | null }>;
  attendance: { present: number; absent: number; late: number; excused: number };
  assessment_results: Array<{ id: string; kind: string; score: string | number | null; lifecycle_state: string; evidence_ref: string }>;
  progression_decisions: Array<{ id: string; outcome: string; lifecycle_state: string; reason: string }>;
  obligations: Array<{ id: string; original_amount: string | number; source: string; reason: string; originating_branch_id: string; current_home_branch_id: string }>;
  payments: Array<{ id: string; amount: string | number; method: string; received_on: string; originating_branch_id: string; current_home_branch_id: string }>;
  documents: Array<{ id: string; title: string; lifecycle_state: string; version_no: number | null }>;
  messages: Array<{ id: string; channel: string; lifecycle_state: string; created_at?: string }>;
  audit_events: Array<{ id: string; operation: string; occurred_at: string; actor_id: string }>;
  workflow: Array<{ type: string; label: string }>;
  capabilities: { status_manage: boolean; status_reactivate: boolean; transfer: boolean; hold: boolean; communication: boolean; guardian: boolean; finance_obligation: boolean; finance_payment: boolean; finance: boolean };
};

const studentsView = root?.getAttribute('data-students-view') ?? 'directory';
const studentId = root?.getAttribute('data-student-id') ?? '';

function StudentsHeader() {
  return <header className="app-header">
    <a className="app-brand" href="/workspace">The <span>TOEFL</span> House</a>
    <nav aria-label="Primary navigation"><a href="/workspace">Workspace</a><a href="/students" aria-current="page">Students</a><a href="/teachers">Teachers</a><a href="/crm">CRM</a><a href="/management">Management</a><a href="/academic">Academic</a><a href="/finance">Finance</a><a href="/reporting">Reporting</a></nav>
    <form method="post" action="/logout"><input type="hidden" name="_token" value={csrfToken} /><button className="sign-out" type="submit">Sign out</button></form>
  </header>;
}

function StudentRegistration({ data, onSaved }: { data: StudentsIndex; onSaved: () => void }) {
  const [form, setForm] = useState({ person_id: '', program_interest: '', branch_id: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSaving(true); setError(null);
    void postJson('/students/applicants', form).then(() => { setForm({ person_id: '', program_interest: '', branch_id: '' }); onSaved(); }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Applicant registration failed.')).finally(() => setSaving(false));
  };
  return <section className="panel student-form" aria-labelledby="register-applicant-heading">
    <div className="section-heading"><div><p className="eyebrow">Admissions intake</p><h2 id="register-applicant-heading">Register a verified person</h2></div><span className="source-note">Creates an applicant through the admissions authority</span></div>
    {error && <div className="alert" role="alert">{error}</div>}
    <form onSubmit={submit}><div className="form-grid">
      <label>Verified person<select required value={form.person_id} onChange={(event) => setForm({ ...form, person_id: event.target.value })}><option value="">Select a person…</option>{data.registration_people.map((person) => <option key={person.id} value={person.id}>{person.legal_name}</option>)}</select></label>
      <label>Program interest<input required value={form.program_interest} onChange={(event) => setForm({ ...form, program_interest: event.target.value })} /></label>
      <label>Operational branch<select required value={form.branch_id} onChange={(event) => setForm({ ...form, branch_id: event.target.value })}><option value="">Select a branch…</option>{data.registration_branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>
    </div><button className="button" type="submit" disabled={saving}>{saving ? 'Registering…' : 'Register applicant'}</button></form>
  </section>;
}

function DecisionControls({ applicant, decision, refresh, capabilities }: { applicant: ApplicantRow; decision?: AdmissionDecisionRow; refresh: () => void; capabilities: StudentsIndexCapabilities }) {
  const [form, setForm] = useState({ decision: 'admit', reason: '', evidence_ref: '' });
  const [reopenProgramInterest, setReopenProgramInterest] = useState(applicant.program_interest);
  const [reopenReason, setReopenReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const action = (path: string, body?: Record<string, unknown>) => { setBusy(true); setError(null); void postJson(path, body).then(refresh).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Admission action failed.')).finally(() => setBusy(false)); };
  return <div className="decision-controls">
    {error && <p className="form-error">{error}</p>}
    {decision?.lifecycle_state === 'proposed' && capabilities.admission_review && <button className="button secondary" type="button" disabled={busy} onClick={() => action(`/students/decisions/${encodeURIComponent(decision.id)}/review`)}>Review as a distinct authority</button>}
    {decision?.lifecycle_state === 'reviewed' && capabilities.admission_approve && <button className="button" type="button" disabled={busy} onClick={() => action(`/students/decisions/${encodeURIComponent(decision.id)}/approve`)}>Approve as a distinct authority</button>}
    {decision?.lifecycle_state === 'final' && decision.outcome === 'admit' && capabilities.admission_approve && <button className="button" type="button" disabled={busy} onClick={() => action(`/students/applicants/${encodeURIComponent(applicant.id)}/enroll`)}>Enroll as student</button>}
    {decision?.lifecycle_state === 'final' && decision.outcome === 'reject' && applicant.lifecycle_state === 'rejected' && capabilities.admission_register && <details className="decision-form"><summary className="button secondary">Reopen application</summary><label>New program submission<input required value={reopenProgramInterest} onChange={(event) => setReopenProgramInterest(event.target.value)} /></label><label>Reason for re-application<input required value={reopenReason} onChange={(event) => setReopenReason(event.target.value)} /></label><button className="button" type="button" disabled={busy || reopenProgramInterest.trim() === '' || reopenReason.trim() === ''} onClick={() => action(`/students/applicants/${encodeURIComponent(applicant.id)}/reopen`, { program_interest: reopenProgramInterest, reason: reopenReason })}>Reopen for decision</button><p className="muted form-help">The rejected decision remains immutable history; reopening only returns this application to the staged decision chain.</p></details>}
    {(capabilities.admission_initiate && applicant.lifecycle_state === 'applicant' && (!decision || (decision.lifecycle_state === 'final' && decision.outcome === 'reject'))) && <details className="decision-form"><summary className="button secondary">Initiate decision</summary><div className="compact-grid">
      <label>Outcome<select value={form.decision} onChange={(event) => setForm({ ...form, decision: event.target.value })}><option value="admit">Admit</option><option value="reject">Reject</option></select></label>
      <label>Evidence reference<input required value={form.evidence_ref} onChange={(event) => setForm({ ...form, evidence_ref: event.target.value })} /></label>
      <label className="full-width">Reason<input required value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} /></label>
    </div><button className="button" type="button" disabled={busy} onClick={() => action(`/students/applicants/${encodeURIComponent(applicant.id)}/initiate`, form)}>Initiate decision</button><p className="muted form-help">Initiation, review, and approval are separate server-authorized steps. The employee identity is never supplied by this form.</p></details>}
  </div>;
}

function StudentsApp() {
  const [data, setData] = useState<StudentsIndex | null>(null);
  const [selected, setSelected] = useState<StudentLifecycle | null>(null);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [tab, setTab] = useState(['admissions', 'applicants'].includes(studentsView) ? 'admissions' : 'directory');
  const load = () => { setLoading(true); setError(null); void getJson<StudentsIndex>('/students').then(setData).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Students data could not be loaded.')).finally(() => setLoading(false)); };
  const loadStudent = (id: string) => { setSelected(null); setError(null); setMessage(null); void getJson<StudentLifecycle>(`/students/${encodeURIComponent(id)}`).then(setSelected).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Student lifecycle could not be loaded.')); };
  useEffect(() => {
    load();
    const syncLocation = () => {
      const match = window.location.pathname.match(/^\/students\/([^/]+)$/);
      if (match?.[1] && match[1] !== 'applicants') loadStudent(decodeURIComponent(match[1])); else { setSelected(null); setTab(window.location.pathname === '/students/applicants' ? 'admissions' : 'directory'); }
    };
    if (studentId !== '') loadStudent(studentId);
    window.addEventListener('popstate', syncLocation);
    return () => window.removeEventListener('popstate', syncLocation);
  }, []);
  const refresh = () => { load(); if (selected) void getJson<StudentLifecycle>(`/students/${encodeURIComponent(selected.student_id)}`).then(setSelected); };
  const decisionByApplicant = useMemo(() => { const map: Record<string, AdmissionDecisionRow> = {}; for (const decision of data?.decisions ?? []) { if (!map[decision.applicant_id]) map[decision.applicant_id] = decision; } return map; }, [data]);
  const visibleStudents = useMemo(() => { const term = filter.toLowerCase().trim(); if (!term) return data?.students ?? []; return (data?.students ?? []).filter((item) => `${item.student_code} ${item.person?.legal_name ?? ''} ${item.current_status ?? ''}`.toLowerCase().includes(term)); }, [data, filter]);
  const visibleApplicants = useMemo(() => { const term = filter.toLowerCase().trim(); if (!term) return data?.applicants ?? []; return (data?.applicants ?? []).filter((item) => `${item.person?.legal_name ?? ''} ${item.program_interest} ${item.lifecycle_state}`.toLowerCase().includes(term)); }, [data, filter]);
  if (loading) return <><StudentsHeader /><main className="workspace"><div className="panel status">Loading authorized student and admissions records…</div></main></>;
  if (selected) return <StudentDetail lifecycle={selected} branches={data?.branch_options ?? []} people={data?.guardian_people ?? []} permissionOptions={data?.guardian_permission_options ?? []} onBack={() => { setSelected(null); window.history.pushState({}, '', '/students'); }} onChanged={(text) => { setError(null); setMessage(text); refresh(); }} onError={(text) => { setMessage(null); setError(text); }} error={error} message={message} />;
  return <><StudentsHeader /><main className="workspace" aria-labelledby="students-title"><header className="workspace-header"><div><p className="eyebrow">Student information system</p><h1 id="students-title">Students and admissions, one governed lifecycle.</h1><p className="lede">Directory reads and admission actions are authorized by branch provenance. Business facts remain in their owning modules.</p></div><button className="button secondary" type="button" onClick={load}>Refresh data</button></header>
    {error && <div className="alert" role="alert">{error}</div>}{message && <div className="notice" role="status">{message}</div>}
    <div className="student-tabs" role="tablist"><button className={tab === 'directory' ? 'active' : ''} type="button" onClick={() => { setTab('directory'); window.history.pushState({}, '', '/students'); }}>Student directory <span>{data?.students.length ?? 0}</span></button><button className={tab === 'admissions' ? 'active' : ''} type="button" onClick={() => { setTab('admissions'); window.history.pushState({}, '', '/students/applicants'); }}>Admissions queue <span>{data?.applicants.length ?? 0}</span></button></div>
    {tab === 'directory' ? <><section className="panel"><div className="section-heading"><div><p className="eyebrow">Authorized directory</p><h2>Current students</h2></div><span className="source-note">{visibleStudents.length} visible record{visibleStudents.length === 1 ? '' : 's'}</span></div><label className="directory-filter">Filter students<input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Name, student code, or status" /></label>{visibleStudents.length === 0 ? <p className="empty">No student is available in your effective scope.</p> : <ul className="student-list">{visibleStudents.map((student) => <li key={student.id}><button type="button" onClick={() => { window.history.pushState({}, '', `/students/${encodeURIComponent(student.id)}`); loadStudent(student.id); }}><span><strong>{student.person?.legal_name ?? student.student_code}</strong><small>{student.student_code} · {student.current_home_branch?.name ?? student.current_home_branch_id ?? student.originating_branch_id ?? 'branch provenance unavailable'}</small></span><span className="status-chip">{humanize(student.current_status ?? 'status unavailable')}</span></button></li>)}</ul>}</section></> : <>{data !== null && data.capabilities.admission_register && <StudentRegistration data={data} onSaved={() => { setMessage('Applicant registered.'); load(); }} />}<section className="panel"><div className="section-heading"><div><p className="eyebrow">Admissions lifecycle</p><h2>Applicants and staged decisions</h2></div><span className="source-note">Three-person authority chain enforced by the API</span></div>{visibleApplicants.length === 0 ? <p className="empty">No applicant is available in your effective scope.</p> : <ul className="applicant-list">{visibleApplicants.map((applicant) => <li key={applicant.id}><div className="applicant-summary"><strong>{applicant.person?.legal_name ?? 'Applicant'}</strong><span>{applicant.program_interest}</span><small>{humanize(applicant.lifecycle_state)} · {data?.branch_catalog.find((branch) => branch.id === (applicant.current_home_branch_id ?? applicant.originating_branch_id))?.name ?? applicant.current_home_branch_id ?? applicant.originating_branch_id ?? 'branch provenance unavailable'}</small>{decisionByApplicant[applicant.id] && <small>Decision: {humanize(decisionByApplicant[applicant.id]?.outcome ?? '')} · {humanize(decisionByApplicant[applicant.id]?.lifecycle_state ?? '')} · evidence {decisionByApplicant[applicant.id]?.evidence_ref ?? 'not recorded'}</small>}</div><DecisionControls applicant={applicant} decision={decisionByApplicant[applicant.id]} capabilities={data?.capabilities ?? { directory: false, admission_register: false, admission_initiate: false, admission_review: false, admission_approve: false, student_transfer: false, student_guardian: false }} refresh={load} /></li>)}</ul>}</section></>}</main></>;
}

function StudentDetail({ lifecycle, branches, people, permissionOptions, onBack, onChanged, onError, error, message }: { lifecycle: StudentLifecycle; branches: BranchOption[]; people: RegistrationPerson[]; permissionOptions: string[]; onBack: () => void; onChanged: (message: string) => void; onError: (message: string) => void; error: string | null; message: string | null }) {
  const [statusReason, setStatusReason] = useState('');
  const [transferReason, setTransferReason] = useState('');
  const [holdReason, setHoldReason] = useState('');
  const [targetBranch, setTargetBranch] = useState(lifecycle.current_home_branch_id);
  const [guardianForm, setGuardianForm] = useState({ guardian_person_id: '', relationship: '', permissions: '' });
  const [guardianEvidence, setGuardianEvidence] = useState('');
  const [channel, setChannel] = useState('email');
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const action = (path: string, body: Record<string, unknown>, success: string) => { setBusy(true); void postJson(path, body).then(() => onChanged(success)).catch((reasonValue: unknown) => onError(reasonValue instanceof Error ? reasonValue.message : 'The action failed.')).finally(() => setBusy(false)); };
  const statusAction: Record<string, string> = { suspended: 'suspend', withdrawn: 'withdraw', active: 'reactivate', completed: 'complete', alumni: 'graduate' };
  const branchName = (id: string) => branches.find((branch) => branch.id === id)?.name ?? id;
  const personName = (id: string) => people.find((person) => person.id === id)?.legal_name ?? id;
  const currentPreference = lifecycle.communication_preferences.find((item) => item.channel === channel);
  useEffect(() => { setEnabled(currentPreference?.enabled ?? false); }, [channel, lifecycle.communication_preferences]);
  useEffect(() => { setTargetBranch(lifecycle.current_home_branch_id); }, [lifecycle.current_home_branch_id]);
  return <><StudentsHeader /><main className="workspace" aria-labelledby="student-detail-title"><div className="detail-back"><button className="text-button" type="button" onClick={onBack}>← Back to student directory</button></div><header className="workspace-header"><div><p className="eyebrow">Canonical learner lifecycle</p><h1 id="student-detail-title">{lifecycle.person.legal_name}</h1><p className="lede">{lifecycle.student_code} · {lifecycle.person.verified ? 'Verified identity' : 'Identity verification requires attention'}</p></div><div className="detail-header-actions"><span className="status-chip">{humanize(lifecycle.status ?? 'status unavailable')}</span><a className="button secondary" href={`/print/id-card/${encodeURIComponent(lifecycle.student_id)}`}>Print ID card</a></div></header>
    {error && <div className="alert" role="alert">{error}</div>}{message && <div className="notice" role="status">{message}</div>}
    <section className="summary-grid student-summary"><div className="panel"><span className="metric">{lifecycle.enrollments.length}</span><span className="metric-label">Enrollments</span></div><div className="panel"><span className="metric">{lifecycle.attendance.present}</span><span className="metric-label">Attendance present</span></div><div className="panel"><span className="metric">{lifecycle.assessment_results.length}</span><span className="metric-label">Assessment results</span></div><div className="panel"><span className="metric">{lifecycle.holds.open ? 'On hold' : 'Clear'}</span><span className="metric-label">Lifecycle hold</span></div></section>
    <div className="student-detail-grid"><div className="student-detail-main">
      {lifecycle.admission && <section className="panel"><div className="section-heading"><div><p className="eyebrow">Admissions lineage</p><h2>Approved entry decision</h2></div><span className="source-note">Immutable decision evidence linked to this student</span></div><dl className="detail-facts"><div><dt>Program interest</dt><dd>{lifecycle.admission.program_interest ?? 'Not recorded'}</dd></div><div><dt>Outcome</dt><dd>{humanize(lifecycle.admission.outcome)} · {humanize(lifecycle.admission.lifecycle_state)}</dd></div><div><dt>Evidence</dt><dd>{lifecycle.admission.evidence_ref}</dd></div><div><dt>Reason</dt><dd>{lifecycle.admission.reason}</dd></div></dl></section>}
      <section className="panel"><div className="section-heading"><div><p className="eyebrow">Status authority</p><h2>Lifecycle controls</h2></div><span className="source-note">Append-only facts; server decides authorization</span></div><p className="muted">Available next statuses: {lifecycle.available_status_transitions.length ? lifecycle.available_status_transitions.map(humanize).join(', ') : 'none'}</p><div className="action-form"><input value={statusReason} onChange={(event) => setStatusReason(event.target.value)} placeholder="Reason or evidence reference" /><div className="inline-actions">{lifecycle.available_status_transitions.map((target) => { const allowed = target === 'active' ? lifecycle.capabilities.status_reactivate : lifecycle.capabilities.status_manage; return <button className="button secondary" key={target} type="button" disabled={busy || !allowed || statusReason.trim() === ''} onClick={() => action(`/students/${encodeURIComponent(lifecycle.student_id)}/status/${statusAction[target]}`, { reason: statusReason }, `Student status changed to ${humanize(target)}.`)}>{humanize(target)}{!allowed ? ' · not authorized' : ''}</button>; })}</div></div><div className="history-list">{lifecycle.status_history.map((item) => <div key={item.id}><strong>{humanize(item.status)}</strong><span>{item.effective_from} · {item.reason}</span></div>)}</div></section>
      <section className="panel"><div className="section-heading"><div><p className="eyebrow">Academic record</p><h2>Enrollments and outcomes</h2></div></div>{lifecycle.enrollments.length === 0 ? <p className="empty">No enrollment facts are recorded.</p> : <ul className="fact-list">{lifecycle.enrollments.map((item) => <li key={item.id}><strong>{item.class_id}</strong><span>{humanize(item.lifecycle_state)}{item.period_name ? ` · ${item.period_name}` : ''}</span></li>)}</ul>}<h3>Assessments</h3>{lifecycle.assessment_results.length === 0 ? <p className="empty">No released assessment result is visible.</p> : <ul className="fact-list">{lifecycle.assessment_results.map((item) => <li key={item.id}><strong>{humanize(item.kind)} · {item.score ?? '—'}</strong><span>{humanize(item.lifecycle_state)} · {item.evidence_ref}</span></li>)}</ul>}<h3>Progression decisions</h3>{lifecycle.progression_decisions.length === 0 ? <p className="empty">No progression decision is visible.</p> : <ul className="fact-list">{lifecycle.progression_decisions.map((item) => <li key={item.id}><strong>{humanize(item.outcome)} · {humanize(item.lifecycle_state)}</strong><span>{item.reason}</span></li>)}</ul>}</section>
      {lifecycle.capabilities.finance && <section className="panel"><div className="section-heading"><div><p className="eyebrow">Finance-owned facts</p><h2>Obligations and payments</h2></div><span className="source-note">Read-only Finance projection · no money is created here</span></div><h3>Obligations</h3>{lifecycle.obligations.length === 0 ? <p className="empty">No visible Finance obligations.</p> : <ul className="fact-list">{lifecycle.obligations.map((item) => <li key={item.id}><strong>{item.original_amount} · {humanize(item.source)}</strong><span>{item.reason} · {item.current_home_branch_id || item.originating_branch_id || 'provenance unavailable'}</span></li>)}</ul>}<h3>Payments</h3>{lifecycle.payments.length === 0 ? <p className="empty">No visible Finance payments.</p> : <ul className="fact-list">{lifecycle.payments.map((item) => <li key={item.id}><strong>{item.amount} · {humanize(item.method)}</strong><span>{item.received_on} · {item.current_home_branch_id || item.originating_branch_id || 'provenance unavailable'}</span></li>)}</ul>}</section>}
      <section className="panel"><div className="section-heading"><div><p className="eyebrow">Evidence trail</p><h2>Workflow and audit</h2></div></div>{lifecycle.workflow.map((item) => <p className="workflow-item" key={`${item.type}-${item.label}`}>{item.label}</p>)}<ul className="fact-list">{lifecycle.audit_events.map((item) => <li key={item.id}><strong>{item.operation}</strong><span>{item.occurred_at} · {item.actor_id}</span></li>)}</ul></section>
    </div><aside className="student-detail-side">
      <section className="panel"><div className="section-heading"><div><p className="eyebrow">Provenance</p><h2>Branch authority</h2></div></div><dl className="detail-facts"><div><dt>Origin</dt><dd>{lifecycle.branch_provenance.originating?.name ?? (lifecycle.originating_branch_id || 'Not assigned')}</dd></div><div><dt>Current</dt><dd>{lifecycle.branch_provenance.current_home?.name ?? (lifecycle.current_home_branch_id || 'Not assigned')}</dd></div><div><dt>Placement</dt><dd>{lifecycle.placement?.overall_cefr_ref ?? 'Not available'}</dd></div></dl><label className="directory-filter">Target branch<select value={targetBranch} onChange={(event) => setTargetBranch(event.target.value)}><option value="">Select a branch…</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label><input className="student-reason" value={transferReason} onChange={(event) => setTransferReason(event.target.value)} placeholder="Transfer reason" />{lifecycle.capabilities.transfer ? <button className="button" type="button" disabled={busy || !targetBranch || targetBranch === lifecycle.current_home_branch_id || transferReason.trim() === ''} onClick={() => action(`/students/${encodeURIComponent(lifecycle.student_id)}/transfer`, { branch_id: targetBranch, reason: transferReason }, 'Home branch transfer recorded.')}>Transfer home branch</button> : <p className="muted">Transfer authority is not available in this scope.</p>}<h3>Transfer history</h3><ul className="fact-list">{lifecycle.branch_transfers.map((item, index) => <li key={`${item.to_branch_id}-${index}`}><strong>{branchName(item.to_branch_id)}</strong><span>{item.effective_from} · {item.reason}</span></li>)}</ul></section>
      <section className="panel"><div className="section-heading"><div><p className="eyebrow">Controls</p><h2>Hold and communication</h2></div></div><label className="directory-filter">Action reason<input value={holdReason} onChange={(event) => setHoldReason(event.target.value)} placeholder="Reason" /></label>{lifecycle.capabilities.hold ? <div className="inline-actions"><button className="button secondary" type="button" disabled={busy || lifecycle.holds.open || holdReason.trim() === ''} onClick={() => action(`/students/${encodeURIComponent(lifecycle.student_id)}/hold`, { action: 'freeze', reason: holdReason }, 'Student hold opened.')}>Freeze</button><button className="button secondary" type="button" disabled={busy || !lifecycle.holds.open || holdReason.trim() === ''} onClick={() => action(`/students/${encodeURIComponent(lifecycle.student_id)}/hold`, { action: 'resume', reason: holdReason }, 'Student hold resumed.')}>Resume</button></div> : <p className="muted">Hold authority is not available in this scope.</p>}<h3>Hold history</h3>{lifecycle.holds.history.length === 0 ? <p className="empty">No hold events recorded.</p> : <ul className="fact-list">{lifecycle.holds.history.map((item, index) => <li key={`${item.action}-${item.effective_from}-${index}`}><strong>{humanize(item.action)}</strong><span>{item.effective_from} · {item.reason}</span></li>)}</ul>}<h3>Communication preferences</h3><label className="directory-filter">Channel<select value={channel} onChange={(event) => setChannel(event.target.value)}><option value="email">Email</option><option value="sms">SMS</option><option value="whatsapp">WhatsApp</option><option value="push">Push</option></select></label><label className="checkbox-label"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Enabled</label>{lifecycle.capabilities.communication ? <button className="button" type="button" disabled={busy} onClick={() => action(`/students/${encodeURIComponent(lifecycle.student_id)}/communication-preference`, { channel, enabled }, 'Communication preference saved.')}>Save preference</button> : <p className="muted">Communication preference authority is not available in this scope.</p>}</section>
      {lifecycle.capabilities.guardian && <section className="panel"><div className="section-heading"><div><p className="eyebrow">Relationship authority</p><h2>Guardians</h2></div><span className="source-note">Recorded, verified, and revoked as separate facts</span></div><div className="compact-grid"><label>Verified person<select value={guardianForm.guardian_person_id} onChange={(event) => setGuardianForm({ ...guardianForm, guardian_person_id: event.target.value })}><option value="">Select a person…</option>{people.filter((person) => person.id !== lifecycle.person.person_id).map((person) => <option key={person.id} value={person.id}>{person.legal_name}</option>)}</select></label><label>Relationship<input value={guardianForm.relationship} onChange={(event) => setGuardianForm({ ...guardianForm, relationship: event.target.value })} placeholder="Parent or legal guardian" /></label><label className="full-width">Permissions, comma-separated<input value={guardianForm.permissions} onChange={(event) => setGuardianForm({ ...guardianForm, permissions: event.target.value })} placeholder="view-academic, receive-communication" /><small className="form-help">Allowed relationship disclosures: {permissionOptions.map(humanize).join(', ')}.</small></label></div><button className="button" type="button" disabled={busy || !guardianForm.guardian_person_id || !guardianForm.relationship || !guardianForm.permissions} onClick={() => action(`/students/${encodeURIComponent(lifecycle.student_id)}/guardians`, { guardian_person_id: guardianForm.guardian_person_id, relationship: guardianForm.relationship, permissions: guardianForm.permissions.split(',').map((item) => item.trim()).filter(Boolean) }, 'Guardian relationship recorded and awaits verification.')}>Record relationship</button><label className="directory-filter">Verification evidence reference<input value={guardianEvidence} onChange={(event) => setGuardianEvidence(event.target.value)} placeholder="Case, document, or verification record" /><small className="form-help">Required before a relationship becomes authoritative.</small></label><ul className="fact-list">{lifecycle.guardian_relationships.map((guardian) => <li key={guardian.relationship_id}><strong>{personName(guardian.guardian_person_id)} · {guardian.relationship}</strong><span>{guardian.permissions.join(', ')} · {humanize(guardian.verification_state)}</span><div className="inline-actions">{guardian.verification_state === 'unverified' && <button className="text-button" type="button" disabled={busy || guardianEvidence.trim() === ''} onClick={() => action(`/students/guardians/${encodeURIComponent(guardian.relationship_id)}/verify`, { evidence_ref: guardianEvidence }, 'Guardian relationship verified.')}>Verify</button>}<button className="text-button" type="button" disabled={busy} onClick={() => action(`/students/guardians/${encodeURIComponent(guardian.relationship_id)}/revoke`, {}, 'Guardian relationship revoked.')}>Revoke</button></div></li>)}</ul></section>}
      <section className="panel"><div className="section-heading"><div><p className="eyebrow">Documents and messages</p><h2>Related facts</h2></div></div><p className="muted">{lifecycle.documents.length} document record{lifecycle.documents.length === 1 ? '' : 's'} · {lifecycle.messages.length} message record{lifecycle.messages.length === 1 ? '' : 's'}</p>{lifecycle.documents.map((document) => <p className="fact-line" key={document.id}>{document.title} · {humanize(document.lifecycle_state)}</p>)}</section>
    </aside></div></main></>;
}

function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [workspace, setWorkspace] = useState<EmployeeWorkspace | null>(null);
  const [management, setManagement] = useState<ManagementWorkspace | null>(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [managementLoading, setManagementLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([
      getJson<ApiEnvelope<Me>>('/me'),
      getJson<ApiEnvelope<EmployeeWorkspace>>('/workspace'),
    ]).then(([meResponse, workspaceResponse]) => {
      setMe(meResponse.data);
      setWorkspace(workspaceResponse.data);
    }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'The workspace could not be loaded.');
    }).finally(() => setLoading(false));
  }, []);

  const loadManagement = () => {
    setManagementLoading(true);
    setError(null);
    void getJson<ApiEnvelope<ManagementWorkspace>>('/management')
      .then((response) => setManagement(response.data))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Management data could not be loaded.'))
      .finally(() => setManagementLoading(false));
  };

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const term = query.trim();
    if (term.length < 2) {
      setSearch(null);
      return;
    }
    setError(null);
    void getJson<ApiEnvelope<SearchResponse>>(`/search?q=${encodeURIComponent(term)}`)
      .then((response) => setSearch(response.data))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Search could not be completed.'));
  };

  const markNotification = (notificationId: string, state: 'read' | 'dismiss') => {
    setError(null);
    void postJson(`/notifications/${encodeURIComponent(notificationId)}/${state}`)
      .then(() => {
        setWorkspace((current) => {
          if (current === null) return current;
          const changed = current.notifications.items.find((item) => item.id === notificationId);
          const consumedUnread = changed?.status === 'unread' ? 1 : 0;
          return {
            ...current,
            notifications: {
              ...current.notifications,
              unread_count: Math.max(0, current.notifications.unread_count - consumedUnread),
              items: current.notifications.items.map((item) => item.id === notificationId ? { ...item, status: state === 'dismiss' ? 'dismissed' : 'read', read_at: state === 'read' ? new Date().toISOString() : item.read_at } : item).filter((item) => state === 'read' || item.status !== 'dismissed'),
            },
          };
        });
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Notification state could not be changed.'));
  };

  const transitionWorkItem = (item: WorkItem, toState: string) => {
    const workItemId = item.id;
    if (!workItemId) return;
    setError(null);
    void postJson(`/work-items/${encodeURIComponent(workItemId)}/transition`, { to_state: toState })
      .then(() => setWorkspace((current) => {
        if (current === null) return current;
        const items = current.work.items
          .map((candidate) => candidate.id === workItemId ? { ...candidate, status: toState } : candidate)
          .filter((candidate) => !['completed', 'cancelled', 'expired'].includes(candidate.status));
        return { ...current, work: { items, count: items.length } };
      }))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Work state could not be changed.'));
  };

  const openItems = useMemo(() => workspace?.work.items ?? [], [workspace]);

  if (loading) return <main className="workspace"><div className="panel status">Loading your authorized workspace…</div></main>;

  return (
    <>
      <header className="app-header">
        <a className="app-brand" href="/workspace">The <span>TOEFL</span> House</a>
        <nav aria-label="Primary navigation">
          <a href="/workspace">Workspace</a>
          <a href="/students">Students</a>
          <a href="/teachers">Teachers</a>
          <a href="/crm">CRM</a>
          <a href="/management">Management</a>
          <a href="/academic">Academic</a>
          <a href="/finance">Finance</a>
          <a href="/reporting">Reporting</a>
        </nav>
        <form method="post" action="/logout">
          <input type="hidden" name="_token" value={csrfToken} />
          <button className="sign-out" type="submit">Sign out</button>
        </form>
      </header>
      <main className="workspace" aria-labelledby="workspace-title">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">Employee console</p>
          <h1 id="workspace-title">Good work starts with the next action.</h1>
          <p className="lede">{me ? `Signed in as ${me.display_name}.` : 'Your authorized work and decisions.'}</p>
        </div>
        <button className="button secondary" type="button" onClick={loadManagement} disabled={managementLoading}>
          {managementLoading ? 'Loading…' : 'Open management health'}
        </button>
      </header>

      {error && <div className="alert" role="alert">{error}</div>}

      <form className="search" onSubmit={submitSearch} role="search">
        <label htmlFor="workspace-search">Search visible students and visitors</label>
        <div className="search-row">
          <input id="workspace-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, student code, visitor code, email, or phone" />
          <button className="button" type="submit">Search</button>
        </div>
        {search && <div className="search-results" aria-live="polite">
          <strong>{search.results.length} result{search.results.length === 1 ? '' : 's'}</strong>
          {search.results.length === 0 ? <p className="muted">No matching record in your visible branches.</p> : <ul>
            {search.results.map((result) => <li key={`${result.type}-${result.id}`}><a href={result.route}>{result.label}</a><span>{result.secondary}{result.status ? ` · ${result.status}` : ''}</span></li>)}
          </ul>}
        </div>}
      </form>

      <section className="summary-grid" aria-label="Workspace summary">
        <div className="panel"><span className="metric">{openItems.length}</span><span className="metric-label">Open work items</span></div>
        <div className="panel"><span className="metric">{workspace?.positions.length ?? 0}</span><span className="metric-label">Effective positions</span></div>
        <div className="panel"><span className="metric">{workspace?.scope.branch_ids.length ?? 0}</span><span className="metric-label">Visible branches</span></div>
        <div className="panel"><span className="metric">{workspace?.scope.organization_ids.length ?? 0}</span><span className="metric-label">Authorized organizations</span></div>
      </section>

      <section className="panel" aria-labelledby="notifications-heading">
        <div className="section-heading"><div><p className="eyebrow">Recipient projection</p><h2 id="notifications-heading">Notifications {workspace?.notifications.unread_count ? `· ${workspace.notifications.unread_count} unread` : ''}</h2></div><span className="source-note">Read state is recipient-owned</span></div>
        {(workspace?.notifications.items.length ?? 0) === 0 ? <p className="empty">No active notifications.</p> : <ul className="notification-list">
          {workspace?.notifications.items.map((notification) => <li key={notification.id} className={notification.status === 'unread' ? 'unread' : ''}><div><strong>{notification.title}</strong><small>{notification.source_type} · {notification.source_id}</small></div><div className="notification-actions">{notification.status === 'unread' && <button className="text-button" type="button" onClick={() => markNotification(notification.id, 'read')}>Mark read</button>}<button className="text-button" type="button" onClick={() => markNotification(notification.id, 'dismiss')}>Dismiss</button></div></li>)}
        </ul>}
      </section>

      <section className="panel" aria-labelledby="work-heading">
        <div className="section-heading"><div><p className="eyebrow">Canonical sources</p><h2 id="work-heading">Your work queue</h2></div><span className="source-note">Read projection · mutations stay in owning modules</span></div>
        {openItems.length === 0 ? <p className="empty">No open work was found in your current effective scope.</p> : <ul className="work-list">
          {openItems.map((item, index) => <li key={item.id ?? `${item.source_type}-${item.source_id}-${index}`}><div><span className="kind">{humanize(item.kind)}</span><a href={item.route}>{item.title}</a><small>{item.source_type} · {item.source_id}{item.branch_id ? ` · branch ${item.branch_id}` : item.organization_id ? ` · organization ${item.organization_id}` : ''}</small></div><div className="work-actions"><span className={`status-chip ${item.status}`}>{humanize(item.status)}</span>{item.id && item.status === 'open' && <button className="text-button" type="button" onClick={() => transitionWorkItem(item, 'claimed')}>Claim</button>}{item.id && item.status === 'claimed' && <button className="text-button" type="button" onClick={() => transitionWorkItem(item, 'in_progress')}>Start</button>}{item.id && item.status === 'in_progress' && <button className="text-button" type="button" onClick={() => transitionWorkItem(item, 'completed')}>Complete coordination</button>}</div></li>)}
        </ul>}
      </section>

      {management && <section className="panel" aria-labelledby="management-heading"><div className="section-heading"><div><p className="eyebrow">Reporting projections</p><h2 id="management-heading">Management health · {management.scope.type} scope</h2></div><span className="source-note">No dashboard state is written here</span></div><div className="management-grid">{Object.entries(management.counts).map(([key, value]) => <div key={key}><strong>{value}</strong><span>{humanize(key)}</span></div>)}</div><p className="muted">Latest governed reports: {management.latest_reports.length}. Operational values remain source-linked and are not recalculated in the frontend.</p></section>}
    </main>
    </>
  );
}

if (root) {
  const view = root.getAttribute('data-view');
  createRoot(root).render(view === 'academic' ? <AcademicApp getJson={getJson} postJson={postJson} csrfToken={csrfToken} /> : view === 'teachers' ? <TeacherApp getJson={getJson} postJson={postJson} /> : view === 'crm' ? <CrmApp /> : view === 'management' ? <ManagementApp /> : view === 'students' ? <StudentsApp /> : <App />);
}
