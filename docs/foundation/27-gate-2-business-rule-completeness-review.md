# Gate 2 — Business Rule Completeness Review

**Date:** 2026-08-25
**Phase:** Foundation Business Rule Review
**Result:** `PASS WITH NON-BLOCKING OPEN ITEMS`
**Implementation:** Forbidden

## 1. Executive Result

The Foundation contains strong global control principles, especially for ownership, access, segregation of duties, historical truth, financial integrity, and auditability. The five genuine Gate 2 business-rule blockers were resolved through the consolidated blocker set. Remaining gaps are detailed rule-catalog and configuration work, not unresolved TOEFL House policy.

## 2. Rule Coverage Matrix

| Domain | Explicit rules | Authority | Scope | Exceptions | Reversal/history | Testable | Result |
|---|---:|---:|---:|---:|---:|---:|---|
| Ownership/governance | Partial | Partial | Yes | Partial | Yes | Partial | INCOMPLETE |
| Organization | Partial | Partial | Partial | Partial | Yes | Partial | INCOMPLETE |
| Identity/access/scope | Strong global rules | Partial detail | Partial detail | Yes | Yes | Partial | INCOMPLETE |
| People/admissions/students | Partial | Partial | Partial | Partial | Partial | Partial | INCOMPLETE |
| Academic structure/delivery | Partial | Partial | Partial | Partial | Yes | Partial | INCOMPLETE |
| Assessment/progression/completion | Partial | Partial | Partial | Partial | Yes | Partial | INCOMPLETE |
| HR/payroll | Partial | Partial | Partial | Partial | Partial | Partial | INCOMPLETE |
| Finance/student finance | Strong principles | Partial detail | Partial detail | Partial | Yes | Partial | BLOCKED |
| Funding | Partial | Partial | Partial | Partial | Partial | Partial | INCOMPLETE |
| Resources/facilities | Partial | Partial | Partial | Partial | Yes | Partial | INCOMPLETE |
| Privacy/security/documents | Strong principles | Partial detail | Partial detail | Partial | Yes | Partial | INCOMPLETE |
| Reporting/communication/resilience | Partial | Partial | Partial | Partial | Partial | Partial | INCOMPLETE |

## 3. Rule Classification Audit

Classification is conceptually defined, but the registry does not yet classify every rule consistently as USER-DECISION, AGENT-DECIDED-DEFAULT, CONTROL-INVARIANT, OPEN-QUESTION, or LEGACY-EVIDENCE. Several decision-ledger entries are marked DECIDED without the required rule, trigger, postcondition, exception, and test fields.

**Finding:** Registry structure exists; complete rule population does not.

## 4. Rule Consistency Audit

### Resolved conflicts

- Owner self-assignment is controlled by the later consolidated decision.
- Financial self-approval and combined initiation/approval/recording/reconciliation are prohibited.
- Teacher assignment appeal precedence is resolved by the explicit user decision; the earlier agent default is superseded.
- Expense approval is Finance Manager normally, General Manager only as substitute.
- Historical organization attribution remains immutable after transfer.

### Remaining consistency risks

- Earlier rule records and later consolidated decisions must be cross-linked as superseded, not merely described in narrative.
- “Routine,” “material,” “sensitive,” “senior,” and “high-risk” are not uniformly classified.
- Some authority rows say “final layer TBD,” so the rule cannot yet be independently tested.

## 5. Rule Dependency Analysis

Primary dependency chain:

`Organization → Scope → Position → Role → Permission → Workflow Authority → Approval → Financial/Academic Effect → Audit → Reporting`

`Person → Relationship → Student/Employee identity → Admission/Employment → Academic/Payroll/Finance → Access`

`Program → Level → Period → Class → Enrollment → Attendance/Assessment → Progression → Completion`

`Fee policy → Obligation → Payment → Allocation → Refund/Discount → Journal/Ledger → Reconciliation → Reporting`

No circular business dependency was proven, but several dependencies terminate in undefined policy placeholders. Those terminations are the main Gate 2 gaps.

## 6. Authority Rule Audit

Strongly established: two-Owner Owner-sensitive actions, structural creation/closure/reopening/transfer, no self-approval, GM/Finance separation, department and branch scope principles, dated delegation, and emergency review.

Incomplete: exact approver and escalation for many program, period, document, asset, report, and funding actions; appointment categories; emergency exception classes; and the full scope-assignment matrix.

## 7. Scope Rule Audit

Scope vocabulary is broad and appropriate. Assignment, inheritance, revocation, expiration, and cross-scope visibility rules are not fully expressed for financial resources, cash drawers, bank accounts, documents, rooms, inventory locations, reports, work queues, and relationships.

## 8. Financial Rule Audit

### Established controls

- Finance and Accounting own monetary truth.
- Double-entry accounting is required.
- Direct balance editing is prohibited.
- Corrections use controlled transactions.
- Refunds cannot exceed refundable source.
- Discounts cannot silently rewrite history.
- Cash is attributable and reconciled.
- Periods are controlled.
- Financial self-approval and combined incompatible duties are prohibited.
- Completed financial history is reconstructable.

### Incomplete rules

- Refund eligibility conditions are not defined beyond “documented policy conditions.”
- Discount eligibility and revocation behavior are not sufficiently deterministic.
- Payroll advances, deductions, overtime, absence, and correction precedence are incomplete.
- Opening balances, period reopening evidence, and reconciliation exception treatment are incomplete.
- Restricted-fund disbursement and unused-fund treatment depend on agreements without a minimum rule set.

## 9. Academic Rule Audit

