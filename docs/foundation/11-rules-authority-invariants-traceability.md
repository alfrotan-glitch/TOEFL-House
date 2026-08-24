# Rules, Authority, Invariants, and Traceability — Foundation Draft

## Business-rule registry

| Rule ID | Rule | Authority | Enforcement | Audit | Test | Status |
|---|---|---|---|---|---|---|
| BR-ORG-001 | Structural changes require operation-specific authority through an approval matrix. | O-10 | To be defined after matrix decisions | Required | Planned | OPEN |
| BR-ORG-002 | Campus and branch creation is prepared by the General Manager and requires approval from at least two Owners before creation. | O-35 | Approval workflow | Required | Planned | DECIDED |
| BR-ORG-003 | Permanent campus or branch closure is prepared by the General Manager and requires approval from at least two Owners. | O-36 | Approval workflow | Required | Planned | DECIDED |
| BR-ORG-004 | Reopening a closed campus or branch is prepared by the General Manager and requires approval from at least two Owners. | O-37 | Approval workflow | Required | Planned | DECIDED |
| BR-ORG-005 | Transferring a branch between campuses is prepared by the General Manager and requires approval from at least two Owners. | O-38 | Approval workflow | Required | Planned | DECIDED |
| BR-ORG-006 | A branch transfer changes current operational visibility from its effective date but never rewrites historical campus, branch, date, or attribution. | C-F-001 | Historical record policy | Required | Planned | DECIDED |
| BR-ORG-007 | An official campus or branch name change is prepared by the General Manager and requires approval from at least two Owners. | O-40 | Approval workflow | Required | Planned | DECIDED |
| BR-ACCESS-001 | Sensitive action affecting another Owner requires at least two Owner approvals. | O-19 | To be defined in authorization/approval design | Required | Planned | DECIDED |
| BR-ACCESS-002 | Emergency Owner suspension, if allowed, must be time-limited, audited, and reviewed afterward. | O-19 | To be defined | Required | Planned | OPEN |
| BR-ACCESS-003 | Approval thresholds vary by action type, amount, risk, scope, or consequence; unknown thresholds must fail closed. | O-20 | To be defined | Required | Planned | DECIDED / THRESHOLDS OPEN |
| BR-FIN-001 | A Branch Manager may request eligible routine financial actions but must not approve their own request. | O-48 | Approval workflow | Required | Planned | DECIDED |
| BR-SCOPE-001 | Scope assignment authority differs by scope type and is controlled by an explicit matrix. | O-23 | To be defined | Required | Planned | DECIDED / ROWS OPEN |

## Source-of-truth registry

| Concept | Owner | Authoritative record | Readers | Writers | Forbidden duplicate | Test | Status |
|---|---|---|---|---|---|---|---|
| Structural approval authority | Organization/Access governance | Structural approval matrix | Organization, security, audit | Authorized governance process | Per-route permission guesses | Planned | OPEN |
| Campus/branch creation approval | Organization governance | Approved structural change request | Organization, security, audit | General Manager request + two Owners approval | Direct creation bypass | Planned | DECIDED |
| Owner-sensitive approval | Access governance | Owner-sensitive approval policy and approval records | Security, audit, affected workflow | Authorized Owners under two-Owner rule | Single-owner bypass | Planned | DECIDED |
| Scope assignment authority | Access governance | Scope-assignment authority matrix | Identity, authorization, workspaces | Authorized scope administrators | Position-title-only grants | Planned | OPEN |
| Workspace priority | Workspace governance | Workspace priority register | Product/discovery team | Governance decision | Generic dashboard assumptions | Planned | DECIDED PRIORITY |

## Initial invariants

