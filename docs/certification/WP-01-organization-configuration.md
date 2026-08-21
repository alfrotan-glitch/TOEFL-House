# Certification — WP-01 Organization & Configuration

**Work Package:** WP-01 Organization & Configuration
**Protocol:** `docs/MASTER_ENGINEERING_PROTOCOL.md`
**Date:** 2026-08-21
**Baseline:** `da4008304f64875194f9b0d5010f1e758fccea0a`
**Status:** READY — scope-limited certification complete

> This artifact is scope-limited to WP-01. It cannot certify the full system or any
> other Work Package.

## SCOPE

Included:

- the `branches`, `settings`, `rules`, and `catalog` route modules mapped to WP-01;
- Organization → Campus → Branch hierarchy and organization equity-partner configuration;
- system-setting reads, generic cross-cutting rule definitions/evaluation/version history,
  academic catalog versions/subjects/modules/promotion/placement rules, class-generation
  drafts, and branch academic profiles;
- branch-scope enforcement at those APIs and the frontend consumers that select a branch;
- schema constraints and transactional boundaries owned by these concepts;
- canonical-authority/invariant registration and retirement/replacement of the ten WP-01
  legacy test files inventoried in `docs/legacy-test-inventory.md`.

Excluded except as consumed dependencies:

- identity assignment and permission-catalog redesign (WP-02);
- student, placement-attempt, delivery, finance, payroll, reporting, and workflow business
  models owned by later Work Packages;
- new business policy. Existing owner decisions, permission grants, finance rules, and
  academic defaults are preserved.

Risk: **HIGH** — branch isolation, global configuration, curriculum publication, class
creation, fee configuration, and destructive hierarchy operations are in scope.

## DISCOVER

### Runtime surface

| Area | Authority / files | Observed contract |
|---|---|---|
| Hierarchy and partners | `server/src/routes/branches.routes.ts`, `server/src/db/organizationHierarchy.ts` | fixed organization; scoped campus/branch reads; campus/branch CRUD; organization equity-partner CRUD; new-branch finance provisioning |
| Settings | `server/src/routes/settings.routes.ts`, `server/src/utils/settings.ts`, `server/src/core/configuration/policy-catalog.ts` | owner-facing snapshot of three persisted numeric settings and branch cash position |
| Generic rules | `server/src/routes/rules.routes.ts`, `server/src/core/configuration/rule-engine.ts` | six exposed cross-cutting categories, branch/global precedence, ordered evaluation, version snapshots and rollback |
| Academic catalog | `server/src/routes/catalog.routes.ts`, `server/src/core/academic/catalog-service.ts` | version trees, copy/publish, subjects/modules, promotion/placement configuration and evaluation, fee snapshots |
| Class generation | `server/src/core/academic/class-generation-engine.ts` | branch-scoped preview → persisted draft/items → published classes |
| UI consumers | `src/apiStore.ts`, `src/components/settings/SettingsView.tsx`, `src/components/rules/RulesManagementView.tsx`, `src/components/academic/AcademicSetupView.tsx`, `OfferingsPanel.tsx`, `ProgramVersionsPanel.tsx`, `ClassGenerationWizard.tsx` | active-branch selection, hierarchy/equity editing, generic-rule management, academic setup and class generation |

### Storage surface

`organizations`, `campuses`, `branches`, `partners`, `system_settings`,
`branch_academic_profiles`, `programs`, `program_versions`, `levels`, `subjects`,
`modules`, `promotion_rules`, `placement_rules`, `fee_rules`,
`class_generation_runs`, `class_generation_items`, `rule_definitions`,
`rule_versions`, and `rule_evaluation_logs` in the sole schema authority
`server/src/db/schema.sql`.

### Legacy test knowledge

The ten inventoried WP-01 files encode 108 declared cases covering configuration
lifecycle, branch-scope resolution and cross-domain isolation, audit attribution,
fee-boundary validation, brand authority, dashboard isolation, and immediate new-branch
provisioning. They remain non-authoritative inputs under §14 and are scheduled for
replacement below; no behaviour is accepted solely because a legacy assertion says so.