Program-specific configuration is authorized, placement exceptions are recorded, and academic history is protected. The minimum required rules for admission, placement equivalence, attendance consequences, grading corrections, progression, repetition, transfer, suspension, withdrawal, completion, and appeals are not yet explicit enough to prevent divergent implementations.

## 10. HR/Payroll Rule Audit

Employment models and basic separation of HR and Finance are established. Contract precedence, pay-period treatment, overtime, deductions, advances, benefits, absence, payroll correction, and termination settlement rules remain incomplete or contract-specific without a minimum common rule.

## 11. Identity/Authorization Rule Audit

Default deny, minimum necessary, explicit scope, dated assignments, cross-branch expiry, no self-approval, and Owner controls are coherent. Detailed rules for role conflicts, system administration execution, relationship access, document access, and access review outcomes remain incomplete.

## 12. Lifecycle Rule Audit

Generic lifecycle patterns exist for student, academic, financial, employee, resources, documents, and exceptions. They do not yet specify all valid and invalid transitions, transition actors, rejection behavior, cancellation, reversal, recovery, and concurrent decision behavior for each material entity.

## 13. Exception Rule Audit

The required exception fields are defined. Qualifying conditions and approvers are not defined consistently. The terms “emergency,” “serious,” “material,” and “high-risk” need a reusable classification rule or explicit configured policy.

## 14. Privacy/Security Rule Audit

Classification and minimum-necessary disclosure are strong. Consent withdrawal, guardian disputes, incident severity, emergency disclosure, document verification, retention exceptions, and external disclosure rules remain incomplete.

## 15. Reporting Rule Audit

Reporting sovereignty is established. The rule registry lacks complete metric definitions, period behavior, scope behavior, reconciliation expectations, and ownership for each mandatory report family.

## 16. Historical Integrity Audit

The global historical-integrity rule is strong and consistent with transfers, corrections, reversals, academic records, financial facts, employment history, and audit records. Domain-specific immutable fields and correction rules remain to be enumerated.

## 17. Rule Testability Audit

An independent auditor could verify the global invariants, but not many domain rules. “According to policy,” “where applicable,” “within limits,” and “program-specific” are not independently testable until the owning policy, version, effective period, and acceptance conditions are identified.

## 18. Ambiguous Rules

- Standard refund eligibility.
- Standard discount eligibility and revocation.
- Minimum academic progression conditions.
- Payroll treatment where contracts do not specify a case.
- Definition of material/high-risk/sensitive actions.
- Approval of scope types not yet populated in the matrix.
- Exception review, appeal, and expiry behavior.

## 19. Missing Rules

- Minimum common rule for refund requests and cancellations.
- Minimum common rule for discount application and reversal.
- Minimum academic rule for an approved result and progression decision.
- Minimum payroll rule for unprovided contract details.
- Minimum restricted-fund rule when an agreement is silent.
- Full rule records for report calculation and reconciliation.
- Full rule records for document verification and disclosure.
- Full rule records for asset custody, loss, damage, and disposal.

## 20. Conflicting Rules

| ID | Conflict | Status |
|---|---|---|
| G2-C-001 | Prior consolidated rule MD-007 prohibits incompatible financial duties, while earlier O-126 allowed a General Manager override. | Resolved by MD-007; earlier record must remain marked superseded. |
| G2-C-002 | Earlier agent temporary-replacement default conflicts with teacher appeal pause. | Resolved by user decision; agent default superseded. |
| G2-C-003 | Decision Ledger history previously contained duplicate identifiers. | Repaired before this review; uniqueness verified. |

## 21. Superseded Rules

- The agent default permitting temporary teacher replacement during an appeal is superseded by O-117.
- The earlier permissive incompatible-financial-power interpretation is superseded by MD-007.
- Any legacy repository rule remains LEGACY-EVIDENCE unless explicitly promoted.

## 22. Agent-Decided Defaults

The following may be safely derived as enterprise mechanics and are not user-policy claims:

- append-only audit evidence;
- explicit approval records;
- effective dating;
- automatic expiry of dated access;
- rejection/cancellation as distinct outcomes;
- controlled reversals rather than destructive edits;
- fail-closed handling of missing policy;
- standard idempotency, concurrency, retry, pagination, search, notification, and recovery mechanics.

Each remains reversible before implementation and must be linked to the affected rule and risk.

## 23. Non-Blocking Open Items

- Future campus/branch names and activation dates.
- Exact legal succession documents before ownership implementation.
- Agreement-specific scholarship/funding terms before configuration.
- Additional compensation contract variations before use.
- Exact numeric thresholds, because the threshold framework is now configurable and fail-closed.
- Technical enforcement choices, which are deferred to later architecture gates.

## 24. Genuine Blocking Decisions — Resolved

The following business-rule decisions are genuinely blocking because two competent implementers could otherwise create materially different outcomes:

1. Standard refund and cancellation eligibility.
2. Standard discount eligibility, expiry, and reversal.
3. Minimum academic rule for an approved progression decision when a program-specific rule is absent.
4. Minimum payroll treatment when a contract does not specify absence, overtime, advances, or deductions.
5. Minimum restricted-fund treatment when an agreement is silent.

These were resolved in the consolidated Gate 2 blocker set. Exact financial amounts remain configurable and were not invented.

## 25. Gate Decision

**PASS WITH NON-BLOCKING OPEN ITEMS**

The Foundation now has deterministic governing rules for the formerly blocking refund, discount, progression, payroll, and restricted-fund cases. Detailed rule catalogs, configuration values, and acceptance cases remain required before implementation authorization. No architecture or implementation work is authorized.

## Required next action

Continue Gate 3 — Domain Model Completeness Review. Expand detailed rule records, lifecycle catalogs, acceptance criteria, and traceability during the remaining Foundation gates.
