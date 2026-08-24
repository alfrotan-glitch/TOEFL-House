# TOEFL House Foundation State

**Phase:** Foundation / discovery
**Current gate:** Gate 3 — Domain Model Completeness Review (`FAIL`)
**Certification:** `NOT CLAIMED` — business discovery is complete; Gates 1–16 and Foundation Certification remain pending
**Updated:** 2026-08-25

## Branch and repository boundary

- Active branch: `arena/01a034c7-toefl-house`.
- This Arena session is fixed to that branch; a second branch cannot be created without violating the session boundary.
- The branch is **not greenfield in its current checkout**. Its HEAD already contains a substantial React/Vite frontend, Express/TypeScript backend, SQLite schema, routes, domain services, scripts, fixtures, and tests.
- Therefore the existing implementation is classified as **legacy reference material** for this directive. It is not accepted as requirements authority, architectural authority, or business-rule authority.
- No production implementation, production database, migration, CRUD, API, or UI work is authorized before Foundation Certification.

## Evidence snapshot

| Item | Evidence | Classification |
|---|---|---|
| Branch is fixed as above | `git status --short --branch` | KNOWN, Level 5 |
| HEAD is `e9322b2` | `git log --oneline -1` | KNOWN, Level 5 |
| Existing implementation is extensive | `README.md`, `package.json`, `server/package.json`, `src/`, `server/src/` | KNOWN, Level 5 |
| Existing backend uses Express + TypeScript + SQLite | `server/package.json`, `server/src/db/schema.sql`, `server/src/index.ts` | KNOWN, Level 5 |
| Existing frontend uses React + Vite + TypeScript | `package.json`, `vite.config.ts`, `src/` | KNOWN, Level 5 |
| Existing repository has 216 backend test files | `find server/src/tests -type f` | KNOWN, Level 5 |
| Existing repository already contains engineering registries and work-package records | `docs/registries/`, `docs/certification/`, `docs/work-packages/` | KNOWN, Level 5; historical/reference only |
| No production dataset requiring preservation | Existing documentation states this, but it is not a user-confirmed decision in this session | UNVERIFIED until confirmed |

## Foundation controls initialized

The following controlled registers are now established as the working foundation set:

1. Project state and gate register — this document.
2. Legacy intelligence report — `docs/foundation/01-legacy-system-intelligence-report.md`.
3. Organization discovery and question register — `docs/foundation/02-organization-discovery.md`.
4. Foundation document index — `docs/foundation/03-document-index.md`.
5. Foundation decision ledger — `docs/foundation/04-decision-ledger.md`.
6. Foundation risk and contradiction register — `docs/foundation/05-risk-register.md`.

Existing `docs/registries/*` files are preserved as repository evidence and are not silently promoted to authority for the new system.

## Gate 0 exit criteria

Gate 0 cannot pass until:

- the repository and legacy boundary are recorded;
- the current-state map is complete enough to plan discovery;
- the initial actor and organization questions are answered or explicitly classified as non-critical;
- all material assumptions are separated from decisions;
- contradictions between the directive, repository, and user decisions are recorded;
- the next discovery cluster is approved.

**Current result:** Gate 3 is `FAIL`; see `28-gate-3-domain-model-completeness-review.md`.

## Prohibited claims

This document does not claim that the current application is complete, secure, certified, greenfield, PostgreSQL-based, Laravel-based, or compliant with the directive. Existing tests and certifications are evidence about the existing repository only.
