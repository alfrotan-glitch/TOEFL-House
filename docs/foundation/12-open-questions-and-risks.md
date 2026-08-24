# Open Questions and Risks — After Control Update

## Newly resolved

- O-10 resolved: operation-specific structural approval matrix required.
- O-19 resolved: at least two Owners required for sensitive actions affecting another Owner; emergency suspension requires a separate controlled workflow.
- O-20 resolved: risk/value-based thresholds; exact thresholds remain unknown and must be discovered.
- O-23 resolved: differentiated scope-assignment authority matrix required.
- O-25 resolved: workspace priority order accepted as priority only.

## Still open from Batch 01

- O-01 through O-09: organization model, actual campus/branch inventory, department model, and management authority.
- O-11 through O-18: delegation, additional positions, receptionist position semantics, position/role separation, assignment history, individual accounts, access termination, and equal Owner permission details.
- O-21, O-22, O-24: final scope vocabulary, cross-branch rules, and profile projection policy.
- O-26 through O-28: workspace queues/actions and student/parent portal behavior.

## New dependencies created by the latest decisions

- The structural approval matrix requires the actual organization-change operations and management authorities before it can be completed.
- The scope-assignment matrix requires the final scope vocabulary and the authority of each management position.
- Risk/value thresholds require financial policy and risk classification questions later; no amounts are assumed.
- Emergency Owner suspension requires a dedicated security/incident question group after identity and Owner administration are clarified.

## Conflict requiring clarification

- **C-F-001:** O-39 selected moving all historical records to the new campus. This conflicts with the established requirement that critical historical truth must not be silently rewritten. The intended policy may be current reporting visibility rather than rewriting original historical attribution. No implementation or final decision may depend on this unresolved conflict.

## Risks

| ID | Risk | Status |
|---|---|---|
| R-F-009 | Approval matrix cannot be completed before actual management authority is known. | OPEN |
| R-F-010 | Unknown threshold values could permit inconsistent sensitive-action handling. | CONTROLLED: no thresholds invented; fail closed |
| R-F-011 | Scope matrix could be incomplete if additional resource scopes are discovered later. | OPEN; registry is extensible |
| R-F-012 | Workspace ranking could be mistaken for detailed workflow design. | CONTROLLED: explicitly priority-only |
