# Authorization Implementation Contract

The server policy decision receives user/person, Position, Assignment, Role, Permission, Scope, Policy version, target, operation, effective time, delegation, approval, and conflict data. It returns allow/deny/hold with reason and evidence. Default deny. Client checks are convenience only.

Assignments and delegations are effective-dated and automatically expire. Scope resolves Organization→Campus→Branch→Department plus explicit cross-branch assignments. Requester, beneficiary, conflicted actor, and expired delegate are excluded. Two-Owner policies require distinct eligible Owners and atomic approval counting. Emergency authority is limited, audited, expires, and triggers mandatory review. Permission/scope changes are themselves authorized and audited. Tests cover every denial and leakage case.
