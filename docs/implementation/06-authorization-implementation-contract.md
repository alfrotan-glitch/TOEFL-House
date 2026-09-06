# Authorization Implementation Contract

The server policy decision receives user/person, Position, Assignment, Role, Permission, Scope, Policy version, target, operation, effective time, delegation, approval, and conflict data. It returns allow/deny/hold with reason and evidence. Default deny. Client checks are convenience only.

Assignments and delegations are effective-dated and automatically expire. Scope resolves Organization→Campus→Branch→Department plus explicit cross-branch assignments. Requester, beneficiary, conflicted actor, and expired delegate are excluded. Two-Owner policies require distinct eligible Owners and atomic approval counting. Emergency authority is limited, audited, expires, and triggers mandatory review. Permission/scope changes are themselves authorized and audited. Tests cover every denial and leakage case.

Employee Workspace composition consumes the effective decision; it cannot grant, cache, or infer authority. It is role-aware but not role-locked for employees with multiple positions. Workspace sections, tasks, approvals, record links, and action affordances are filtered by current employment, assignments, capabilities, delegation, lifecycle, and scope, while every sensitive action is reauthorized at command time.
