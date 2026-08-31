# PHASE_3 Checkpoint (in progress) — Employee Coverage Matrix: Module × Capability × Workflow

**Purpose:** prove — not assert — that every employee-facing business capability is reachable through the production HTTP surface (web console and JSON API), delegated to exactly one authoritative command, with authorization, validation, state transitions, error taxonomy, idempotency and audit owned by the domain.

**Method (all machine-derived, no hand-waving):**
- **Capabilities:** the 90 capability strings authorized by `AccessDecision` across `app/Modules` (every command's `decide()` gate is a capability; the union is the authoritative employee-facing capability set).
- **Transport:** `routes/web.php` + `routes/api.php` under the `employee` session guard; a capability is *reachable* iff the command(s) that gate on it are referenced from `app/Http` controllers (the only code that may call commands).
- **Classification:** COMPLETE = reachable and its workflow is proven by HTTP feature tests; PARTIAL = some stages reachable, others not; MISSING = no transport (domain-only); BLOCKED = transport exists but is unusable (none found — the transport is verified pure); NOT-APPLICABLE = not an employee workflow (system-internal jobs, one-time initialization, or closed catalogs) — justified per row below.

## Matrix (90 capabilities)

### COMPLETE (43) — reachable + workflow-proven

| Module | Capability | Command | Transport (web/API) |
|---|---|---|---|
| Admissions | admissions.register / initiate / review / approve | RegisterApplicant, DecideAdmission (staged, 000111), EnrollAdmittedApplicant | web `/students/*` + api `/api/students/*` |
| Academic | academic.schedule | MaintainClass | web `/academic/*` |
| Academic | academic.enroll / enroll_approve | MaintainEnrollment | web `/academic/enrollments*` |
| Academic | academic.progression_propose / review / approve | DecideProgression (staged) | web `/academic/progressions*` |
| Academic | academic.attendance | RecordAttendance | web `/academic/sessions/{id}/attendance` |
| Students | (identity verify) identity.verify | VerifyPerson | web `/identity/people/{id}/verify` + api |
| Identity | identity.admin (password) | SetAccountPassword | web `/identity/accounts/{id}/password` + api |
| Identity | (account linking) | LinkUserAccount | web `/identity/accounts` + api |
| HR | hr.employ / hr.terminate | MaintainEmployment | web `/hr/employ` |
| HR | hr.contract.prepare / hr.contract.approve | MaintainContractVersion | web `/hr/versions/*` |
| Payroll | payroll.period | MaintainPayrollPeriod | web `/payroll/periods*` |
| Payroll | payroll.calculate / payroll.approve | CalculatePayroll, ApprovePayrollResult | web `/payroll/*` |
| Payroll | payroll.clear_hr / clear_finance / settle / settle_approve | SettleEmployment (staged, 000112) | web `/payroll/employments/*`, `/payroll/settlements/*` |
| Finance | finance.period | MaintainFinancialPeriod | web `/finance/periods*` |
| Finance | finance.obligation | PostObligation | web `/finance/obligations` |
| Finance | finance.payment | RecordPayment | web `/finance/payments` + api |
| Finance | finance.refund / refund_approve | RefundPayment (staged, 000110) | web `/finance/refunds*` + api |
| Finance | (allocation) | AllocatePayment | web `/finance/obligations/{id}/allocate` |
| Library | (books) | CirculateBooks | web `/library/*` |
| Academic | academic.assess / moderate / approve_result / release | ManageAssessmentResult (staged correction, 000113) | web `/academic/attempts*`, `/academic/results*`, `/academic/corrections*` |
| Academic | academic.completion / completion_approve / certify | DecideGraduation (staged, pre-existing SoD) | web `/academic/graduations*` + certificate print route |
| Academic | academic.appeal_manage | ManageAcademicAppeal (7 verbs, pre-existing SoD + lifecycle) | web `/academic/appeals*` — file, assign, investigate, resolve, reject, escalate, close |
| Reporting | reporting.run / dashboard | RunReport, MaintainDashboard | web `/reporting/*` |
| Payroll/Finance read | (pay slips, invoices) | Printing (read-only) | web `/print/*` |

### PARTIAL (0) — resolved

| Module | Capability | Exposed | Missing stage | Disposition |
|---|---|---|---|---|
| Identity | identity.admin | SetAccountPassword + `DeactivateUserAccount` (web+api) | ~~deactivation dead~~ — `POST /identity/accounts/{id}/deactivate` added in Increment B; deactivation proven over HTTP incl. login rejection and the terminal `identity.account_not_active` re-deactivation denial | DONE ✅ — Increment B

### NOT-APPLICABLE (14) — not an employee workflow, justified

| Module | Capabilities | Commands | Justification |
|---|---|---|---|
| Finance | finance.opening.prepare / approve | MaintainOpeningState, ApproveOpeningState | One-time opening snapshot (P15); already executed; no re-run business scenario |
| Integrations | integrations.endpoint / inbound / dispatch / process / review / jobs | RegisterEndpoint, ReceiveInbound, ProcessInbound, DispatchDelivery, ProcessDeliveries, RequeueDelivery, RegisterJob, EnqueueJobRun, ProcessJobRun | System-internal outbox/webhook/job machinery (P17 §2 marked system-only); no employee performs these; absence is not an operational dead end |
| Reporting | reporting.catalog / compute / reconcile | DefineMetric, ComputeProjection, ReconcileMetric | Closed canonical metric catalog (5 metrics — nothing outside it is definable by design); projection rebuild/reconciliation is an operational system function; the employee reporting workflow (run + dashboards) is COMPLETE |

### MISSING (3 rows remaining) — employee workflows with no transport; ordered fix plan (✅ rows completed and kept for provenance)

| Increment | Module | Capability(ies) | Command | Actions | Why it is an operational dead end |
|---|---|---|---|---|---|
| A ✅ | Academic | academic.structure | MaintainAcademicStructure | defineProgram, publishVersion, definePeriod, transitionPeriod | No program/period ⇒ nothing else on the console can be created; the console advertises these as read-only pills |
| A ✅ | Academic | academic.skill | MaintainSkill | register, retire | Skills drive delivery + payroll evidence; catalog unmanageable through the console |
| A ✅ | HR | hr.contract | MaintainContract | draft, sign, close | **hire() requires a signed active contract** — the hire path is dead past contract-version approval |
| A ✅ | HR | hr.employ (completion) / hr.terminate | MaintainEmployment | hire, placeOnLeave, suspend, reinstate, terminate | Matrix correction: only `employ` was exposed — hire/terminate were dead ends on the certified employ→payroll→settle path; the full employment state machine is now console-operable |
| B ✅ | Students | students.manage / reactivate | TransitionStudentStatus | suspend, withdraw, reactivate, complete, graduate | Student record cannot leave active state through the console (the show view is read-only) |
| B ✅ | HR | hr.leave_request / approve | MaintainLeave | request, decide, cancel | Leave evidence feeds payroll proration; leave is unmanageable through the console |
| B ✅ | Students | students.guardian | MaintainGuardianRelationship | record, verify, revoke | Verified guardian relationships (minimum-field privacy) unmanageable |
| B ✅ | Identity | identity.admin (completion) | DeactivateUserAccount | deactivate | PARTIAL item above |
| C ✅ | Academic | academic.assess / moderate / approve_result / release | ManageAssessmentResult (staged correction, 000113) | submitAttempt, score, moderate, approve, release, proposeCorrection, approveCorrection | COMPLETE — Increment C (part one, `eddb92d`): full evidence chain over HTTP with the staged correction |
| C ✅ | Academic | academic.completion / completion_approve / certify | DecideGraduation | propose, review, approve, reject, issueCertificate | COMPLETE — Increment C (part two, `e503bc7`): decision chain + one-shot certificates over HTTP |
| C ✅ | Academic | academic.appeal_manage | ManageAcademicAppeal | file, assign, investigate, resolve, reject, escalate, close | COMPLETE — Increment C (part three): full lifecycle over HTTP; the original decision-maker (scorer / progression approver) can never review; only the assigned reviewer decides; no silent closure; idempotent filing |
| D ✅ | Finance | finance.journal / chart | PostJournal, MaintainChartOfAccounts | define, post, reverse | COMPLETE — Increment D: chart + balanced journals (with reversals) over HTTP; balance/unknown-account/unknown-source/closed-period rejections proven over HTTP and at the command level |
| D ✅ | Finance | finance.discount / discount_approve | MaintainDiscount | propose, approve | COMPLETE — Increment D: discount lifecycle over HTTP with the distinct-approver SoD and the exceeds-remainder rejection |
| D ✅ | Finance | finance.reconcile / reconcile_approve | RecordReconciliation | observe, approve | COMPLETE — Increment D: one observation per period+subject, variance requires explanation, distinct-approver SoD |
| D ✅ | Finance | finance.fund / fund_allocate | AllocateFunds | establish, allocate | COMPLETE — Increment D: restricted pools + allocations with restriction/pool/line remainder rejections |
| E ✅ | Documents | documents.classify / register / verify / retention | DefineDocumentClassification, RegisterDocument, TransitionDocument, DecideRetention | defineClassification, defineRetentionRule, register, submit, verify, activate, expire, archive, decide | COMPLETE — Increment E (part one): the full evidence-document registry over HTTP — classification + retention rules, registration against a known subject, append-only immutable versions, verification by a distinct employee (uploader of the version under review blocked), rejected resubmits as a new version, terminal archive, and retention decisions that archive a due document under the category's rule |
| E ✅ | Privacy | privacy.define_purpose / consent / disclose / export / approve_bulk_export | DefineConsentPurpose, RecordConsent, TransitionConsent, RecordDisclosure, ExportSubjectData | definePurpose, record, submit, verify, activate, revoke, archive, disclose, export, request, approve, execute | COMPLETE — Increment E (part two): the full privacy surface over HTTP. ExportSubjectData's two-actors-in-one-call bulk approval was RE-STAGED (000114 privacy_export_requests, the 000110–000113 pattern) before exposure: exporter requests, two distinct approver sessions each sign, exporter executes; the boundary re-checks distinctness, one-time approver slots, and the closed state even against direct SQL |
| E ✅ | Resources | resources.asset / dispose_request / dispose_approve; facilities.work / work_approve | MaintainAsset, DisposeAsset, MaintainWorkOrder | register, assignCustody, releaseCustody, request, approve, execute, request, approve, start, complete, cancel | COMPLETE — Increment E (part three): the resources & facilities console. Assets register with unique codes; custody moves retain history with one open custody per asset; disposal was RE-STAGED (000115 asset_disposal_requests, the 000110–000114 pattern) before exposure — a requester session requests, two distinct approver sessions each sign (each also distinct from the requester), and the requesting session executes; the boundary re-checks distinctness, one-time approver slots, and the closed state even against direct SQL. Work orders: request -> independent approval -> in progress -> completed with mandatory evidence, or cancelled |
| E | Access | access.assign_position / define_policy / grant / revoke / delegate / approve_org_wide | AssignPosition, TransitionPositionAssignment, DefineAccessPolicy, GrantScopePermission, RevokeScopePermission, DelegateAuthority, RevokeDelegation | (per signatures) | Access administration (positions, policies, grants, delegations) — the identity console is read-only here |
| E | HR | hr.scale | MaintainScale | (per signatures) | Skill-scale catalog management (compensation) |
| E | Communication | communication.send | SendMessage | send | Employee→subject communication under active consent |

## Rules applied

- One authoritative command per workflow — transports are thin (no model writes, no business logic, no duplicate rules).
- Staged SoD before exposure: any command taking two actors in one call (`correct`) is restaged to the house pattern (session-per-signature) with a schema guard — never exposed with a typed colleague id (the 0c1e28f defect class).
- No speculative features: only capabilities with a real employee business scenario or an operational dead end are added; NOT-APPLICABLE rows above are the exclusion list.
- Every increment: TRACE (signatures + capabilities) → FIX (routes/controller/views) → TEST (HTTP feature tests) → ATTACK (direct-SQL / denial cases where the increment touches guarded invariants) → REGRESSION (full gate) → VERIFY (commit + push + remote-equal).

**Status:** matrix established at `ae0c967`. **Increment A complete** (academic structure + skills + contract lifecycle + full employment state machine; 3 new HTTP tests, 56 assertions; gates phpunit OK 455/2065, phpstan L6 0, pint 460). **Increment B complete** (student status transitions incl. the separate reactivate capability, the full leave lifecycle with SoD + overlap + cancel, guardian record/verify/revoke, account deactivation with login rejection; 4 new HTTP tests, 111 assertions). **Increment C complete** (part one, commit `eddb92d`: assessment chain over HTTP with the staged correction 000113 — `correct` was the last two-actor-in-one-call command; part two, commit `e503bc7`: graduation decision chain + one-shot certificates; part three, this commit: the academic appeal lifecycle — the original decision-maker can never review the appealed subject, only the assigned reviewer can investigate and decide, no silent closure, escalation returns the appeal to re-assignment, filing is idempotent). **Increment D complete** (commit `eaf05c2`: chart of accounts + balanced journals with reversals, the discount lifecycle with SoD, reconciliation observations with SoD, and restricted funding pools — 5 new HTTP tests, 149 assertions). **Increment E (part one) complete** (commit `a80d799`: the evidence-document registry — classifications + retention rules, registration, append-only versions, distinct-employee verification with the uploader barrier, the rejected-version resubmission path, terminal archive, and rule-driven retention decisions; 4 new HTTP tests, 194 assertions). **Increment E (part two) complete** (commit `909927a`: the privacy surface — consent purposes, the consent lifecycle with evidence + revocation scope/effect, disclosures as immutable release evidence, and subject-data exports; the two-actor bulk export was re-staged to the house pattern with 000114 before exposure; 4 new HTTP tests, 128 assertions). **Increment E (part three) complete** (this commit: the resources & facilities console — assets with custody history, staged three-session disposal with 000115, and the facilities work order lifecycle; the legacy two-approvers-in-one-call disposal was re-staged before exposure; 4 new HTTP tests, 182 assertions across both resources classes). Remaining: E (access administration, hr.scale, communication). Target: 0 MISSING, 0 PARTIAL, 0 BLOCKED, 0 duplicate implementations, then the complete gate set and the PHASE_3 certification.