### Defects established by direct inspection

1. A branch/campus-scoped `owner` assignment passes `authorize('owner')`; campus CRUD and
   organization equity-partner mutations therefore treated a scoped owner as the global
   owner that D-60 explicitly says it is not.
2. Branch deletion did not check the target branch at all. A scoped owner could deactivate
   or attempt permanent deletion outside its assignment.
3. Organization summary exposed global campus/branch counts even when the corresponding
   campus and branch lists were scope-filtered.
4. Program-version list/detail/create/publish, subject/module writes, promotion rules,
   fee snapshots, and class-generation publish/detail had missing branch checks. Several
   branch-scoped positions could read or mutate another branch by identifier.
5. Catalog relationships were trusted independently: a version could copy another
   program, a subject could reference a level from another version, a promotion rule
   could reference unrelated levels, and a draft could select levels/terms inconsistent
   with its version/branch.
6. The UI calls promotion/placement delete endpoints that do not exist.
7. Class-generation draft creation writes the run and items outside one transaction.
8. Generic rule creation/update writes its definition and version snapshot outside one
   transaction; deactivation did not create a version, despite rollback history being the
   declared lifecycle.
9. Generic rule category validation rejects domain-owned categories before the intended
   ownership-boundary response can execute; owner/scoped-owner rule mutation semantics
   also use role presence instead of effective scope.
10. Rule payloads are only checked for top-level arrays; malformed condition/action
    objects are persisted and silently become false/no-op behaviour.
11. Partner share limits exist only in the browser. Direct API/database writes can store
    non-percentage values or make total equity exceed 100%.
12. `getNumberSetting` accepts non-finite numeric text such as `Infinity`, allowing a
    poisoned persisted setting to escape instead of using its safe fallback.
13. Academic configuration consumers remount on active-branch change but intentionally
    omit that branch from requests; server authorization therefore defaults to the
    operator identity/home branch and the visible selector can show stale/wrong scope.
14. The generic seeded “Auto Savings” finance rule is editable and presented as policy,
    but the money writer uses `system_settings.daily_saving_percent`; it is a disconnected
    duplicate description, not an authority.

## MODEL

### Entities and relationships

- One fixed Organization contains Campuses; a Campus contains Branches.
- A Branch is the operational isolation boundary. Scope comes only from live RBAC
  assignments; `users.branch_id` is an identity/default and never an authorization grant
  (D-60).
- Partners are organization-level equity records. Each share is a percentage and the
  aggregate cannot exceed 100%, matching the existing operator workflow and UI contract.
- A Program belongs to one Branch. A ProgramVersion belongs to exactly one Program.
  Subjects belong to one ProgramVersion; a subject level, when present, must belong to
  that same version. Modules belong to one Subject.
- Promotion/placement rules belong to a ProgramVersion and may be branch-specific only
  within caller-authorized scope. Referenced levels must belong to that version.
- A class-generation run belongs to one Branch and one ProgramVersion. Its term, rooms,
  slots and persisted items must remain consistent with that branch/version through
  publication.
- A generic rule is either organization-global or branch-scoped. Global mutation requires
  an organization-scoped owner; non-global writers can mutate only an authorized branch.
  Definition and version snapshot are one atomic state transition.

### Configuration precedence

- Domain-owned fee, promotion, attendance and academic policy remains outside generic
  rule management.
- Generic active rules resolve by category and branch, including global fallback rows,
  ordered by priority then creation time.
- Persisted settings override `SYSTEM_DEFAULTS`; malformed/non-finite persisted values
  fail safely to the default.
- Financial savings remains owned by `system_settings.daily_saving_percent` and the
  finance writers. A disconnected generic finance rule cannot claim that authority.

### Invariants

1. No principal reads or mutates a WP-01 branch resource outside effective RBAC scope.
2. Only an organization-scoped owner mutates organization-global hierarchy/equity or a
   global generic rule.
