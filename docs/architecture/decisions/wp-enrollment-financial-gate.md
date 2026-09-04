# Enrollment Financial Gate — Architecture Decision (AC3)

Status: Accepted
Date: 2026-09-04
Scope: Server-authoritative Finance gate over Academic enrollment activation,
including payment, discount/waiver, sponsorship/funding, credit, installments,
and approved exceptions.

## Context

The Academic enrollment chain (`MaintainEnrollment::request` →
`::activate`) currently gates only student/class/offering activity and
capacity. The WP-1 gap matrix reports the **enrollment financial gate** as
missing: activation is not financially gated and there is no per-case aid
model. The Master Engineering Contract (§17 PAYMENT GATES) requires:

- any financial gate controlling an enrollment to be **server-authoritative**;
- frontend state to **never** constitute payment authorization;
- legitimate exceptions (scholarship, sponsorship, authorized waiver,
  approved credit, alternative approved settlement) to be backed by
  **explicit evidence and authorization**.

Finance is already the sole authority for money facts (obligations, payments,
allocations, refunds, discounts, restricted-fund allocations, journals) and
all posted facts are immutable or append-only with derived balances. Academic
must consume that authority without duplicating it.

## Decision

A **Finance-owned gate assessment** is computed at enrollment activation from
the authoritative Finance facts for the student. Academic freezes the
resulting evidence on the enrollment row and refuses activation when the gate
is unsatisfied. Academic never writes Finance facts and Finance never writes
Academic facts.

### Financial sources

The gate starts from the student's posted obligations. `uncovered` is the sum
of the Finance-computed `obligationRemaining` across those obligations (which
already nets payment allocations, approved discounts/waivers, and restricted
fund/sponsorship allocations). The following Finance-owned, approved facts
can additionally satisfy the gate:

- **Credit / advance** — a Finance-approved `financial_credits` row for the
  student.
- **Installment plan** — a Finance-approved `enrollment_installment_plans`
  row (alternative approved settlement; the remainder is agreed to be paid in
  installments).
- **Approved exception** — a Finance-approved `financial_gate_exceptions`
  row scoped to the student and, when present, the offering/class, with a
  valid effective window and an explicit reason.

The gate is satisfied when `uncovered` is fully covered by the combination of
those approved facts (or is already zero). An unsatisfied gate blocks the
transition to `active`; `requested` remains a pending seat.

### Boundary contract

- **Finance owns:** obligation/payment/discount/fund truth; credit,
  installment, and exception approval lifecycle; the computation that turns
  those facts into an assessment; the assessment digest/signature.
- **Academic owns:** the enrollment transition and the frozen evidence
  columns it stamps onto the enrollment row.
- **No financial truth is duplicated:** only the assessment evidence (ids and
  amounts, not a second balance ledger) is frozen on the enrollment.

### Historical correctness and auditability

- `enrollments.financial_gate_evidence` stores the exact evidence payload,
  `financial_gate_evidence_sha256` its digest, and `financial_gate_signature`
  a server HMAC over the deterministic canonical payload (same canonicalizer
  and key-derivation discipline as AC1's eligibility snapshot).
- A denied gate is recorded as an append-only `academic.enrollment.financial_gate.denied`
  audit event with the evidence and error code; the underlying enrollment is
  left untouched (`requested`).
- Approved credits, installment plans, and exceptions are immutable after
  approval (database trigger), so re-verification of historical evidence is
  deterministic against the immutable Finance facts.

### Capabilities

Finance gets separate propose/approve capabilities for credits, installment
plans, and gate exceptions (`finance.credit{,_approve}`,
`finance.installment{,_approve}`, `finance.gate_exception{,_approve}`), with
the approver required to differ from the proposer (separation of duty).
Reading/assessing the gate is a Finance query, not a new Authorization.

## Consequences

- Migration `2026_09_04_000134_add_enrollment_financial_gate.php` adds
  `financial_credits`, `enrollment_installment_plans`,
  `financial_gate_exceptions`, and the frozen evidence columns on
  `enrollments`, plus approval-immutability triggers and CHECK constraints.
- New Finance models/commands for credits, installments, and gate exceptions;
  new `FinancialGateEvidence` signer and `FinancialGateQuery` assessor.
- `MaintainEnrollment` consumes the Finance assessment before `active`; it
  stores evidence/signature and records a denied gate audit on rejection.
- A student with no posted obligation has a zero uncovered amount, so
  activation remains possible (nothing is financially required); once any
  obligation is posted it must be covered or explicitly approved before
  activation.
- Tests cover unpaid denial, payment/discount/fund settlement, credit,
  installment, approved exception, approval SoD, evidence immutability, and
  tamper detection.
