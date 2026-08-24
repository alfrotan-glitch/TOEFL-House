# Lifecycle Transition Registry

**Rule:** No boolean or mutable label substitutes for a business transition. Every transition records actor, authority, scope, effective date, reason, evidence, and audit.

| Entity | States | Allowed transitions | Forbidden/repair |
|---|---|---|---|
| Organization/Campus/Branch/Department | Draft, Active, Suspended, Closed | Draft→Active; Active↔Suspended; Active→Closed; Closed→Reopened→Active | close requires approval; no delete |
| Position Assignment/Delegation | Proposed, Active, Expired, Revoked | Proposed→Active→Expired/Revoked | expired access cannot continue |
| Student/Admission | Prospect, Applicant, Admitted, Active, Suspended, Withdrawn, Completed, Alumni | verified ordered transitions; reactivation only by approval | no silent status overwrite |
| Enrollment/Membership | Requested, Active, Frozen, Transferred, Withdrawn, Completed | requested→active; active→freeze/transfer/withdraw/complete | no duplicate active seat |
| Class/Session | Planned, Published, Active, Cancelled, Completed, Archived | planned→published→active→completed; cancellation preserves record | no attendance on cancelled session without correction |
| Placement/Assessment | Draft, Started, Submitted, Scored, Moderated, Approved, Released, Appealed, Corrected | ordered review and release | score is not decision automatically |
| Progression/Graduation | Proposed, Reviewed, Approved, Rejected, Appealed, Superseded | review→approved/rejected; appeal→new decision | original decision retained |
| Employment/Contract | Candidate, Active, Leave, Suspended, Transferred, Terminated, Settled, Archived | approved employment transitions | payroll cannot invent silent terms |
| Payroll | Draft, Calculated, Reviewed, Approved, Paid, Corrected, Reversed, Locked | ordered period transitions | locked period mutation prohibited |
| Financial Period | Open, Closing, Closed, Reopened | open→closing→closed; closed→reopened only approved | reopen audited |
| Obligation/Payment | Proposed, Posted, Partially Settled, Settled, Cancelled, Reversed | source-controlled posting and settlement | no balance-only change |
| Refund/Discount/Adjustment | Requested, Reviewed, Approved, Posted, Rejected, Reversed | approval before posting; reversal links source | source cannot be deleted |
| Scholarship/Funding | Proposed, Approved, Active, Suspended, Revoked, Completed, Held | agreement and restriction controlled | silent unrestricted conversion prohibited |
| Issuance/Asset/Work Order | Requested, Approved, Issued/In Progress, Returned/Completed, Lost/Disposed/Cancelled | custody and work evidence required | disposal requires approval |
| Document/Consent | Draft, Submitted, Verified, Active, Expired, Revoked, Archived | verification and effective periods | revocation does not erase history |
| Incident/Complaint/Appeal | Open, Assigned, Investigating, Resolved, Rejected, Escalated, Closed | outcome and evidence required | no silent closure |

Terminal states retain history. Corrections append a new fact or decision; reversals point to the original.
