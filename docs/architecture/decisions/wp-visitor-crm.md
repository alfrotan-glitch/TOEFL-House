# AD-2026-09-04 / WP — Visitor / Lead / CRM Domain

Status: **recorded before implementation** (WP-1 rule 6); user directive `./goal` explicitly authorizes the Visitor build.

## Decision

Build a first-class **Visitor/Lead/CRM domain** inside the **Admissions canonical
domain** (the same canonical authority as `visitor_sources`/`visitor_campaigns`/
`visitor`/`visitor_interaction`/`visitor_followup`/`visitor_conversion`/
`visitor_automation_rule` are assigned there per the canonical domain map).

The CRM module owns the acquisition and lead-conversion pipeline **only**. It
never creates a Person, Applicant, Student, Message, Document, or Money
movement itself. Those entities remain owned by their authoritative modules;
CRM observes and traces them.

## Why

- The Legacy/New acquisition paths existed as separate reception notes and
  spreadsheet leads with duplicated contacts and no audit/identity trace.
- The frozen pipeline is `Visitor → Placement → Recommendation → Registration
  → Payment → Enrollment`. CRM is the entry point of that pipeline and must
  carry provenance, attribution, ownership, follow-up, and conversion evidence
  so every downstream step can be audited back to its source.
- Leads are often anonymous before identity verification. The system must
  support anonymous records without fabricating an identity, and must
  cross-link them only on evidence (Applicant/Student creation).

## Scope

In scope (this domain):

- `visitor_sources` and `visitor_campaigns` — acquisition metadata only.
- `visitors` — the lead record: contact/identity linkage, source/campaign,
  provenance branch, status, rating, interest, assignment.
- `visitor_interactions` — immutable evidence/timeline.
- `visitor_followups` — scheduled next actions, manual or automated.
- `visitor_conversions` — one immutable terminal trace per lead to
  applicant/student/enquiry.
- `visitor_automation_rules` — deterministic follow-up scheduling on
  interaction outcome.
- CRM commands, API endpoints, reporting metrics, and tests.

Not in scope: defining or executing Admissions/Student/Finance/Communication
commands. CRM calls their authoritative command paths and consumes results.

## Boundaries and invariants

1. **CRM never creates People/Applicants/Students.** `RegisterApplicant` and
   `EnrollAdmittedApplicant` create those; CRM records the trace afterwards.
2. **Anonymous leads are first-class.** `person_id` is nullable. No synthetic
   Person is created for a walk-in.
3. **One open lead per verified/linked identity** and **one open lead per
   normalized primary contact** (email, else phone). Partial unique indexes
   enforce this.
4. **Branch provenance is immutable once set** (`origin_branch_id`). The guard
   follows the same semantic as the WP2-DEC-01 operational anchors.
5. **Interactions are append-only** — corrections are new facts.
6. **Conversions are terminal and one per lead.** After conversion the lead is
   read-only pipeline-wise; re-opening is a deliberate, audited revival from
   `lost`, never from `converted/archived`.
7. **Automation is deterministic and in-transaction.** An `interaction_outcome`
   rule creates the same follow-up type an operator would schedule manually.
8. **Authorization** uses the single `AccessDecision` authority plus CRM
   capabilities (`crm.catalog`, `crm.visitor`, `crm.followup`,
   `crm.automation`, `crm.visitor.convert`). A record with branch provenance
   is checked against that branch's structure scope (ancestor grants cover
   descendants).
9. **Audit + idempotency** mirror every other domain command: `AuditRecorder`,
   `AttemptedOperation`, `IdempotentExecution` in every mutating command.
10. **Calendar correctness** — effective dates in CRM use the application
    date; any Shamsi conversion must go through the Calendar Authority, never
    an ad-hoc conversion.
11. **Reporting** registers CRM metrics in the canonical
    `MetricCatalog` with the authoritative academic period; no manual metric
    values exist.
12. **Documents/Search/Communication integration** — a visitor interaction may
    reference a `messages.id` or `documents.id`; the list/search read model
    includes visitor sources/campaigns/status. Document search and
    Communication consent are never bypassed by CRM.

## Authority matrix

| Operation | Capability | Scope |
|---|---|---|
| Define/retire source/campaign | `crm.catalog` | global |
| Capture/update/transition visitor | `crm.visitor` | record provenance branch |
| Record interaction / schedule follow-up | `crm.followup` / `crm.visitor` | record provenance branch |
| Define automation | `crm.automation` | global |
| Record a manual conversion | `crm.visitor.convert` | record provenance branch |
| Automatic Admissions→CRM conversion trace | (Admissions authority) | same as Admissions operation |

## Integration points

- **Identity:** a Visitor can reference a verified/unverified Person; an
  unverified Person alone is not enough to become an Applicant.
- **Admissions:** `RegisterApplicant` records the applicant conversion on the
  lead as a side effect of the same Admissions authority — the CRM trace
  cannot be split from the Admissions transaction.
- **Students:** the visit→student chain is reachable via
  `visitor_conversion` → `applicant_id` → student. Direct student conversion
  is also supported for manual CRM paths.
- **Communication:** interactions can link `message_id`; consent purposes
  remain owned by Communication.
- **Documents:** interactions can link `document_id`.
- **Reporting:** `visitor_capture_count`, `visitor_conversion_count`,
  `visitor_conversion_rate` are registered in `MetricCatalog` grouped by
  academic period, scoped global/branch.
- **Automation:** deterministic follow-up scheduling only.
- **Authorization/Audit:** every command is capability-checked, idempotent,
  and audited; material denials are also recorded.

## Weaknesses intentionally fixed

- Legacy duplicated leads → partial unique active indexes on person/contact.
- No provenance → immutable `origin_branch_id` guard.
- No evidence → append-only interactions with `correlation_id`.
- No owner/due-date discipline → follow-up lifecycle with assignment and
  complete/cancel evidence.
- No automation accountability → rule registry with deterministic action and
  active-state guard.
- No reporting lineage → metrics registered in canonical `MetricCatalog`.
- No CRM↔Admissions traceability → conversion recorder within same
  transaction.
