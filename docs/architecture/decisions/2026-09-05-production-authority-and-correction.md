# ADR: Production authority, provenance, lifecycle gates, and financial corrections

**Date:** 2026-09-05  
**Status:** Accepted for implementation; settlement-storage subsection superseded by `2026-09-05-unified-platform-architecture.md`; verification blocked in this workspace  
**Scope:** F-A, F-B, F-C1, F-C2, F-D, F-E, F-H

## Independent validation

The reported findings are related, not six independent controller defects:

- `AccessResolution` resolved active access rows but did not consume the HR
  employment eligibility fact. Suspension and leave therefore left role-derived
  assignments effective, while direct grants and delegations remained usable.
  Termination's best-effort assignment revocation was not a complete authority
  boundary. **F-A confirmed.**
- Organization lifecycle commands changed the structure row, but the policy
  decision point never evaluated the lifecycle of the target branch, campus, or
  organization. An active grant could therefore operate against a closed or
  suspended branch. **F-B confirmed.**
- Academic delivery commands had received a branch resolver, but Students
  commands still called the policy decision point with `null`. `null` means
  "any capability grant" in the canonical resolver. `RecordBranch` also
  intentionally collapsed unknown provenance to that global path, and API
  lists/read checks included null-provenance rows. **F-C1/F-C2 confirmed.**
- Student status was append-only and enrollment activation was guarded, but
  status was not a cross-context operational gate. Attendance/attempt and
  arbitrary Finance obligation routes could continue after withdrawal.
  **F-D confirmed.**
- Posted journals had a reversal path, but obligations, allocations, and the
  rest of the financial source-fact surface did not have a complete,
  source-linked correction instrument. Finance history was immutable, but the
  correction model was incomplete. **F-E confirmed in part.**
- `IdempotentExecution` selected before a row existed, ran the business
  transaction, and inserted the idempotency record after that transaction.
  Two first submissions could race on the unique index, and a crash between
  the business commit and the idempotency insert could repeat a business fact.
  **F-H confirmed.**

## Decisions

### 1. Authorization remains owned by Access

Authorization is still resolved only by `AccessResolution` through the
existing `AccessDecision` port. HR does not grant, revoke, or resolve
capabilities. HR owns employment status; Access consumes it as an eligibility
predicate at the policy decision point:

- a person with no employment record may hold explicitly granted non-employee
  governance authority;
- once a person has an employment record, only the `active` employment state
  is eligible for human authority; candidate, leave, suspended, and terminated
  states fail closed;
- the predicate applies uniformly to position authority, direct grants, and
  delegated authority, so there is no alternate route around employment;
- the existing HR termination cleanup remains useful history/housekeeping, but
  it is not the security boundary.

### 2. Structure lifecycle is an authorization precondition

A scoped operation is allowed only when its entire organization → campus →
branch path is operationally active. The policy decision point enforces this
for every scoped operation, including direct grants and delegation resolution.
Structure lifecycle maintenance is the only explicit exception: its existing
multi-party `StructureDecision` passes a maintenance marker so authorized
owners can close, suspend, and reopen a unit. No ordinary academic, student,
finance, payroll, or API operation receives that exception.

### 3. Unknown provenance is not global scope

`null` is retained only for intentionally branchless governance operations;
`AccessResolution` requires an organization-rooted grant for that path. A
branch-homed target with no resolvable branch is represented as unknown and
fails closed. The shared branch-scoped access adapter is used by Academic and
Students; it resolves branch from locked server-side records and never accepts
actor/client branch claims. Organization-wide grants continue to operate on
known descendants and on explicit branchless governance; they do not turn
unknown operational provenance into a guessed scope.

Admission registration requires an active branch and checks that branch
through canonical Access; admission decisions and applicant conversion use
that persisted provenance rather than the current actor's scope. New Student,
enrollment, and Finance source facts must carry provenance from a verified
linked record. Existing null historical rows are preserved and are
read-only/remediation candidates; they are never silently backfilled.

### 4. Student status is the operational gate; history is not rewritten

Students remains the owner of append-only status. A shared read-side
`StudentOperationalEligibility` predicate is the only cross-context gate:
new delivery facts, waitlist admission, enrollment activation, and new
obligations require current `active` status. Withdrawal does not rewrite old
enrollments, attendance, results, obligations, or payments. Historical
corrections, result release, collection of an existing balance, and refunds
remain possible where their owning lifecycle permits them.

### 5. Payroll and Finance settlement boundary

Payroll may calculate and stage a termination settlement proposal and collect HR and Finance clearance evidence. The recorded settlement is a Finance-owned `employment_settlements` fact, approved through a branch-scoped Finance capability and source-linked to exactly one matching proposed Payroll settlement. The database guard requires terminated employment, both clearance domains, independent preparation/approval identities, beneficiary separation, and known active employee branch provenance. The Payroll `final_settlements` table and model are not part of the target runtime; migration `2026_09_05_000143_consolidate_employment_settlement_authority.php` removes that competing authority.

### 6. Finance corrections are compensating facts

Finance source facts remain immutable. A Finance-owned, staged
`financial_corrections` instrument records a source type/id, signed effect,
reason, requester, independent approver, period, and audit evidence. It may
reduce/increase an obligation or reverse a payment/fund allocation; it cannot edit or
delete a source row and it is counted in derived balances. Journal reversal
also becomes source-linked and one-per-source. This is not an Academic or
Student balance and no other module may post a correction.

### 7. Idempotency is one atomic owner boundary

The idempotency row is claimed, the owner command executes, and the outcome is
stored in one database transaction. The unique key remains the concurrency
arbiter. A losing concurrent transaction retries its read after the winner
commits; same payload returns the winner's outcome, different payload is
rejected. A failed command rolls back both business facts and the idempotency
claim. This applies to every existing command using `IdempotentExecution` and
is not reimplemented per module.

## Consequences and non-decisions

- This deliberately does not create a second RBAC or a Student-owned access
  table.
- Existing audit/history rows are retained. Null historical provenance is not
  fabricated.
- Student withdrawal does not silently cancel financial obligations or erase
  academic history; future operational commands are gated at their owners.
- Financial correction approval is separate from posting and obeys Finance
  period and segregation-of-duties rules.
- The hardened Finance lifecycle migration replaces, rather than layers over,
  the first-pass correction, discount, credit, installment, gate-exception,
  and refund guards. The active schema has one lifecycle authority per fact
  boundary. Because the migration replaces function bodies as well as trigger
  names, its rollback is intentionally one-way until a reviewed baseline is
  produced; a partial rollback must not leave an old trigger name executing a
  hardened body.
- Payroll settlement proposal closure remains a Payroll-owned transition
  requested through `SettlementProposalApproval`; Finance inserts the matching
  immutable settlement fact first in the same transaction. A failed proposal
  closure rolls the Finance fact back rather than leaving an impossible
  recorded-settlement/proposed-proposal state.
- Console and API routes remain adapters over the same commands; no transport
  is permitted to bypass these decisions.
