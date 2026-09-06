# ADR: Work Management coordinates; domains decide

**Date:** 2026-09-05  
**Status:** Accepted for static implementation  
**Scope:** workflow instances, actionable work items, assignment, lifecycle, and workspace orchestration

## Decision

Add a small Work Management module as the canonical owner of coordination state:

- workflow instance lifecycle;
- distinct `task`, `approval`, and `exception` work-item kinds;
- assignment to an actor or governed queue, with explicit time-bounded queue membership for claims;
- due date/priority fields;
- claim/in-progress/completed/cancelled/expired coordination lifecycle;
- append-only work-item history;
- source type/id/action key and optional source version;
- workflow-to-source correlation;
- persisted organization provenance for every workflow and work item, with optional branch provenance.

Work Management **does not** own:

- the approval decision or exception amount;
- enrollment, admission, academic, payroll, Finance, permission, or notification state;
- the source aggregate lifecycle;
- authorization to execute a source command;
- message delivery or read state.

Completing a Work Management approval item means only that the coordination item was completed. The linked `action_key` must lead to the owning domain command, which rechecks current authorization, lifecycle, separation of duties, provenance, and concurrency.

Event-projected workflow intents are the default path for source-domain producers. `StartWorkflow` remains only as an explicit operator/recovery command for a governed source; it cannot transition the source fact and is not a second workflow authority. If a compatible manual instance exists when its source event arrives, projection binds that instance to the source event; conflicting scope or event ownership fails closed.

## Why

The prior repository had domain-specific staged approvals but no coordination authority, so the Workspace either had to query every domain directly or risk inventing a generic task table without semantics. The target architecture distinguishes Task, Approval, WorkItem, Exception, and Notification. A coordination module closes the missing boundary without creating a shadow business authority.

## Invariants

1. Every work item has a source type/id and action key.
2. Every workflow and work item has explicit organization provenance; branch provenance is optional only for an explicitly organization-scoped item.
3. Branch and organization provenance must agree through active campus topology; branch actors cannot discover branchless organization items.
4. Every work item has an actor or queue assignment.
5. Work-item history is append-only.
6. Work-item transitions are idempotent and locked; terminal items cannot be reopened through the generic path.
7. A domain action is never executed by `MaintainWorkItem`.
8. Domain commands remain responsible for source authorization and state transition.
9. Workspace may show work items but cannot change them except through the server command boundary.
10. Notifications remain a separate Communication recipient/read projection and never become a work item.
11. A direct assignee must be an active employee with `workflow.work` authority in the item scope; queue membership is not a substitute for source authorization.
12. Actor, branch, organization, and creator references in coordination, history, queue-membership, and notification tables are database-constrained; workflow/item, history/item, and queue-membership branch/organization provenance is database-checked; a null queue branch is one explicit organization scope, never a global wildcard; source-version freshness remains an explicit producer/consumer contract rather than an inferred timestamp.

## Implementation evidence

- `app/Modules/WorkManagement/Domain/WorkflowCatalog.php`
- `app/Modules/WorkManagement/Domain/WorkItemLifecycle.php`
- `app/Modules/WorkManagement/Domain/WorkQueueCatalog.php`
- `app/Modules/WorkManagement/Models/WorkflowInstance.php`
- `app/Modules/WorkManagement/Models/WorkItem.php`
- `app/Modules/WorkManagement/Models/WorkItemHistory.php`
- `app/Modules/WorkManagement/Commands/StartWorkflow.php` (explicit operator/recovery bridge only)
- `app/Modules/WorkManagement/Commands/MaintainWorkItem.php`
- `app/Modules/WorkManagement/Domain/WorkflowProjectionConsumer.php`
- `app/Modules/WorkManagement/Domain/WorkflowCompletionConsumer.php`
- `app/Modules/WorkManagement/Queries/WorkItemQuery.php`
- `app/Modules/WorkManagement/Queries/QueueMembershipQuery.php`
- `app/Modules/WorkManagement/Commands/MaintainQueueMembership.php`
- `routes/api.php` work-item and queue-membership routes
- `EmployeeWorkspaceQuery` composition of assigned/claimable work items
- migrations `2026_09_05_000148_create_work_management_coordination.php`, `2026_09_05_000151_create_work_queue_memberships.php`, and `2026_09_05_000152_add_work_organization_provenance.php`

Runtime migration, authorization, concurrency, API contract, and browser verification remain deferred by the governing runtime restriction.