3. New branch + finance account + required payroll envelopes commit atomically.
4. Catalog child references cannot cross their owning version/program relationship.
5. A class-generation run cannot publish resources from another branch/version.
6. Rule definition and version history transition atomically and remain rollback-capable.
7. Partner share is finite and within 0..100; aggregate shares are at most 100.
8. Invalid configuration never becomes authoritative money or a non-finite runtime value.
9. Active-branch UI requests name the selected branch; the server remains the authority
   that accepts or rejects it.

## CHALLENGE

| Subsystem | Verdict | Reason |
|---|---|---|
| Fixed organization hierarchy/bootstrap | KEEP | one idempotent authority; fixed identifiers are depended on across the canonical schema |
| Hierarchy API | REFACTOR | useful API and mappers, but global/scoped-owner semantics, count filtering and transaction boundaries are unsafe |
| Partner configuration | REFACTOR | real organization configuration; server/database invariants and global mutation boundary are absent |
| Numeric setting utility | REFACTOR | single simple storage utility; fail-safe finite parsing is missing |
| Generic rule engine | REFACTOR | active discount/payroll consumers and useful precedence exist; validation, scope semantics and atomic version lifecycle require repair |
| Disconnected auto-savings generic rule | REMOVE | no runtime consumer; contradicts the actual settings/finance authority |
| Academic catalog service/routes | REFACTOR | coherent version/tree service; authorization and relationship invariants are incomplete |
| Class-generation engine | REFACTOR | valid preview/draft/publish workflow; draft atomicity and publish-time consistency checks are incomplete |
| Missing rule-delete API contract | BUILD | UI already invokes the contract; server omission makes the workflow nonfunctional |
| Branch-aware UI request wiring | REFACTOR | active selector is real; remount-without-scope does not select server data |
| Ten WP-01 legacy tests | REMOVE/REPLACE | owner-approved D-18 and §14; behavioural knowledge is re-expressed from this model rather than copied as history |

## DECIDE

Exact implementation plan:

1. Add a reusable authenticated `requireGlobalOwner` guard in
   `server/src/middleware/auth.ts` and apply it only to organization-global WP-01
   mutations/reads.
2. Refactor `branches.routes.ts` to scope-filter organization counts, require target
   branch access for deletion, make campus deactivation and branch provisioning atomic,
   and validate partner inputs/aggregate equity before write.
3. Add canonical partner percentage and aggregate constraints to
   `server/src/db/schema.sql`.
4. Make `getNumberSetting` reject every non-finite value; correct settings ownership
   comments without changing the three existing setting values or finance policy.
5. Refactor `rules.routes.ts` around effective global-vs-branch scope, reachable domain
   ownership errors, validated condition/action shapes, and scope checks on every
   mutation. Refactor `rule-engine.ts` so create/update/deactivate + version writes are
   transactional and deactivation is versioned.
6. Remove only the disconnected seeded auto-savings rule; do not alter the live savings
   setting or money writer and do not introduce financial policy.
7. Refactor `catalog.routes.ts` to resolve owning branches for every program/version/
   subject/run, filter collections, check every target, validate level/version links,
   add the two missing promotion/placement delete endpoints, and return actionable
   4xx errors rather than leaking SQLite failures.
8. Refactor `catalog-service.ts` to reject cross-program copies atomically and expose the
   owning branch needed by scoped consumers.
9. Refactor `class-generation-engine.ts` to validate version/level/term/room/slot
   coherence, create draft + items atomically, and revalidate persisted drafts at
   publish time.
10. Pass the selected authorized branch from `AcademicSetupView.tsx`,
    `ProgramVersionsPanel.tsx`, `OfferingsPanel.tsx`, and the shared program-version
    reloader. No frontend authorization decision is added.
11. Replace the ten mapped legacy files with model-based WP-01 domain, API,
    authorization, authority/architecture, and cross-domain contract tests. Update every
    registry test reference before deleting a named legacy authority.
