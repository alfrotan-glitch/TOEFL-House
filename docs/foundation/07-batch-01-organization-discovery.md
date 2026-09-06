# Batch 01 — Organization and Access Discovery

**Status:** QUESTIONS ISSUED
**Gate:** Gate 0 — Discovery Initialization
**Authority:** User decision required
**Date:** 2026-08-24

Previously established decisions are not repeated here: TOEFL HOUSE is the institutional system; the hierarchy must support Organization → Campus → Branch → Department/Operational Unit; multiple campuses and branches are required from day one; there are three equal Owners; one person may hold multiple positions; one person may work across authorized scopes; authorization is server-enforced, minimum-necessary, and default-deny; workspaces are role-specific; the system interface and technical identifiers are English; Solar Hijri is the business calendar and Gregorian/ISO is the technical calendar.

## Organization and ownership

### O-01 — Legal and operating organization
**Question:** Should the first release operate one TOEFL House organization, while keeping the structure ready for future separate organizations, or must multiple independent organizations be supported immediately?
**Why it matters:** It determines the highest ownership boundary for people, money, reports, settings, and access.
**Options:** A) One organization now, future-ready structure; B) Multiple independent organizations now; C) Unknown.
**Recommended option:** A, unless separate legal entities already need isolated data.
**User decision:**

### O-02 — Campus definition
**Question:** What should a campus represent in daily operations?
**Why it matters:** A campus can be only a grouping, or it can own staff, departments, resources, reports, and approvals.
**Options:** A) Physical/administrative collection of branches; B) Physical site that may also operate directly; C) Both, depending on configuration; D) Unknown.
**Recommended option:** C, with branches as the normal operating units.
**User decision:**

### O-03 — Current campuses
**Question:** Which campuses exist today, and which are planned? Provide name, city/location, and whether each is active.
**Why it matters:** Names and status affect organization records, reporting, and access scopes.
**Options:** A) Provide the list; B) Only one campus currently; C) Unknown.
**Recommended option:** A.
**User decision:**

### O-04 — Current branches
**Question:** Which branches exist under each campus? Provide branch name, location, manager if known, and active/planned status.
**Why it matters:** Branch is the primary operational and isolation boundary for many academic, reception, staff, and financial activities.
**Options:** A) Provide the list; B) Only one branch currently; C) Unknown.
**Recommended option:** A.
**User decision:**

### O-05 — Branch ownership
**Question:** Should every branch belong to exactly one campus at a time?
**Why it matters:** This controls reporting, access isolation, financial attribution, and historical transfers.
**Options:** A) Yes, exactly one campus; B) A branch may serve multiple campuses; C) Branches can move, but history must be retained; D) Unknown.
**Recommended option:** C with one active campus at a time.
**User decision:**

### O-06 — Branch independence
**Question:** Which policies may differ by branch?
**Why it matters:** It determines configuration scope and prevents accidental organization-wide changes.
**Options:** A) Only operating hours and rooms; B) Academic, fees, staffing, schedules, and operations; C) Nearly all policies, with organization-wide controls for accounting and security; D) Unknown.
**Recommended option:** C.
**User decision:**

## Departments and management

### O-07 — Department list
**Question:** Which departments or operational units exist or are planned? Select all that apply and add missing ones.
**Options:** Academic; Reception/Admissions; Finance/Accounting; HR/Payroll; Marketing/Social Media; Testing/Examinations; Library/Books; Facilities/Cleaning; Security/Guard; IT/System Administration; Other: ____.
**Why it matters:** Departments organize responsibility, reporting, approval authority, and department-scoped access.
**Recommended option:** Include every unit that owns a queue, decision, record, or recurring task.
**User decision:**

### O-08 — Department placement
**Question:** Must every department belong to one branch, or may a department operate across a campus or the whole organization?
**Why it matters:** It defines whether department access can cross branch boundaries.
**Options:** A) Every department is branch-specific; B) Departments may be branch, campus, or organization-wide; C) One department can have several scoped units; D) Unknown.
**Recommended option:** B.
**User decision:**

### O-09 — Management positions
**Question:** Which positions have management authority, and over what scope?
**Options:** Owner; General Manager; Campus Manager; Branch Manager; Head of Department; Academic Manager; Finance Manager; HR Manager; Other: ____.
**Why it matters:** A title alone must not grant access; the system needs explicit responsibility and scope.
**Recommended option:** Name each position and assign organization, campus, branch, or department scope explicitly.
**User decision:**

