# Authorization and Scope Architecture

The policy decision point evaluates subject, operation, target, **Position + Assignment + Permission + Scope + Policy**, effective time, delegation, approval state, and conflict-of-interest rules. Position is organizational responsibility; role groups permissions; permission names an operation; scope limits objects; authority is the evaluated result; delegation is dated transfer of specified authority, never identity.

Default deny, server enforcement, least privilege, explicit organization→campus→branch→department hierarchy, expiration checks, two-Owner approval, requester/approver separation, and emergency time limits are mandatory. Scope resolution preserves both current effective visibility and historical attribution. Authorization decisions include policy version and scope evidence for audit. Unavailable policy, expired assignment, conflict, or missing approval denies/holds. Client controls are advisory only.
