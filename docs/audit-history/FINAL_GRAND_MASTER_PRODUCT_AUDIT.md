# TOEFL House ERP — Grand Master Product Audit

Date: 2026-08-13

## Scope
Class, Teacher, Student, Visitor/Admissions, Books/Inventory, Academic Control Center, Rule Engine, Finance, Sessions/Attendance, Exams, RBAC, navigation, global search, and cross-module ownership.

## Product principles
- One capability, one owner, one write path, one source of truth.
- UI is convenience; backend/domain services remain authoritative.
- Branch ownership is enforced at every mutation boundary.
- Financial corrections use reversal/void semantics, not destructive deletion.
- Historical records are immutable unless an explicit corrective workflow exists.

## Final hardening in this pass
- Removed dead pipeline metrics state and `/api/pipelines` runtime wiring.
- Removed unused pipeline route module from the release.
- Navigation IDs are statically verified against App routes.
- Sidebar pinned state persists across sessions.
- Last active workspace tab persists locally.
- Global search is keyboard-complete (Arrow/Home/End/Enter/Escape) and exposes accessible dialog/listbox semantics.
- Rule Engine metadata is loaded once per mount, not on every category change.
- Product-integrity audit script is available as `npm run audit:product`.
- Historical audit clutter was removed from the release; one canonical product audit is retained.

## Known production gates
- Backend: `npm ci`, `npm run lint`, `npm test`, `npm run build`.
- Frontend: a root `package-lock.json` is still required for deterministic `npm ci`; the current environment could not generate it without registry access.
- Full semantic TypeScript validation depends on installed project dependencies.