### O-10 — Authority for organizational changes
**Question:** Who may create, rename, deactivate, transfer, or reopen organizations, campuses, branches, and departments?
**Why it matters:** Structural changes affect every permission, report, record owner, and financial posting.
**Options:** A) Any Owner; B) Owners jointly for structural changes; C) Owner creates, General Manager manages, Owners approve closure; D) Different authority by change type; E) Unknown.
**Recommended option:** D with explicit approval thresholds.
**User decision:**

### O-11 — Acting and delegated authority
**Question:** May a person temporarily act for another position or receive delegated authority?
**Why it matters:** Temporary access must expire, remain auditable, and not become a permanent privilege by accident.
**Options:** A) No delegation; B) Delegation allowed only with start/end dates; C) Delegation allowed without expiry; D) Unknown.
**Recommended option:** B.
**User decision:**

## Positions, roles, and people

### O-12 — Position register completion
**Question:** Confirm whether these are needed now or later: Campus/Branch Manager, Academic Coordinator/Registrar, Admissions Officer, Accountant/Cashier, HR/Payroll Officer, Librarian/Book Custodian, IT Administrator, Auditor, Student, Parent/Guardian, Driver/Transport, Maintenance, and external instructor.
**Why it matters:** Missing positions create missing workspaces, permissions, queues, and accountability.
**Options:** A) Current; B) Planned; C) Not needed; D) Unknown — provide status per item.
**Recommended option:** Provide a status for every item and add missing positions.
**User decision:**

### O-13 — Gendered receptionist titles
**Question:** Are “Male Receptionist” and “Female Receptionist” separate formal positions, or one Receptionist position describing current staffing?
**Why it matters:** Formal gender-based positions would affect staffing, reporting, and access design; staffing characteristics should not accidentally become authorization rules.
**Options:** A) One Receptionist position; B) Separate formal positions; C) One position with optional staffing attributes; D) Unknown.
**Recommended option:** A or C; do not use gender as an access rule.
**User decision:**

### O-14 — Position versus role
**Question:** Should a position describe a person’s job and a role describe the permissions attached to it, allowing one position to use more than one role when necessary?
**Why it matters:** Separating job title from permissions supports least privilege and controlled exceptions.
**Options:** A) Separate position and role; B) Position and role are always identical; C) Unknown.
**Recommended option:** A.
**User decision:**

### O-15 — Multiple positions
**Question:** The directive establishes that one person may hold multiple positions. Must each position assignment have its own scope, start date, end date, supervisor, and approval record?
**Why it matters:** Without assignment history, access cannot be safely removed or explained later.
**Options:** A) Yes, all fields; B) Scope and dates only; C) No assignment history; D) Unknown.
**Recommended option:** A.
**User decision:**

### O-16 — Individual accounts
**Question:** Must every human operator use a personal account, with no shared reception, finance, or manager accounts?
**Why it matters:** Individual accounts are required for trustworthy audit trails and accountability.
**Options:** A) Individual accounts only; B) Shared accounts allowed for low-risk work; C) Shared accounts allowed with operator selection; D) Unknown.
**Recommended option:** A.
**User decision:**

### O-17 — Employment and access end
**Question:** When a person leaves a position or employment, should access stop immediately, at a scheduled time, or after a manager confirms handover?
**Why it matters:** Delayed deactivation creates security risk; immediate deactivation may interrupt handover.
**Options:** A) Immediately; B) Scheduled end time; C) Manager confirmation, with a hard maximum; D) Unknown.
**Recommended option:** C with an automatic hard end date.
**User decision:**

## Owners and sensitive authority

### O-18 — Equal Owner permissions
**Question:** The three Owners are equal. Should each Owner have the same maximum permission set, with restrictions coming only from explicit scope or approval policy?
**Why it matters:** It prevents an accidental primary-owner hierarchy while retaining control over sensitive actions.
**Options:** A) Same maximum permissions; B) Same authority but different operational scopes; C) Different permissions; D) Unknown.
**Recommended option:** A plus explicit approval rules for sensitive actions.
**User decision:**

### O-19 — Owner-to-Owner administration
**Question:** May any Owner create, suspend, reset, or change another Owner’s account and assignments?
**Why it matters:** Owner administration is a high-risk privilege and must have a clear safeguard.
**Options:** A) Any Owner may do so, fully audited; B) Requires two Owners; C) Requires all three Owners; D) Unknown.
**Recommended option:** B for sensitive changes; urgent suspension may be one Owner with later review.
**User decision:**

