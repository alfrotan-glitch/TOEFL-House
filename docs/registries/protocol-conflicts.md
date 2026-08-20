# Protocol Conflict Register

Requirement 4 of the governing directive: *where the repository conflicts with the
protocol, the protocol governs and the repository must be corrected.*

This register lists every conflict found between the registered
`docs/MASTER_ENGINEERING_PROTOCOL.md` and the repository at `a0ddaff`. **Nothing here has
been executed.** Each row is a pending correction; the destructive ones require CHECKPOINT
(§65) before execution.

| # | Protocol | Repository state (evidence) | Verdict | Class (§92) | CHECKPOINT |
|---|---|---|---|---|---|
| C-1 | §12, §15, §95, §96 — legacy migrations are not authoritative and must be **removed**; ONE canonical schema; clean rebuild must not depend on historical migrations | **78 forward-only migration files.** `server/scripts/verify-fresh-schema.mjs` replays all of them against a blank database and is a release-gate step. `schema.sql` currently carries a scaffold column (`budget_lines.is_marketing`) that exists *only* so migration 003 can run | **REPOSITORY WRONG** | REMOVAL + ARCHITECTURE CHANGE | **YES** |
| C-2 | §14, §104 step 17 — inventory then **remove the legacy active test suite**, rebuild from the domain model | **155 test files / 2340 tests**, currently green | **REPOSITORY WRONG** | REMOVAL | **YES** |
| C-3 | §84, §85 — remove obsolete documentation; do not preserve contradictory historical documents in the active project | **40 documents in `docs/` + 22 in `docs/audit-history/`**, almost all dated point-in-time audit narratives (`ADVERSARIAL_AUDIT_2026-08-16.md`, `AUDIT_PASS_2/3`, `RELEASE_CANDIDATE_*`, …) | **REPOSITORY WRONG** | REMOVAL | YES (bulk deletion) |
| C-4 | §4 — active source contains no historical narrative | **57 occurrences of "legacy" in runtime source** (+42 in tests); 2 "deprecated"; 16 commented-out code lines; 1 "TEMP" | **REPOSITORY WRONG** | REFACTOR | No |
| C-5 | §83 — avoid uncontrolled logging; logs structured where appropriate | **268 `console.log` in runtime source** (+24 in tests), including boot and migration paths | **REPOSITORY WRONG** | REFACTOR | No |
| C-6 | §2 LAW 1 — exactly one authority per concept | **Two protocol documents existed** — the superseded v2 protocol alongside this one | **CORRECTED IN THIS PASS** — v2 removed; `npm run audit:protocol` now fails if it reappears | REMOVAL | No |
| C-7 | §11, §86 — no compatibility layers without a real external requirement | `saving_accounts` table is marked `LEGACY_COMPAT_ONLY` in `schema.sql` and is written by the seeder but not read by runtime finance | **REPOSITORY WRONG** (pending proof under §43) | REMOVAL | YES (schema) |
| C-8 | §22 — separate identity · staff · position · role · permission · assignment · scope | `users.role` (a single legacy string column) coexists with the `user_roles`/`roles`/`permissions` tables; `syncLegacyUserRoles()` keeps them aligned | **SUSPECTED DUPLICATE AUTHORITY** — requires WP-02 DISCOVER to confirm | ARCHITECTURE CHANGE | YES (RBAC) |
| C-9 | §31 — printing is first-class where operationally required | Printing is implemented ad hoc via `window.open` + inline HTML strings in individual panels (e.g. `PnLPanel.tsx`), not through a design-system print layer | **REPOSITORY WRONG** | ARCHITECTURE CHANGE | No |
| C-10 | §24 — a coherent design system must exist before multiplying UI implementations | No design-system module exists; Tailwind utility classes are repeated per component | **REPOSITORY WRONG** | ARCHITECTURE CHANGE | No |
| C-11 | §92 — historical migration files are not required merely because they existed | `migrate.ts` contains version-keyed hooks (`026_visitor_stages_expand`, `078_finance_category_legacy_mapping`) that exist only to service historical migrations | **REPOSITORY WRONG** — falls out with C-1 | REMOVAL | With C-1 |

## Conflicts deliberately NOT raised

| Item | Why it is not a conflict |
|---|---|
| `git` history contains legacy commits | §5 explicitly forbids destroying history; only the *active* codebase must be clean |
| The WP-07 certification record references the superseded v2 protocol | It is an accurate historical record of a certification performed under v2. It is annotated as requiring re-certification under this protocol rather than rewritten, because rewriting it would be a false claim (§103) |
| `teacher_salary_ledger` / `employee_salary_ledger` table names contain "salary" | Domain-correct names for payroll ledgers, not legacy residue (§47) |
