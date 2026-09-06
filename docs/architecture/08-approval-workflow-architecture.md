# Approval Workflow Architecture

A reusable approval record contains subject operation, target, policy version, required stages/independent approvers, requester, scope, effective/expiry times, state, decision reason, and immutable actions. Templates express one-person, sequential, independent, two-Owner, delegated, and emergency patterns; business modules select approved policy rather than embedding generic engine meaning.

The engine excludes requester, beneficiary, conflicted actor, expired/delegated actor, and unauthorized scope. Concurrent approvals use a compare-and-commit rule so required approval is counted once. Rejection, cancellation, expiry, and resubmission create immutable actions and a new attempt where required. Approval completion is not posting: the owning domain revalidates state and invariant before its transaction. Audit records every action and relationship.
