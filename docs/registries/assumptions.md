# Assumption Register

§90 requires explicit separation of FACT · INFERENCE · ASSUMPTION · DECISION · UNKNOWN,
and requires work to STOP when an ASSUMPTION or UNKNOWN affects finance, security, data
integrity, RBAC or a core workflow.

| # | Statement | Class | Affects | Basis / why unresolved |
|---|---|---|---|---|
| A-1 | The system has no production dataset requiring preservation | **DECISION** (owner, recorded) | Everything | Stated explicitly by the owner and repeated in §0. All destructive authority derives from it |
| A-2 | AFN is the only currency the system will ever handle | **RESOLVED — DECISION** (owner, 2026-08-20) | Finance | Owner Q1: "AFN ONLY. No secondary currency or FX support is required." See D-11 |
| A-3 | Money is transacted in whole AFN; sub-unit amounts are not operationally real | **RESOLVED — DECISION** (owner, 2026-08-20) | Finance | Owner Q2: no floating point; one canonical representation enforced system-wide. Superseded by D-12; TR-2 closes with it |
| A-4 | Persian/Dari is **not** a supported UI language; the interface is English-LTR with Persian data | **REFUTED** (owner, 2026-08-20) | UI/UX, §26 scope | Owner Q5: bilingual English + Persian/Dari with first-class LTR/RTL is required. The inference described the repository accurately and the requirement incorrectly. See D-15 |
| A-5 | The report set implemented today is the report set required | **REFUTED** (owner, 2026-08-20) | Reporting | Owner Q3: every §30 report category is required end-to-end; absence from the legacy system is not a reason to omit one. See D-13 |
| A-6 | "Books" means retail sale only, not lending/issuance | **REFUTED** (owner, 2026-08-20) | WP-10 | Owner: implement the complete book issuance/lending domain; issuance is explicitly NOT book sales. See D-16 |
| A-7 | "Diplomas" is satisfied by the existing `certificates` model | **REFUTED** (owner, 2026-08-20) | WP-06 | Owner: diploma/certificate is a complete academic output domain; the canonical model is to be derived from requirements and architecture, not assumed from `certificates`. See D-17 |
| A-8 | Multiple simultaneous positions per user is a real requirement | **RESOLVED — DECISION** (owner, 2026-08-20) | RBAC | Owner Q4: yes, multi-position is real; exactly one canonical RBAC authority; conflicts resolve through an explicit deterministic policy. See D-14 |
| A-9 | Notifications are in scope | **UNKNOWN** | §9 | A `notifications` table and `addNotification()` exist, but §9 lists notifications "where applicable" |
| A-10 | The BOS profit-withdrawal tiers and the six-month reserve multiple are business policy, not placeholders | **ASSUMPTION** | Finance | Hard-coded tier thresholds in `bos.routes.ts` with no stated authority — a §2 LAW 7 ("no magic") violation unless an owner decision backs the numbers |

**Blocking status:** CLEARED 2026-08-20. Every STOP condition raised above (A-2, A-3,
A-5, A-8, and the scope-defining A-4) was answered by explicit owner decision, recorded
in the Decision Log as D-11 … D-18. A-9 and A-10 remain open but are non-blocking:
neither gates the canonical foundation currently being built. They must be resolved
before WP-11 (Reporting) and WP-07 re-certification respectively.

New items raised by the canonical database reconstruction:

| # | Statement | Class | Affects | Basis / why unresolved |
|---|---|---|---|---|
| A-11 | The system needs no automated database backup mechanism | **UNKNOWN** | Operations, §50 | Removing the migration runner removed `backupBeforeMigrations()`, which was the only automatic snapshot in the product. Backups are an operational policy question, not one derivable from code. Non-blocking for the foundation; must be answered before operational readiness is certified |