12. Update canonical authority, invariant, decision, conflict, inventory, and this
    certification artifact; run focused tests, both typechecks, lint, build, canonical
    schema preflight, audits, adversarial probes, independent cold diff review, full test
    suite and release validation.

No dependency addition is planned. No table or endpoint compatibility layer is planned.

## CHECKPOINT

**Checkpoint classification:** schema change · RBAC/security correction · destructive
legacy-test replacement · API addition · removal.

- Recoverable Git baseline is preserved and pushed at
  `da4008304f64875194f9b0d5010f1e758fccea0a`.
- Legacy-test removal is already owner-approved by D-18.
- Scope semantics are not a new policy: D-60 and the existing
  `isGlobalOwner`/`canAccessBranch` authority require the correction.
- Partner percentage/aggregate enforcement is the existing UI workflow moved to the
  server/database, not a new ownership policy.
- Removal of the disconnected auto-savings row preserves, rather than changes, the live
  `daily_saving_percent` finance authority; no additional financial policy is introduced.
- The user explicitly directed autonomous continuation through the Work Package lifecycle.

**CHECKPOINT: PROCEED.** If implementation requires a new business rule, permission grant,
financial formula, or wider schema redesign than listed above, stop and re-enter MODEL /
DECIDE rather than infer it.

## IMPLEMENT

### Organization hierarchy and global authority

- Added `requireGlobalOwner`, backed by live RBAC assignment scope rather than the
  `owner` role name alone, and applied it to campus, partner, and system-setting
  administration.
- Filtered organization and campus counts to the caller-authorized topology and
  recognized direct campus assignments even when a campus has no branches yet.
- Required target-branch access for branch deletion and made campus deactivation,
  branch provisioning, and safe permanent deletion transactional.
- Made branch creation atomic across the branch row, branch finance account, and the
  two required payroll envelopes.
- Made permanent branch/campus deletion reject non-zero main cash, savings, or budget
  envelope balances and remove only zero-balance provisioning in the same transaction.
- Enforced partner names, individual percentages, and aggregate equity at both the API
  and canonical-schema layers.

### Settings and configuration

- Kept `GET /api/settings/system` read-only and organization-Owner scoped.
- Made its cash facts explicitly select and identify one existing branch instead of
  returning an unlabeled identity-home balance.
- Made numeric-setting reads fall back on every non-finite stored value.
- Removed only the disconnected seeded generic Auto Savings row. The live
  `daily_saving_percent` setting and its finance writer were not changed.

### Generic rules

- Separated the six exposed cross-cutting categories from the domain-owned `fee`,
  `promotion`, `attendance`, and `academic` categories.
- Replaced role-name/home-branch shortcuts with effective assignment-scope checks for
  list, detail, create, update, rollback, deactivate, delete, and evaluation paths.
- Added semantic validation for condition/action structures and scalar values, strict
  arithmetic tokenization, explicit evaluation branch/dry-run types, and fail-closed
  handling of malformed active persisted rules.
- Made definition + version creation/update/deactivation atomic; deactivation now has a
  rollback-visible version.

### Academic catalog and class generation

- Resolved every program/version/subject/run to its owning branch before access and
  filtered collections to effective scope.
- Rejected cross-program version copies, cross-version levels, and promotion/placement/
  fee relationships that disagree with the owning version branch.
- Added the promotion- and placement-rule delete contracts already invoked by the UI.
- Added typed scalar boundaries for version, subject, module, promotion, placement,
  evaluation, profile, and fee-snapshot inputs. Stored compatibility fee rows cannot
  emit non-canonical money.
- Made generation draft + items atomic; validated branch/version/term/offering/level/
  slot/room coherence, state, capacity, minimum viable size, fee, gender, and parameters
  at preview and again at publish. Publication rechecks current room capacity.
- Required a singular branch for `/api/academic/branch-config` and filtered its programs
  and levels to that branch.

### UI and lifecycle tooling

