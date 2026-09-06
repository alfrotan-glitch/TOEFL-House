# Teacher / Faculty authority architecture

Status: static convergence target, 2026-09-06. This document records the canonical boundary implemented by the Teacher authority changes in this checkout. It is not a production-readiness claim; runtime, database, migration, browser, queue, integration, and automated verification remain deferred by instruction.

## 1. Boundary decision

Teacher is a capability and academic-delivery authority, not a second identity or HR system.

| Fact | Sole write authority | Teacher consumes | Required proof
|---|---|---|---|
| Human identity, legal name, verification | Identity / Person | Person identity | verified Person for activation and assignment
| Employment, contracts, status, leave | HR | Employment, status history, approved leave | active effective employment and no approved leave on the academic date
| Position / access grants | Access | capability decision and structure scope | explicit server-side capability; position title alone is never enough
| Teacher profile and lifecycle | Teacher | verified Person and active Employment | pending → active → suspended/retired, with approval and audit
| Teacher qualification | Teacher | evidence reference and independent reviewer | verified qualification effective on the date
| Teacher branch provenance | Teacher | Organization branch/campus topology | effective active branch authorization with reason and approver
| Subject/course authority | Teacher | Academic Skill catalog | effective `teach`, `assess`, or `moderate` authority plus evidence
| Availability | Teacher | branch and timetable dates | effective weekly window; approved HR leave overrides availability
| Class, offering, period, session | Academic / Classes | Teacher authority | class/period lifecycle remains Academic-owned
| Teacher assignment | Teacher domain command surface, using Academic class facts | class, period, branch, profile, qualification, leave | effective profile, branch provenance, period containment, no forbidden overlap
| Enrollment and attendance | Academic | teacher assignment for teacher actions | same class/session/enrollment, branch, assignment date, idempotency
| Assessment evidence/result chain | Academic | teacher assignment and subject authority for teacher scoring | assignment-aware submit/score; moderation/approval independence
| Teaching delivery/payroll evidence | Payroll derived fact | immutable session, assignment-skill, attendance, Teacher capability | no identity-only claim; Finance remains monetary authority
| Audit and attempted operations | Audit | all commands and denial context | correlation, actor, before/after, scope and evidence references

Academic remains authoritative for class, offering, session, enrollment, attendance, assessment, result, certificate, transcript, and progression lifecycle. Teacher does not copy or mutate those aggregates.

## 2. Canonical Teacher records

The consolidated pre-production Teacher authority migration introduces:

- `teacher_profiles`: one profile per Person and Employment, with `pending`, `active`, `suspended`, and `retired` states. Activation requires verified identity, active employment, a current verified qualification, effective branch provenance, and an independent approver. `teacher_profile_statuses` retains append-only lifecycle history.
- `teacher_profile_branches`: effective branch authorizations with provenance reason and approver. This supports campus/branch transfers without changing historical assignment snapshots.
- `teacher_qualifications`: independently evidenced records with issuer, validity, verification actor/time, and append-only lifecycle semantics.
- `teacher_skill_authorities`: effective subject/course authority by Academic Skill and authority kind (`teach`, `assess`, `moderate`). Assignment-skill attribution is delivery evidence and is not a substitute for this authority.
- `teacher_availabilities`: effective weekly availability in a branch. New session scheduling requires a covering availability window and rejects timetable collisions.
- `teacher_workload_limits`: effective weekly hour ceilings by profile and branch. Timetable admission sums the teacher's governed sessions for the academic week before accepting a new session.
- `teacher_assignments` provenance and lifecycle columns: `teacher_profile_id`, class-matching branch, campus, organization, assigning actor, reason, and `planned`/`active`/`ended`/`cancelled` state. Historical legacy rows remain identifiable for remediation; newly written assignments require canonical profile and provenance.

## 3. Lifecycle and workflow rules

### Profile intake and activation

1. Identity verifies the Person.
2. HR opens and hires the Employment under its existing lifecycle and contract rules.
3. Teacher registers a pending profile against that exact Employment and Person.
4. Teacher records qualification evidence.
5. An independent teacher approver verifies each qualification.
6. An approver activates the profile only after current qualification, active employment, verified identity, and effective branch authorization are present.
7. Suspension or retirement is an explicit audited transition. It does not rewrite assignment history; delivery and teacher actions fail closed while the profile is inactive.

### Assignment

The canonical assignment path is `MaintainTeacherAssignment`. The Academic Classes transport and older Blade routes are compatibility façades only; all policy resolves through `TeacherAuthority` before the assignment row is written. It requires:

- schedule capability on the class branch;
- verified Person and active Teacher profile;
- active effective Employment and latest effective status;
- no approved leave overlap;
- current verified qualification;
- effective Teacher branch authorization matching the class branch;
- `effective_from`/`effective_to` inside the class academic period;
- one non-overlapping assignment window for the class/person;
- server-derived class/campus/organization provenance.

Handover ends the outgoing row and creates a separately audited incoming row after the successor passes the same checks. End and extension are dated mutations with reasons; deletion is never a lifecycle operation. HR termination ends assignments covering the termination date and explicitly cancels future-effective assignments, so a stale future row cannot block replacement or appear deliverable.