| Invariant ID | Invariant | Purpose | Enforcement layer | Failure scenario | Recovery | Status |
|---|---|---|---|---|---|---|
| INV-ORG-001 | No structural organization change is valid without the authority required for that operation. | Prevents uncontrolled structural mutation. | Application policy + audit; final layer TBD | Unauthorized branch closure | Reject; preserve prior state; audit attempt | OPEN |
| INV-ORG-002 | No campus or branch may be created until the General Manager's request has approval from at least two Owners. | Protects organizational boundary creation. | Approval workflow + audit; final layer TBD | Direct single-user creation | Reject and record denied attempt | DECIDED |
| INV-ORG-003 | No campus or branch may be permanently closed until the General Manager's request has approval from at least two Owners. | Protects historical and organizational continuity. | Approval workflow + audit; final layer TBD | Single-user closure | Reject and preserve active state | DECIDED |
| INV-ORG-004 | No closed campus or branch may be reopened until the General Manager's request has approval from at least two Owners. | Prevents uncontrolled reactivation. | Approval workflow + audit; final layer TBD | Single-user reopening | Reject and preserve closed state | DECIDED |
| INV-ORG-005 | No branch may be transferred between campuses until the General Manager's request has approval from at least two Owners. | Protects reporting and ownership boundaries. | Approval workflow + audit; final layer TBD | Direct transfer | Reject and preserve current campus | DECIDED |
| INV-ORG-006 | A branch transfer must not alter historical campus, branch, date, or attribution on completed records. | Protects historical truth and reporting integrity. | Historical record policy + audit; final layer TBD | Bulk rewrite after transfer | Reject rewrite; preserve original attribution | DECIDED |
| INV-ACCESS-001 | One Owner cannot complete a sensitive action affecting another Owner. | Prevents unilateral Owner abuse. | Authorization + approval workflow; final layer TBD | Single-owner approval attempt | Reject and record denied attempt | DECIDED |
| INV-ACCESS-002 | Emergency suspension cannot remain active beyond its approved time limit without mandatory review. | Prevents permanent emergency bypass. | Workflow + scheduled control; final layer TBD | Review not completed | Escalate, suspend further action, preserve audit | OPEN |
| INV-SCOPE-001 | A scope assignment must be authorized according to its scope type. | Prevents cross-scope escalation. | Authorization + approval workflow; final layer TBD | User grants own organization-wide scope | Reject and audit | OPEN |

## Traceability seeds

| Requirement | Rule | Domain | Entity/record | Permission/scope | Workspace | Test | Acceptance criterion | Status |
|---|---|---|---|---|---|---|---|---|
| REQ-ORG-004 | BR-ORG-001 | Organization governance | Structural change request/approval | Operation-specific scope | Owner/Executive; General Manager | Planned | Every structural operation has an explicit authority path | OPEN |
| REQ-ORG-005 | BR-ORG-002 | Organization governance | Campus/branch creation request | Organization | Owner/Executive; General Manager | Planned | Creation is impossible without GM request and two Owner approvals | DECIDED |
| REQ-ORG-008 | BR-ORG-003 | Organization governance | Campus/branch closure request | Organization/Campus | Owner/Executive; General Manager | Planned | Permanent closure is impossible without GM request and two Owner approvals | DECIDED |
| REQ-ORG-009 | BR-ORG-004 | Organization governance | Campus/branch reopening request | Organization/Campus | Owner/Executive; General Manager | Planned | Reopening is impossible without GM request and two Owner approvals | DECIDED |
| REQ-ORG-006 | BR-ACCESS-001/002 | Access governance | Owner action approval/emergency review | Organization scope | Owner/Executive; System Administration | Planned | Single Owner cannot complete sensitive peer action | OPEN |
| REQ-ORG-007 | BR-ACCESS-003 | Approval governance | Threshold policy | Action/resource scope | Relevant workspace | Planned | No threshold is invented or bypassed | OPEN |
| REQ-ACCESS-001 | BR-SCOPE-001 | Access governance | Scope assignment | Scope-specific | System Administration | Planned | Each scope type has named authority | OPEN |
| REQ-WORK-001 | — | Workspace governance | Workspace priority record | Position scope | All listed workspaces | Planned | Priority order is preserved without implying workflow completion | OPEN |

## Gate 1 traceability finding

The existing seeds are not a complete traceability matrix. Every critical domain still requires business-level links from requirement to rule, entity, authority, scope, workspace, report, notification, acceptance criterion, exception, and recovery. Implementation links remain prohibited until later architecture gates.
