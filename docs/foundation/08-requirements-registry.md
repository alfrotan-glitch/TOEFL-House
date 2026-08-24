# Foundation Requirements Registry

**Status:** Gate 1 review — blocked pending requirements remediation

| ID | Requirement | Source | Classification | Status |
|---|---|---|---|---|
| REQ-ORG-001 | Support Organization → Campus → Branch → Department/Operational Unit. | Directive | DECIDED requirement | OPEN: details pending |
| REQ-ORG-002 | Support multiple campuses and branches from day one. | Directive | DECIDED requirement | OPEN: policy pending |
| REQ-ORG-003 | Three Owners have equal authority; no artificial primary Owner. | Directive | DECIDED requirement | DECIDED |
| REQ-ORG-004 | Structural changes use an explicit operation-specific approval matrix. | O-10 | AUTHORITATIVE BUSINESS DECISION | OPEN: remaining operation rows pending |
| REQ-ORG-005 | The General Manager prepares creation requests for campuses and branches; at least two Owners must approve before creation. | O-35 | AUTHORITATIVE BUSINESS DECISION | DECIDED |
| REQ-ORG-008 | Permanent campus or branch closure requires a General Manager request and approval from at least two Owners. | O-36 | AUTHORITATIVE BUSINESS DECISION | DECIDED |
| REQ-ORG-009 | Reopening a closed campus or branch requires a General Manager request and approval from at least two Owners. | O-37 | AUTHORITATIVE BUSINESS DECISION | DECIDED |
| REQ-ORG-010 | Transferring a branch between campuses requires a General Manager request and approval from at least two Owners. | O-38 | AUTHORITATIVE BUSINESS DECISION | DECIDED |
| REQ-ORG-011 | After transfer, records may be visible under the new campus for current operations, but historical campus, branch, date, and attribution remain immutable. | C-F-001 | AUTHORITATIVE BUSINESS DECISION | DECIDED |
| REQ-ORG-012 | Every formally established active branch must have a designated Branch Manager for daily operations. | O-43 | AUTHORITATIVE BUSINESS DECISION | DECIDED |
| REQ-ORG-013 | A Branch Manager may manage daily operations and branch-level operating rules within approved limits; those limits must be discovered. | O-45 | AUTHORITATIVE BUSINESS DECISION | OPEN: limits pending |
| REQ-FIN-001 | A Branch Manager may approve routine branch financial actions within formally defined limits; higher-risk or higher-value actions require Finance or Owner approval. | O-46 | AUTHORITATIVE BUSINESS DECISION | OPEN: financial limits pending |
| REQ-FIN-002 | Eligible routine Branch Manager financial actions include expenses, discounts, and refunds, subject to formally defined limits. | O-47 | AUTHORITATIVE BUSINESS DECISION | OPEN: limits and exclusions pending |
| REQ-ORG-014 | Head of Department authority varies by department; each head operates only within the explicitly assigned department scope. | O-76 | AUTHORITATIVE BUSINESS DECISION | OPEN: department scopes pending |
| REQ-ACCESS-004 | Heads of Department may recommend appointments and replacements, but higher authority must approve them. | O-77 | AUTHORITATIVE BUSINESS DECISION | DECIDED |
| REQ-ORG-015 | Heads of Department may change routine duties; changes affecting pay, position, branch, or access require separate approval. | O-78 | AUTHORITATIVE BUSINESS DECISION | OPEN: approval details pending |
| REQ-ACCESS-005 | Every cross-branch Head of Department assignment has an automatic end date and requires renewal. | O-79 | AUTHORITATIVE BUSINESS DECISION | DECIDED |
| REQ-ACCESS-006 | Access outside a department requires responsible-department review and General Manager approval, with stronger Owner rules for sensitive or organization-wide access. | O-80 | AUTHORITATIVE BUSINESS DECISION | DECIDED |
| REQ-ACCESS-007 | A Head of Department may not approve a decision that directly benefits themselves. | O-81 | AUTHORITATIVE BUSINESS DECISION | DECIDED |
| REQ-ORG-006 | Sensitive actions affecting another Owner require at least two Owner approvals. | O-19 | AUTHORITATIVE BUSINESS DECISION | DECIDED |
| REQ-ORG-007 | Sensitive approvals use risk/value/action-based thresholds; exact thresholds must be discovered and never invented. | O-20 | AUTHORITATIVE BUSINESS DECISION | OPEN: thresholds pending |
| REQ-ACCESS-001 | Scope administration uses a differentiated scope-assignment authority matrix. | O-23 | AUTHORITATIVE BUSINESS DECISION | OPEN: authority rows pending |
| REQ-ACCESS-002 | Authorization is server-enforced, default-deny, minimum-necessary, and scope-aware. | Directive | DECIDED requirement | OPEN: business matrix pending |
| REQ-ACCESS-003 | A person may hold multiple positions and work across explicitly authorized scopes. | Directive | DECIDED requirement | OPEN: lifecycle pending |
| REQ-WORK-001 | Workspace design follows the accepted priority order, without treating priority as workflow specification. | O-25 | AUTHORITATIVE BUSINESS DECISION | OPEN: responsibilities pending |

