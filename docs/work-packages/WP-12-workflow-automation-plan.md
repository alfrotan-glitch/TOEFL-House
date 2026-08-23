# WP-12 Workflow & Automation — Plan, Checkpoint and Certification Record

**Work Package:** WP-12 Workflow & Automation (`workflows`, `automations`, `events`)

**Protocol:** `docs/MASTER_ENGINEERING_PROTOCOL.md` §§2, 7–10, 14, 16–21,
24–42, 49–58, 65–76, 84, 89–101

**Recovery baseline:** `e1fffdd` on `arena/01a02d63-toefl-house`
(last verified clean state before WP-12 implementation began)

**Risk class:** Critical — workflow, automation and event surfaces can create
false authority, hidden global mutation, or dead operational controls.

---

## SCOPE

### Included

- `server/src/routes/workflows.routes.ts`
- `server/src/routes/automations.routes.ts`
- `server/src/routes/events.routes.ts`
- `server/src/core/events/event-bus.ts`
- `server/src/core/events/handlers.ts`
- `server/src/core/events/event-registry.ts`
- `server/src/core/events/automation-engine.ts`
- `server/src/core/rbac/permission-catalog.ts`
- `server/src/utils/workflowSeeds.ts`
- `server/src/index.ts`
- `src/components/workflows/WorkflowsView.tsx`
- `src/App.tsx`
- package-local WP-12 authority under `server/src/tests/work-packages/wp12/`
- workflow/automation/event registry repair in `docs/registries/*`

### Excluded

- WP-11 reporting architecture beyond direct workflow/event consumer fallout.
- WP-13 audit/platform redesign.
- New cross-domain automation action types that would mutate finance, academic
  or funding state without an explicit owner decision.

---

## DISCOVER

1. Workflow, automation and event routes mixed permission checks with legacy
   role-name access, creating contradictory authority boundaries.
2. Event names were declared twice and workflow/automation triggers accepted
   arbitrary strings, so configuration could reference events the runtime never
   emits.
3. Automations were persisted but not executed by the runtime.
4. Workflow UI actionability depended on `activeRole` / manager-owner heuristics
   instead of the already-available frontend permission and role-assignment
   contract.
5. Global automation/workflow configuration is intentionally owner-governed;
   WP-02 already proves branch managers must not mutate it.

---

## DECIDE

### D-179 — canonical workflow/automation/event authority

1. `server/src/core/events/event-registry.ts` is the single executable authority
   for domain-event names and workflow trigger validation.
2. Workflow definitions and automation definitions remain global configuration;
   mutation is permission-governed and owner-only (`Workflow.Configure`,
   `Automation.Edit`).
3. Workflow instance reads/actions use canonical workflow permissions; event
   browsing uses `Event.View`; replay/flush/subscription mutation uses
   `Event.Manage`.
4. Event dispatch must make stored configuration truthful: matching workflow
   definitions auto-start workflow instances, and matching automations execute
   their declared notify action and log execution.
5. UI actionability must read permissions and assigned role codes from the auth
   contract; no component may infer authority from a role label alone.
6. Automation action scope is intentionally narrow in WP-12: notify-only until
   an owner decision defines safe cross-domain mutation semantics.

**Rejected alternatives**

- Preserve route-local event vocabularies or `/api/events/types` hard-coding.
- Keep automations as dead configuration with no runtime execution.
- Grant global automation mutation to branch managers.
- Continue UI actionability from `activeRole` / `isGlobalOwner` heuristics.

---

## IMPLEMENTATION SUMMARY

- Added canonical event registry and trigger guards.
- Refactored event bus and event routes to consume the registry.
- Added a real automation engine with validation, evaluation, notification
  execution and `event_handler_log` persistence.
- Rewired runtime handlers so domain events auto-start workflows and process
  matching automations.
- Converted workflow, automation and event routes to canonical permission-based
  authority.
- Added `Workflow.Configure`, `Automation.Edit` and `Event.Manage` to the RBAC
  catalog, with owner-only mutation preserved and manager event read preserved.
- Replaced workflow UI role-label actionability with permission + assigned-role
  evaluation from the auth context.
- Re-homed WP-12 executable authority into
  `server/src/tests/work-packages/wp12/workflow-automation-authority.test.ts`
  and retired the top-level legacy `event-bus.test.ts`.

---

## VERIFICATION EVIDENCE

### Type safety

- `npm --prefix server run typecheck`
- `npm run typecheck`

### Focused executable authority

- `npm --prefix server run test -- server/src/tests/work-packages/wp12/workflow-automation-authority.test.ts server/src/tests/work-packages/wp02/p1-scope-hardening.test.ts server/src/tests/system-closure-authorities.test.ts`
  - **PASS** — 3 files / 30 tests

### Build / release confidence

- `npm run build:all`
  - **PASS**
- `npm run audit:registries`
  - **PASS**
- `npm run release:validate:quick`
  - **PASS** — 17 passed / 0 failed / 5 skipped

### Mutation

- `npm --prefix server run audit:mutation`
  - **PASS** — 18 harnesses passed, mutation gate passed

---

## CERTIFICATION STATUS

WP-12 implementation, package-local authority, registry repair, focused
verification, mutation gate and quick release validation are complete. The
package is ready for git publication and final clean-tree validation in this
session.