### O-20 — High-risk approvals
**Question:** Which actions require two-person or multi-Owner approval? Select all that apply: refunds, large discounts, financial adjustments, payroll approval, scholarship approval, sponsorship/funding allocation, bank/cash movement, asset disposal, permission escalation, branch closure, and data export.
**Why it matters:** Approval requirements protect money, access, historical records, and organizational continuity.
**Options:** A) None; B) All listed; C) Only selected actions — list them; D) Thresholds differ by action; E) Unknown.
**Recommended option:** D with explicit thresholds and no self-approval.
**User decision:**

## Permissions and scope

### O-21 — Scope hierarchy
**Question:** Confirm the allowed access scopes: organization, campus, branch, department, program, academic period, financial period, class, student, teacher, employee, financial resource, document, room, inventory location, report, and relationship-based access.
**Why it matters:** Every permission needs a boundary; unscoped access risks cross-branch exposure.
**Options:** A) All listed; B) Remove selected scopes — list them; C) Add scopes — list them; D) Unknown.
**Recommended option:** A, subject to resource-specific authorization.
**User decision:**

### O-22 — Cross-branch access
**Question:** When someone needs to work across branches, should access be granted explicitly for named branches, or should a broad position automatically cover all branches?
**Why it matters:** Broad defaults are a major source of horizontal privilege escalation.
**Options:** A) Named branches only; B) Campus-wide if assigned to a campus; C) Organization-wide only for explicitly approved positions; D) Unknown.
**Recommended option:** A, with narrowly approved organization-wide roles.
**User decision:**

### O-23 — Scope change authority
**Question:** Who may grant, change, or remove a person’s campus, branch, department, class, financial, or resource scope?
**Why it matters:** Scope changes are access changes and require approval, expiry, and audit.
**Options:** A) System Administrator; B) Direct manager; C) HR plus responsible department manager; D) Owners/authorized security administrator; E) Different by scope type; F) Unknown.
**Recommended option:** E.
**User decision:**

### O-24 — Profile projections
**Question:** Confirm that each position receives only the information needed for its work rather than a full person/student/employee profile.
**Why it matters:** Server-side projections reduce privacy exposure and prevent frontend-only hiding.
**Options:** A) Required everywhere; B) Full profiles for managers; C) Full profiles for Owners only; D) Unknown.
**Recommended option:** A, with explicitly approved expanded projections.
**User decision:**

## Workspaces

### O-25 — Workspace priority
**Question:** Rank the first workspaces to design: Owner/Executive, General Manager, Campus/Branch Manager, Reception/Admissions, Finance, Academic Management, Teacher, HR/Payroll, Test Officer, Marketing, Library/Books, Operations/Facilities, Security/Guard, System Administration, Student, Parent/Guardian.
**Why it matters:** Workspace design must follow real daily work, queues, exceptions, and decisions rather than a generic dashboard.
**Options:** A) Provide a ranking; B) All equal; C) Start with the three most urgent; D) Unknown.
**Recommended option:** C, then expand by operational dependency.
**User decision:**

### O-26 — Workspace queues
**Question:** For each of your top three workspaces, what must be visible first: urgent exceptions, approvals waiting for the user, today’s tasks, messages, KPIs, or search?
**Why it matters:** This determines the primary work surface and reduces errors and cognitive load.
**Options:** A) Approvals; B) Exceptions/alerts; C) Today’s task queue; D) KPIs; E) Search; F) Different per workspace — specify.
**Recommended option:** F.
**User decision:**

### O-27 — Workspace actions
**Question:** For each top workspace, list the three actions users perform most often and the three actions they must never be able to perform.
**Why it matters:** Workspaces must make frequent work easy and forbidden actions impossible, not merely hide menu items.
**Options:** A) Provide lists per workspace; B) Use recommended operational defaults; C) Unknown.
**Recommended option:** A.
**User decision:**

### O-28 — Student and parent access
**Question:** Should students and parents/guardians have separate portals, and what may each see or do?
**Why it matters:** Their identity, relationship, privacy, payments, academic information, and communication rights differ.
**Options:** A) Student portal only; B) Parent/guardian portal only; C) Separate portals; D) One portal with relationship-based views; E) No portal initially; F) Unknown.
**Recommended option:** C or D with separate relationship permissions.
**User decision:**

## Required answer format

Please reply using the IDs, for example:

`O-01: A — one organization now, future-ready.`

For list questions, provide the list directly. Unanswered questions remain `UNKNOWN` and block the affected Gate 0 decisions.