- Sent the selected branch as a requested scope from Academic Setup, versions,
  offerings, generation, and the shared version reloader; the server remains the sole
  authorization authority.
- Preserved key-based panel remounting and added stale-request protection to the class
  generation offering load.
- Made the dependency-isolation gate ignore Git index entries whose approved
  working-tree deletion is under review, allowing C-2 verification without restoring
  retired tests.
- Updated the authority, invariant, decision, conflict, and legacy-test registries.

No dependency was added. No financial percentage, reserve, warning threshold, permission
assignment, or other owner policy was invented or changed.

## VERIFY

| Evidence | Executed result |
|---|---|
| Dedicated replacement authority | `npx vitest run server/src/tests/work-packages/wp01 --no-file-parallelism` — **5 files / 116 tests passed** |
| Focused cross-domain set | WP-01 + formula parser + reporting catalog — **7 files / 150 tests passed** |
| Full server suite | JSON-reported full run — **158 files / 2578 tests passed; 0 failed; 0 pending** |
| Frontend lint/typecheck/build | final release validation passed all three; direct lint completed with **0 errors / 13 warnings** |
| Server lint/typecheck/build | direct `npm run lint` completed with **0 errors / 103 warnings**; final release validation passed lint and production build |
| Canonical schema | preflight passed at **111 tables / 228 indexes / 66 triggers**; release fresh-install probe passed idempotent re-init, integrity, and foreign-key checks |
| Seed and stored-config probe | isolated production bootstrap succeeded; read-only config-data audit found **0 malformed fee rows / 0 unauthorized discounts** in the fresh seeded database |
| Audits | protocol, registries, product integrity, high-assurance static, dependency isolation, design system, logging, source cleanliness, and bundle weight passed |
| Dependency isolation | **275 files in the server import graph / 32 declared packages**, including the active unstaged C-2 deletions |
| Bundle | first paint **494 KB / 560 KB budget**, 19 lazy route chunks |
| Release gate | `npm run release:validate` — **22 passed / 0 failed / 0 skipped** |
| Release database checks | fresh install **111 tables**; financial reconciliation amount/cash/saving/budget variances all zero |

The expected handled `SqliteError: account failed` appears on stderr only in the forced
branch-provisioning rollback regression; the suite exits successfully and proves no
partial branch survives.

The lint warnings are repository-wide nonblocking findings under the existing lint
configuration; both lint commands exit zero, and no lint error remains. Their presence is
not converted into a claim of full-system cleanliness or readiness.

## ATTACK

The package suites actively exercised:

- scoped-Owner attempts against organization-global settings, campuses, partners, rules,
  and another branch;
- empty-campus, campus-wide, multi-branch, misaligned-home, forged body/query target, and
  `all` scope cases;
- cross-branch program/version/level/promotion/placement/fee/generation identifiers;
- another authorized branch combined with the wrong version, proving authorization alone
  cannot make an invalid ownership graph valid;
- malformed scalar payloads, non-finite settings, malformed JSON/rule semantics, invalid
  formula tokens, and direct SQL corruption;
- forced rule-history and generation-item persistence failures;
- cancelled/malformed generation runs, invalid item money/count/gender, minimum size over
  capacity, and a room whose current capacity is below the stored draft;
- non-canonical compatibility fee storage;
- non-zero branch main cash, savings, and envelope balances before permanent deletion;
- invalid partner scalar input through the API and aggregate percentages above 100%
  through direct SQL insert/update paths.

## REPAIR AND REVERIFY

The first verification pass exposed two blocking lint errors and a dependency-audit
harness failure on approved-but-unstaged deleted files. The cold review then found four
additional boundary defects: unlabeled identity-home cash in the settings snapshot,
under-validated catalog scalars/stored fee money, generation minimum/room capacity drift,
and silent generic-evaluation substitution for malformed branch/dry-run values.

Each was repaired, covered by a regression, and followed by focused tests, lint/typecheck,
registry/protocol/dependency audits, the complete release gate, and the full 2578-test
server run recorded above.

