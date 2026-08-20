# Protocol Conflict Register

Requirement 4 of the governing directive: *where the repository conflicts with the
protocol, the protocol governs and the repository must be corrected.*

This register lists every conflict found between the registered
`docs/MASTER_ENGINEERING_PROTOCOL.md` and the repository. Destructive corrections require
CHECKPOINT (§65) before execution; the owner granted that approval on 2026-08-20
(Decision D-18), so rows may now move from pending to corrected. Each row states its
current status and the evidence for it.

| # | Protocol | Repository state (evidence) | Verdict | Class (§92) | CHECKPOINT |
|---|---|---|---|---|---|
| C-1 | §12, §15, §95, §96 — legacy migrations are not authoritative and must be **removed**; ONE canonical schema; clean rebuild must not depend on historical migrations | Was: 78 forward-only migration files plus a replay-based preflight, and a scaffold column in the schema existing only so migration 003 could run | **CORRECTED** — the chain, the runner and the scaffold are gone. `server/src/db/schema.sql` is the sole authority (111 tables · 228 indexes · 64 triggers), proven object-for-object identical to the fully-migrated shape (403/403), and `npm run preflight:schema` proves it stands alone, is sound, is idempotent and has no rival | REMOVAL + ARCHITECTURE CHANGE | Approved (D-18) |
| C-2 | §14, §104 step 17 — inventory then **remove the legacy active test suite**, rebuild from the domain model | **INVENTORY DONE** (`docs/legacy-test-inventory.md`, 151 files / 1877 declared cases mapped to Work Packages with their asserted behaviour). The suite is deliberately retained as the oracle proving the migration collapse was behaviour-preserving, and is retired per Work Package as each one's replacement lands | **IN PROGRESS** | REMOVAL | Approved (D-18) |
| C-3 | §84, §85 — remove obsolete documentation; do not preserve contradictory historical documents in the active project | Was: 38 dated point-in-time audit narratives in `docs/` plus 22 in an audit-history folder, plus two stale root handoff documents that cited deleted files and a test count off by a factor of five | **CORRECTED** — all removed. The active documentation set is the protocol, the registries, the operations runbook, the legacy test inventory and the WP-07 certification record. Source comments that cited the deleted audits were rewritten to state current intent (§4) | REMOVAL | Approved (D-18) |
| C-4 | §4 — active source contains no historical narrative | **57 occurrences of "legacy" in runtime source** (+42 in tests); 2 "deprecated"; 16 commented-out code lines; 1 "TEMP" | **REPOSITORY WRONG** | REFACTOR | No |
| C-5 | §83 — avoid uncontrolled logging; logs structured where appropriate | **268 `console.log` in runtime source** (+24 in tests), including boot and migration paths | **REPOSITORY WRONG** | REFACTOR | No |
| C-6 | §2 LAW 1 — exactly one authority per concept | **Two protocol documents existed** — the superseded v2 protocol alongside this one | **CORRECTED IN THIS PASS** — v2 removed; `npm run audit:protocol` now fails if it reappears | REMOVAL | No |
| C-7 | §11, §86 — no compatibility layers without a real external requirement | `saving_accounts` table is marked `LEGACY_COMPAT_ONLY` in `schema.sql` and is written by the seeder but not read by runtime finance | **REPOSITORY WRONG** (pending proof under §43) | REMOVAL | YES (schema) |
| C-8 | §22, §2 LAW 1, §47 — one authority and one vocabulary per concept | **CONFIRMED, PROVEN, and corrected in the authorization path.** Two defects were reproduced before being fixed: revocation was a no-op (deleting every `user_roles` row left all 74 permissions, re-granted from `users.role`), and the string column granted superuser (`users.role='owner'` ⇒ `isGlobalOwner` true, every branch readable). `canAccessBranch` also ended in a `users.branch_id` home-branch fallback. Separately the guards spoke a second role vocabulary: 265 legacy role literals across 30 files, translated at runtime through `LEGACY_ROLE_MAP`. All removed — guards now name canonical `roles.code` values, and `RoleCode` is derived from `ROLE_CODES` so a misspelled role is a compile error rather than a guard matching nobody | **PARTIALLY CORRECTED** — nothing in the authorization path reads `users.role`. The column still exists and still seeds the primary assignment at user creation, where `LEGACY_ROLE_MAP` remains as an explicit one-way translation. Removing the column is blocked on retiring the legacy suite (99 files seed users through it) | ARCHITECTURE CHANGE | Approved (D-14) |
| C-9 | §31 — printing is first-class where operationally required | Printing is implemented ad hoc via `window.open` + inline HTML strings in individual panels (e.g. `PnLPanel.tsx`), not through a design-system print layer | **REPOSITORY WRONG** | ARCHITECTURE CHANGE | No |
| C-10 | §24 — a coherent design system must exist before multiplying UI implementations | No design-system module exists; Tailwind utility classes are repeated per component | **REPOSITORY WRONG** | ARCHITECTURE CHANGE | No |
| C-11 | §92 — historical migration files are not required merely because they existed | Was: version-keyed hooks in the migration runner (for the visitor-stage rebuild and the finance-category legacy mapping) servicing only historical migrations | **CORRECTED** — removed with C-1. The finance catalog seed it performed is reached on every install through `ensureOrganizationHierarchy`, so no behaviour was lost | REMOVAL | Approved (D-18) |

## Conflicts deliberately NOT raised

| Item | Why it is not a conflict |
|---|---|
| `git` history contains legacy commits | §5 explicitly forbids destroying history; only the *active* codebase must be clean |
| The WP-07 certification record references the superseded v2 protocol | It is an accurate historical record of a certification performed under v2. It is annotated as requiring re-certification under this protocol rather than rewritten, because rewriting it would be a false claim (§103) |
| `teacher_salary_ledger` / `employee_salary_ledger` table names contain "salary" | Domain-correct names for payroll ledgers, not legacy residue (§47) |