### Delivery, attendance, and assessment

- A new session requires an effective canonical assignment, active employment/profile, class branch match, attributed assignment skill plus effective teach authority when a skill is present, availability, no approved leave, and no overlapping session for the same teacher.
- Attendance resolves the session's authoritative class and scheduled date. A Teacher-profile actor must have an effective assignment to that class; an explicit governance actor must pass the server capability path. Enrollment/class/session matching and append-only correction rules remain Academic-owned.
- Assessment attempt submission and scoring use the same Teacher assignment plus effective `assess` subject authority for Teacher-profile actors; an assignment skill must be attributed before teacher assessment evidence is accepted. Moderation, approval, release, and correction independence remain Academic result-chain rules; no frontend state promotes a result.
- Gradesheet reads use the canonical profile and effective assignment, including a distinct read-only historical window for ended assignments while the academic term remains open.

### Leave, inactivity, and transfers

HR remains the only writer of leave and employment state. Teacher assignment/session policy consumes the employment status effective on the academic date and rejects delivery on approved leave, suspended/on-leave/terminated employment, or inactive Teacher profile. Future-effective termination is represented by the append-only HR status date; current assignments end at that date and future assignments are cancelled, so pre-termination academic evidence remains date-valid without treating the current aggregate label as historical truth. HR termination orchestration calls the Teacher-owned assignment command to end current delivery assignments and cancel future-effective assignments with Teacher audit evidence; incomplete legacy rows remain non-deliverable remediation candidates. A branch transfer closes the previous current-home authorization, opens a dated destination authorization, updates current provenance, and refuses transfer while incompatible open assignments remain; an explicit handover or end operation is required.

## 4. Database and concurrency invariants

The additive migrations add database final guards for:

- profile state, identity/employment/qualification prerequisites, verified-evidence provenance, active branch topology, approved subject authority, and non-overlapping effective branch/skill authority windows;
- assignment-to-profile/person consistency, non-overlapping class/person assignment windows, class branch and academic-period containment, effective branch authorization, approved leave conflict, campus/organization provenance, and legacy-row remediation boundaries;
- session delivery requiring an effective canonical assignment, subject authority, availability, and no overlapping teacher sessions;
- an active class requiring an effective canonical teacher assignment;
- assignment lifecycle state preventing cancelled future rows from satisfying active-class, session, assessment, or payroll delivery guards, with assignment-skill inserts requiring effective teach authority across the full assignment window;
- a database workload trigger that serializes weekly candidate-teacher admission and enforces the effective workload ceiling for direct SQL/concurrent session writes;
- payroll teaching-delivery evidence requiring canonical profile, assignment, assignment-skill, and effective subject authority in addition to existing session, attendance, duration, and period guards;
- terminal qualification evidence, profile identity/provenance, branch/skill authority identity, availability identity, workload identity, and canonical assignment identity guards; legal lifecycle transitions are explicit and terminal authority states cannot be reopened;
- deferred profile lifecycle-history enforcement: profile registration and every subsequent lifecycle transition must settle with matching append-only status evidence, while direct history UPDATE/DELETE is rejected.

All application mutation paths retain transaction locks, idempotency keys, audit events, and attempted-operation denial records. The database remains the race arbiter for direct SQL and concurrent writers. Assignment and authority `effective_to` dates are exclusive across the new Teacher policy (an assignment covering the final period day ends on the following date); payroll derivation was corrected to use the same exclusive boundary.

## 5. Transport and workspace

`/teachers` is the React Teacher/Faculty workspace. `/api/v1/teachers/workspace` returns only server-derived profiles within the actor's own profile or effective `academic.teacher_manage` branch scope. It exposes lifecycle, employment state, qualifications, subject authority, branch provenance, availability, assignment history, and approval capability as facts; it does not invent transitions or permission state.

Teacher mutation endpoints validate transport shape only and delegate to canonical Teacher commands, including `MaintainTeacherAssignment` for assignment lifecycle and attribution. The workspace is therefore an orchestration/projection surface, not a second business authority.

## 6. Legacy and remediation boundary

Existing assignment rows without `teacher_profile_id` or stored branch snapshot are not silently backfilled. They remain historical evidence and can be ended through the compatibility path, but they cannot be used to create new canonical assignments, new subject attribution, canonical teacher workspace authority, new sessions, or payroll delivery claims. A controlled remediation workflow must establish the missing profile, qualification, branch authorization, and provenance before any legacy relationship is reopened or replaced.

No identity, job title, employment label, current position, browser state, client-supplied capability, or stale assignment object can independently confer authority.

## 7. Deferred verification and residual risks

The following were intentionally not run: PHP, Composer, PostgreSQL, migrations, PHPUnit, PHPStan, Pint, Node, builds, browser validation, queues, integrations, and runtime checks. Consequently this static convergence does not prove compilation, dependency resolution, migration application order, trigger behavior against live data, route registration, frontend rendering, or performance.

Residual risks requiring runtime verification include migration compatibility with any already-materialized pre-production data, PostgreSQL trigger ordering, query plans for timetable/payroll checks, generated frontend type/build compatibility, and assignment remediation UX. These risks are explicitly deferred rather than represented as resolved.