## INDEPENDENT REVIEW

A structurally separate cold pass reviewed the final diff against the model rather than
against the implementation plan. It checked:

- every changed route's collection and identifier authorization path;
- global-versus-branch ownership and identity-home non-authority;
- catalog parent/child ownership, scalar boundaries, and money output;
- transaction rollback and publish-time revalidation;
- branch deletion foreign-key/provisioning behavior and cash preflight;
- UI request scope versus server authorization;
- schema idempotence and the sole-schema/no-migration boundary;
- all registry references, C-2 replacement mappings, warning/error output, generated
  artifacts, dependency declarations, and final Git diff/status.

The review produced the repairs listed above. No unresolved Critical or High WP-01 defect,
contradictory authority, missing mapped legacy behavior, or accidental generated artifact
remained.

## CLEAN

- Removed the ten mapped legacy files only after all mapped behavior was replaced or
  explicitly assigned to its owning downstream package.
- Removed the disconnected savings seed, stale comments, unused catalog statements and
  imports, and all blocking lint findings introduced/exposed by this package.
- Source cleanliness passed over **211 files / 8674 comment lines / 10 banned phrases**;
  logging passed over **112 runtime modules**; design-system audit passed over **106
  files**.
- Build output, dependency directories, temporary databases, and JSON test reports are
  not tracked. `git diff --check` passes.

## LEGACY-TEST RESET (C-2)

Retired: **10 files / 108 inventoried declared cases**.

Replacement authority: **5 package files / 116 executed cases**:

1. `organization-configuration.api.test.ts` — 43 cases;
2. `organization-configuration.authorization.test.ts` — 19 cases;
3. `organization-configuration.dependent-scope.test.ts` — 8 cases;
4. `organization-configuration.architecture.test.ts` — 7 cases;
5. `organization-configuration.integrity.test.ts` — 39 cases.

The one-to-one knowledge disposition is recorded in `docs/legacy-test-inventory.md`.
Placement-enrollment behavior remains assigned to WP-04 and detailed money-writer behavior
to WP-07; neither was duplicated merely to inflate WP-01 evidence.

## QUALITY GATE

| Dimension | Verdict | Evidence / limit |
|---|---|---|
| Correctness | PASS | 116 package tests; focused and full suites pass |
| Architecture | PASS | one schema, assignment-derived scope, registered owners, no new dependency |
| Data integrity | PASS | relationship/scalar guards, schema constraints, atomic transitions, corruption attacks |
| Finance | PASS (scope) | canonical whole-AFN fee output and cash-safe deletion; owner financial policy unchanged |
| Security / RBAC | PASS | global/scoped/campus/multi-branch/home-misalignment attacks pass |
| UX / UI | PASS (scope) | selected branch reaches APIs; stale branch panels remount/guard loads; production build passes |
| Accessibility | SUPPORTED | no new visual system or direction bypass; design-system audit passes |
| Performance | SUPPORTED | prepared statements retained; bundle budget passes; no severe package regression observed |
| Reliability | PASS | transaction rollback, publish revalidation, idempotent schema and release probes pass |
| Reporting | PASS (dependency) | reporting catalog remains green in the 150-test focused set and full suite |
| Maintainability | PASS | explicit helpers, current-intent comments, registries, package-owned tests |
| Observability | PASS | mutations retain audit writes; logging authority audit passes |
| Repository cleanliness | PASS | cleanliness, dependency, registry, diff, and release hygiene gates pass |
| Operational readiness | PASS (package) | fresh install, seed, config audit, builds, bundle and release gate pass |
| Testing | PASS | C-2 replacement complete; adversarial, focused, full, schema, and release evidence |

## CERTIFY

**WP-01 Organization & Configuration: READY.**

This is a bounded package certification under §§54–76. It certifies only the organization,
settings, generic-rule, catalog, and directly consumed branch-scope surfaces listed in
SCOPE. Other Work Packages remain uncertified; this artifact does **not** claim full-system
or production release readiness.
