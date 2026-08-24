# Legacy System Intelligence Report

**Classification:** Reference evidence only
**Phase:** Foundation / forensic discovery
**Updated:** 2026-08-24

## 1. Executive finding

The checkout is an already implemented ERP-oriented system, not an empty greenfield foundation. It contains a React/Vite client, an Express/TypeScript server, a canonical SQLite schema, domain services, HTTP routes, operational scripts, fixtures, and a large automated test inventory. Under the Absolute Master Directive, this implementation must be inspected as evidence and must not be copied or treated as authoritative.

The report does not certify the legacy system or infer that its behavior is approved business policy.

## 2. Current-state map

| Area | Observed evidence | Forensic interpretation |
|---|---|---|
| Client | `src/App.tsx`, `src/components/`, `src/api/`, `src/contexts/` | React frontend with many operational views and client contracts |
| Server boundary | `server/src/index.ts`, `server/src/routes/` | Express API with route-level middleware and domain calls |
| Domain services | `server/src/core/academic/`, `finance/`, `placement/`, `rbac/`, `payroll/`, `books/`, `funding/`, `reporting/` | Material domains have been implemented, but their final boundaries remain to be rediscovered |
| Persistence | `server/src/db/schema.sql`, `server/src/db/connection.ts` | SQLite is the current implementation database; schema is large and trigger-heavy |
| Identity/access | `server/src/core/rbac/`, `server/src/middleware/auth.ts`, `users`, `roles`, `permissions`, `user_roles` | Existing design attempts multi-position, scoped RBAC/ABAC; must be independently revalidated |
| Organization | `server/src/db/organizationHierarchy.ts`, `branches.routes.ts` | Existing bootstrap includes one organization, one campus, and one default branch; this is not evidence that the business has only one |
| Finance | `server/src/core/finance/`, `server/src/routes/finance.routes.ts`, `invoices.routes.ts`, `payments`-related tests | Existing monetary and ledger behavior is substantial; exact accounting policy remains a discovery question |
| Calendar | `server/src/core/calendar/periods.ts`, `server/src/utils/jalali.ts` | Existing implementation includes Solar Hijri/Gregorian handling; central authority and business semantics require verification |
| Operations | `server/src/core/operations/database-backup.ts`, `docs/OPERATIONS.md` | Existing backup/recovery behavior is documented and tested, but is not automatically approved for the new architecture |
| Test evidence | 216 files under `server/src/tests/` at inspection time | Test count is evidence of exercised behavior, not proof of completeness or certification |
| Documentation | `docs/MASTER_ENGINEERING_PROTOCOL.md`, `docs/certification/`, `docs/work-packages/`, `docs/registries/` | Existing governance records are historical repository evidence; they must be reconciled with the new directive |

## 3. Valid candidate business knowledge to verify

These are leads for discovery, not accepted requirements:

- TOEFL House has organizational concepts including campuses and branches.
- A person may be represented separately from an account and may hold multiple positions.
- Academic delivery includes programs, levels, classes, teachers, enrollments, attendance, examinations, and placement.
- Finance includes fees, invoices, payments, refunds, budgets, expenses, payroll, funding, and reporting concepts.
- The institution uses Solar Hijri business dates while technical storage may use Gregorian/ISO dates.
- Operational users need scoped workspaces and server-enforced access controls.
- Audit, reporting, notifications, backup, and recovery are material concerns.

Each candidate must be promoted only by explicit user decision, verified domain evidence, or approved foundation documentation.

## 4. Observed architectural risks and contradictions

| ID | Finding | Evidence | Status |
|---|---|---|---|
| L-001 | The current checkout violates the directive's Foundation Phase prohibition on production implementation because implementation already exists in the branch. | `src/`, `server/src/`, `server/src/db/schema.sql` | BLOCKING; do not extend it as new production work |
| L-002 | Current persistence is SQLite, while the directive names PostgreSQL as the preferred database and asks for architecture discovery before selection. | `server/package.json`, `better-sqlite3` imports, `schema.sql` | OPEN DECISION |
| L-003 | Current backend is Express/TypeScript, while Laravel is the preferred backend recommendation. | `server/package.json`, `server/src/index.ts` | OPEN DECISION |
| L-004 | Existing documents describe prior decisions, certifications, and implementation outcomes that may conflict with the new directive or may not be user-approved for this session. | `docs/registries/`, `docs/certification/`, `docs/work-packages/` | Must be treated as historical evidence until confirmed |
| L-005 | Existing bootstrap contains a default Kabul campus/main branch and fixed identifiers. This may be seed behavior rather than an institutional policy. | `server/src/db/organizationHierarchy.ts` | OPEN BUSINESS QUESTION |
| L-006 | Existing schema has many cross-domain tables and database triggers. The new system must establish domain ownership and decide which invariants belong in database, application, or both. | `server/src/db/schema.sql` | OPEN ARCHITECTURAL ANALYSIS |
| L-007 | Existing test and certification volume could create false confidence if treated as proof that the directive's newly required domains and traceability are complete. | `server/src/tests/`, `docs/certification/` | CONTROL: no certification by test count |

## 5. Legacy reuse disposition

No legacy code, model, service, route, schema, migration, component, fixture, or test has been approved for reuse by this report. Any future reuse proposal requires a recorded reuse decision with requirement fit, security review, architectural compatibility, and test evidence.

## 6. Next forensic activities

1. Confirm institutional organization and authority facts with the user.
2. Build the organization, ownership, campus, branch, department, position, role, permission, scope, and workspace models.
3. Inventory all actors and material workflows from source without treating route existence as requirement proof.
4. Reconcile existing registries against confirmed decisions.
5. Select target architecture only after critical business decisions are resolved.
