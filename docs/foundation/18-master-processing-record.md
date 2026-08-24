# Master Business Decisions — Processing Record

**Processed:** 2026-08-24
**Authority:** Consolidated user-authorized defaults
**Phase:** Foundation Discovery
**Implementation:** Forbidden

## Processing result

The consolidated decision set has been reconciled against the Foundation decision ledger. Decisions were generalized into reusable policies rather than duplicated per workflow. No technical implementation decision was escalated unnecessarily.

## Precedence and conflict resolution

1. The consolidated user-authorized decisions supersede earlier recommendations where they differ.
2. Earlier explicit user decisions remain authoritative where the consolidated set does not replace them.
3. Agent defaults are used only for ordinary mechanics and never override user policy.
4. Unknown thresholds and policy details remain unknown; no amount, legal rule, or institutional fact was invented.

### Resolved conflicts

- The earlier self-assignment ambiguity is resolved by MD-006: an Owner cannot independently assign a sensitive or organization-wide privilege to themselves.
- The earlier permission-combination exception is resolved by MD-007: one person must never initiate, approve, record, and reconcile the same financial transaction. The earlier permissive answer is superseded.
- The earlier teacher-access conflict is resolved by O-117 and MD-026-related policy: the reassignment appeal pauses reassignment. The agent default allowing a temporary replacement is superseded by the user decision; no replacement may be assumed without a later explicit policy decision.
- Historical branch transfer attribution is preserved: current visibility may change, but historical campus, branch, date, and attribution remain immutable.

## Classification

- **USER-DECIDED:** TOEFL House-specific ownership, authority, organization, academic, HR, finance, scholarship, privacy, communication, reporting, recovery, and operational policies in the consolidated questionnaire and earlier confirmed records.
- **AGENT-DECIDED / RECOMMENDED-DEFAULT:** ordinary mechanics such as audit structure, effective dating, approval-record structure, controlled corrections, default-deny enforcement mechanics, and standard lifecycle handling.
- **NON-BLOCKING UNKNOWN:** exact future campus/branch inventory, legal succession document details, exact scholarship agreements, and exact contract variations where the policy already requires configurable or agreement-specific handling.
- **BLOCKED:** none identified for Foundation business discovery at this point.

## Coverage determination

Business-policy coverage now exists for organization and ownership, positions and roles, permissions and scopes, people, admissions, students, academic policy, classes, teachers, HR, payroll direction, finance/accounting direction, fees, scholarships, sponsorship/funding, books, assets, facilities, security, testing, marketing, events, communication, documents, reporting, calendar policy, audit governance, configuration, integrations, import/export, recovery, privacy, and exceptional decisions.

This is a business-discovery completion statement only. It is not Foundation Certification and does not authorize implementation.

## Residual open items

| ID | Item | Classification | Blocking? |
|---|---|---|---|
| OPEN-01 | Future campus and branch official names, locations, and activation dates | UNKNOWN; future operational data | No |
| OPEN-02 | Exact legal ownership succession agreement | UNKNOWN; legal artifact | No for modeling; must be supplied before ownership implementation |
| OPEN-03 | Specific scholarship/funding agreements | UNKNOWN; agreement-specific | No for generic model; required before each agreement is configured |
| OPEN-04 | Additional compensation contract variations | UNKNOWN; contract-specific | No for generic model; required before each contract type is configured |

## Gate disposition

**Foundation Business Discovery:** `COMPLETE — residual non-blocking unknowns recorded`

**Gate 0:** `READY FOR FOUNDATION MODELING / GATE REVIEW`

**Production implementation:** `FORBIDDEN until Gates 1–16 are independently evidenced and Foundation Certification is approved.`
