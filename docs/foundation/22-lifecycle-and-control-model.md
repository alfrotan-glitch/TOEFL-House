# Lifecycle and Control Model

**Status:** Foundation model draft

## Universal lifecycle pattern

`Draft → Submitted → Under Review → Approved | Rejected | Cancelled → Effective → Superseded | Reversed | Archived`

Not every domain uses every state. No transition is implicit. Each transition has actor, authority, scope, reason, timestamp, side effects, audit, and recovery behavior.

## Student lifecycle

`Prospect → Applicant → Admitted → Enrolled → Active → Deferred/Frozen | Withdrawn | Suspended → Completed → Graduated/Alumni`

Placement, admission approval, enrollment, financial obligations, academic progression, withdrawal, suspension, reactivation, and completion remain separate facts.

## Academic lifecycle

`Configured → Published → Offered → Class Planned → Active → Completed → Archived`

Published program, level, period, assessment, and result history is not silently rewritten. Corrections create attributable correction history.

## Financial lifecycle

`Proposed → Approved → Posted → Reconciled → Period Closed`

Corrections use reversal/adjustment/refund transactions. Closed periods cannot be silently changed; reopening requires documented authority. Every payment has source, method, allocation, financial posting, and reconciliation evidence.

## Employee lifecycle

`Candidate → Hired → Active → Leave/Suspended → Transferred/Promoted → Terminated → Settled → Archived`

HR owns employment facts; Finance owns financial consequences; access follows effective assignments.

## Resource lifecycle

`Catalogued → Located → Assigned/Custodied → Issued/In Use → Returned/Maintained → Transferred/Disposed`

Loss, damage, disposal, custody, and replacement remain explicit events.

## Document lifecycle

`Draft → Submitted → Verified/Rejected → Versioned → Active → Expired/Archived`

Document download and disclosure always require current authorization; a URL is never authority.

## Exception model

An exception must state: requested rule, reason, requester, approver, affected resource, scope, start/end, financial/academic/security impact, notification, audit, and whether a permanent policy is needed. Unknown critical behavior fails closed.

## Agent-decided workflow mechanics

Approvals, rejections, cancellations, retries, idempotency, concurrency handling, validation, pagination, notifications, audit structure, and recovery mechanics will follow mature enterprise patterns. These are **AGENT-DECIDED DEFAULTS**, reversible before implementation, and are not business policy claims.
