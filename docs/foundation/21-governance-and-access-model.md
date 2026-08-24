# Governance, Authority, Scope, and Access Model

**Status:** Foundation model draft

## Authority model

Authority is evaluated as: person/account + effective position + role + permission + scope + resource relationship + action + context. The result is default deny.

| Decision class | Requester | Reviewer/approver | Control |
|---|---|---|---|
| Create campus/branch | General Manager | At least two Owners | approved request required |
| Close/reopen/rename/transfer campus/branch | General Manager | At least two Owners | history preserved |
| Create department/unit | General Manager | At least two Owners | scoped unit |
| Appoint sensitive leadership | General Manager | At least two Owners | includes Heads of Department |
| Organization-wide access | Owner | At least two Owners | no self-approval |
| Campus-wide access | General Manager | At least two Owners | dated assignment |
| Branch-wide access | Branch Manager for own branch; GM for cross-branch request | General Manager or two Owners for cross-branch | explicit expiry |
| Department access | Relevant Head | General Manager | department confirmation |
| Role/permission design | Owner request | business review; two Owners for sensitive increase | conflict review |
| Existing role assignment | Any Owner may assign | assignment must obey scope and conflict controls | effective dates |
| Money request | authorized requester | Finance review + responsible approver | requester cannot self-approve |
| Owner emergency suspension | two unaffected Owners | two unaffected Owners within seven days | time-limited, audited |

## Scope types

Organization, campus, branch, department, program, academic period, financial period, class, student, teacher, employee, financial resource, cash drawer, bank account, document, room, inventory location, report, work queue, and relationship are supported scope concepts. Each scope assignment has a reason, effective period, authority, and audit record.

## Segregation of duties

| Conflict | Required control |
|---|---|
| Requester = approver | reject; independent approver required |
| Initiator = approver = recorder = reconciler | prohibited for financial actions |
| Owner self-assignment of sensitive access | prohibited without independent Owner approval |
| Head evaluates and decides own consequence | HR/General Manager review |
| Branch Manager requests own financial benefit | independent approval |
| System Administrator authorizes own elevation | prohibited |

## Delegation and acting authority

Delegation is explicit, scoped, dated, attributable, and auditable. Acting positions have a named appointing authority, start/end dates, and no authority beyond the stated assignment. Expiry automatically removes derived access. Historical assignments remain reconstructable.

## Agent-decided mechanics

The implementation will use standard policy evaluation, immutable approval history, effective dating, least-privilege projections, automatic expiry, explicit conflict detection, and append-only audit evidence. These are **AGENT-DECIDED DEFAULTS**, reversible at the modeling level, and do not create new TOEFL House policy.