| REQ-ACCESS-008 | HR gives final approval for team-member appointments or replacements recommended by a Head of Department; senior or sensitive positions may require higher approval. | O-82 | AUTHORITATIVE BUSINESS DECISION | OPEN: senior-position rules pending |
| REQ-HR-001 | Pay, allowance, bonus, or compensation changes require HR and Finance review, then General Manager approval; higher-risk cases escalate. | O-83 | AUTHORITATIVE BUSINESS DECISION | OPEN: thresholds pending |
| REQ-ORG-016 | Staff transfers between branches or departments require current and receiving authority review, then General Manager approval. | O-84 | AUTHORITATIVE BUSINESS DECISION | DECIDED |
| REQ-ACCESS-009 | Duty-change access updates require department confirmation and approval by the General Manager or authorized security administrator according to scope. | O-85 | AUTHORITATIVE BUSINESS DECISION | DECIDED |
| REQ-HR-002 | A Head of Department may temporarily remove a team member for an urgent safety, misconduct, or serious operational concern, with documentation and mandatory HR/General Manager review. | O-86 | AUTHORITATIVE BUSINESS DECISION | OPEN: review period pending |
| REQ-ORG-017 | Acting Heads of Department are recommended by the department and appointed by the General Manager for defined start and end dates. | O-87 | AUTHORITATIVE BUSINESS DECISION | DECIDED |

No requirement in this registry authorizes production implementation.

## Gate 1 quality status

The registry is materially incomplete for an implementation contract. See `26-gate-1-requirements-completeness-review.md` for missing acceptance, lifecycle, authority, scope, financial, academic, HR, privacy, reporting, and resilience requirements.

## Gate 1 blocker decisions

| ID | Requirement | Classification | Status |
|---|---|---|---|
| G1-REQ-001 | Approval thresholds are action-specific, configurable, and fail closed when missing. | USER-DECISION | DECIDED |
| G1-REQ-002 | Out-of-policy refunds and discounts require Finance review and General Manager approval; higher-risk cases escalate. | USER-DECISION | DECIDED |
| G1-REQ-003 | Compensation changes, restricted-fund allocations, material asset disposal, and financial-period reopening require at least two Owner approvals. | USER-DECISION | DECIDED |
| G1-REQ-004 | Routine Branch Manager expenses are approved by Finance Manager; General Manager is the only substitute when Finance is unavailable. | G1-C-001 | USER-DECISION | DECIDED |


## Gate 2 business-rule decisions

- G2-REQ-001: Refunds and cancellations require documented conditions, approval, immutable source payment, and Finance recording.
- G2-REQ-002: Discounts require published or separately approved eligibility, dates, audit, and controlled reversal.
- G2-REQ-003: No automatic progression occurs without a program-specific rule; Academic Management must decide.
- G2-REQ-004: Contract-silent payroll entries are held for HR and Finance review.
- G2-REQ-005: Contract-silent restricted funds remain on hold and restricted.

## Gate 3 domain-model requirements

The Gate 3 remediation package establishes explicit requirements that every material money, authority, identity, academic, employment, privacy, historical, reporting, and reconciliation concept has a canonical owner, source record, relationship, lifecycle, authority path, and lineage rule. See artifacts `29`–`40` and the independent disposition in `41`.


## Gate 4 architecture-readiness requirements

The Foundation must translate to architecture through explicit domain boundaries, one authoritative owner per critical fact, authorized mutations, deterministic lifecycles, non-circular contracts, derived-only reporting, configuration isolation, privacy/audit history, and resilience requirements. These are documented in artifacts `42`–`49` and reviewed in `50`.


## Gate 5 architecture implications

Requirements are mapped to owner-bound modules, server authorization, transaction boundaries, financial invariants, append-only history, privacy gates, resilient integration contracts, and future test categories in `docs/architecture/25-architecture-traceability.md`. No business requirement was changed.
