# Authorization and Scope Architecture Contract

Authorization input is **Position + Assignment + Permission + Scope + Policy**, evaluated with subject, object, operation, effective dates, and conflict rules. Default is deny; position title alone grants nothing.

Required controls: permission catalog owned by Access Governance; organization→campus→branch→department scope hierarchy; explicit cross-branch assignments; dated delegations; expiry enforcement; two-Owner approval for applicable Owner-sensitive actions; separation of requester/reviewer/approver/beneficiary; self-approval prohibition; emergency suspension with time limit, review, and audit.

A branch transfer changes current visibility from its effective date only. Historical records retain their original scope and attribution. Missing policy, expired assignment, scope mismatch, conflict of interest, or unavailable required approval denies or holds the operation. Exact thresholds remain policy/configuration values and are not invented here.
