# WP-ACAD-SCOPE — Academic branch-scope doctrine

**Status:** approved for implementation · **Date:** 2026-09-05
**Trigger:** independent red-team finding — every core Academic command
resolved authorization with `scope: null`, and `AccessResolution` treats null
scope as "any grant of the capability suffices", so a branch-narrow grant
authorized any branch's records. The access model intends the opposite:
direct grants are branch-narrow by construction (`GrantScopePermission`
refuses organization scope without the staged org-wide approval chain), and
Placement already enforces record-branch scope correctly.

## Root cause (not a controller bug)

Scope was defaulted to `null` at ~30 call sites across all 13 Academic
commands. No controller, route, or query can fix that: commands own
authorization (all transports funnel through them), so the repair belongs in
the commands — one choke point per verb, unbypassable by construction.

## Decision

**Scope follows the target's owning branch, resolved server-side from locked
rows or verified inputs — never from client-supplied branch fields, never
from the actor (the actor carries no branch). The single authority stays
`AccessDecision`; modules only resolve scope.**

1. **Two tiers, matching the data model:**
   - DELIVERY layer (branch-bound): availability, offering, room, enrollment,
     attendance, assessment attempt/result/correction, waitlist, progression,
     graduation, transcript, appeal, and every printable/API-readable
     artifact. Verbs resolve the target branch and pass its `StructureScope`
     (via `Branch::structureScope()`) to `decide()`.
   - GOVERNANCE layer (branchless by design): programs, versions, levels,
     periods, skills, classes, session scheduling. These records carry no
     branch anywhere (form, command, table); curriculum definition is
     organization-global, so the global check is CORRECT here and is kept
     explicitly — not by accident. Grant hygiene for structure capabilities
     (issue org-wide through the approval chain) is an operator duty,
     recorded here.
2. **Branch derivation per target** (first hit wins; stored provenance beats
   live derivation; nothing is fabricated — derivation only reads linked
   rows):
   - availability / offering / room: own `branch_id` (non-null — always scoped).
   - enrollment: own `current_home_branch_id` → own `originating_branch_id` →
     offering `branch_id` → student home/originating → global. `request()`
     STAMPS `originating_branch_id` from offering/student at creation
     (provenance capture from linked records, not fabrication); conversion
     stamps students from the applicant's placement profile branch.
   - attempt / result / correction / attendance fact: via the enrollment chain.
   - waitlist entry: offering branch → student home/originating → global.
   - progression / graduation / transcript / certificate: student
     home (`current_home_branch_id`) → originating → global. A transferred
     student's SEATS stay with their delivery branch (delivery owns the
     seat); new seats scope to the new branch. Deliberate.
   - appeal: the SUBJECT's branch (result → enrollment chain; progression →
     student; placement → profile `originating_branch_id`), resolved from the
     verified/locked subject row.
   - printable/API artifacts: receipt/invoice → obligation/payment
     `originating_branch_id` → student; transcript/certificate/enrollment/ID →
     as above; payroll slip → employment → person `home_branch_id`.
   - unknown branch id on any path → `BusinessRejection` (fail-closed).
3. **Read rule (document production + bulk JSON):** printing all seven
   artifacts and the API read endpoints disclose only records whose branch is
   in the actor's visible set (`ActorBranches`: active branch/campus/org
   grants mapped through the campus-assignment topology, role-derived orgs,
   scoped delegations), or — while provenance is being populated — records
   with NULL branch to actors holding at least one effective authority key.
   Out-of-scope reads are denied (403) and denial-audited; every production
   is audit-logged. NO new read capabilities are invented: no read vocabulary
   exists anywhere, writer capabilities do not map to readers
   (issuer ≠ re-printer), and a parallel read-RBAC would be a second
   authority. Within-branch role separation is an explicit follow-up, not
   part of this repair.
4. **Console HTML lists are NOT re-scoped in this slice** (known residual):
   28 inline list queries with no read-capability context; branch-filtering
   them without the read-RBAC vocabulary would fake complete mediation while
   class-level reads are ill-defined anyway (branchless classes carry
   multi-branch seats — seat-level enforcement is the finer, correct grain
   and IS implemented). Mutations, official documents, and bulk JSON are the
   enforced boundaries.
5. **Topology is part of the contract:** a branch resolves to an organization
   path ONLY through an open campus assignment (`Branch::structureScope()`).
   Org-less branches are manageable solely by exact branch grants
   (fail-closed for org-wide holders — correct). Fixtures and seeders must
   model production topology (branch → campus → organization); bare branches
   in tests were an artifact of the null-scope era.

## Consequences

- A shared `AcademicAccess` scope-resolver (mirroring `PlacementAccess`,
  delegating to the same `AccessDecision`) is threaded through every
  delivery-layer verb; `ActorBranches` + `RecordBranch` back reads.
- Cross-branch negative tests per verb; org-wide holders keep working
  (ancestor covers descendants — valid behavior preserved and tested).
- `TransferStudentHomeBranch` needs no cascade (seat stays with delivery).
