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
| A-9 | Notifications are in scope | **RESOLVED — DECISION** (owner, 2026-08-20) | §9, RBAC, Finance | Owner selected **per-user read state** (D-58): `notification_read_receipts` is the sole read-state authority, so one viewer cannot suppress another viewer's branch alert. Owner also selected **all authorized branches by default** for an organization-scoped Owner (D-59); the endpoint obtains that scope through `resolveBranchScope` rather than a notification-specific authorization rule. The unused `notifications.user_id` target column and shared `notifications.read` flag are removed. `server/src/tests/notifications-authority.test.ts` proves branch isolation, viewer isolation, all-branches owner defaults, idempotency, database uniqueness and cascade behaviour |
| A-10 | The BOS profit-withdrawal tiers and the six-month reserve multiple are business policy, not placeholders | **STRUCTURALLY RESOLVED — VALUES STILL UNCONFIRMED** | Finance | The LAW 7 violation was the *hiddenness*, and that is fixed: the tiers, the reserve multiple and the warning thresholds are declared in `server/src/core/configuration/policy-catalog.ts` as `TREASURY_DEFAULTS`, at exactly the values the route already applied, and pinned by tests. The rule now has one authority (`server/src/core/finance/profit-distribution.ts`) and one enforcement point. What remains open is narrower and is a genuine owner question: whether 20%/15%/10% and six months are the *correct* numbers. That is no longer a hidden constant but a visible, named, reviewable default |

**Blocking status:** CLEARED 2026-08-20. Every STOP condition raised above (A-2, A-3,
A-4, A-5, A-8 and A-9) was answered by explicit owner decision and recorded in the
Decision Log. A-10 remains structurally resolved with its numeric treasury-policy values
unconfirmed; it must be answered before WP-07 re-certification.

New items raised by the canonical database reconstruction:

| # | Statement | Class | Affects | Basis / why unresolved |
|---|---|---|---|---|
| A-11 | The system needs no automated database backup mechanism | **UNKNOWN** | Operations, §50 | Removing the migration runner removed `backupBeforeMigrations()`, which was the only automatic snapshot in the product. Backups are an operational policy question, not one derivable from code. Non-blocking for the foundation; must be answered before operational readiness is certified |
