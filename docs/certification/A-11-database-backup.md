# Remediation Record — A-11 Automated Database Backup

**Scope:** Required SQLite backup automation for the single-PC Windows deployment  
**Protocol:** `docs/MASTER_ENGINEERING_PROTOCOL.md`  
**Date:** 2026-08-21  
**Diff under review:** changes after A-10 checkpoint `c649ed4`

> This record certifies only A-11's backup and recovery concern. It does **not**
> certify every operations concern, every Work Package, or the full system.

## Owner checkpoint

The owner required:

- a startup backup when no current backup exists;
- another attempt every 24 hours while the backend runs;
- 7 daily, 4 weekly, and 12 monthly snapshots; and
- a verified local snapshot plus a required verified external/network copy.

No frequency, retention count, or local-only fallback was added. D-62 records the
implemented interpretation of “current”: a matching, integrity-verified pair less than
24 hours old.

## Lifecycle record

| Stage | Outcome |
|---|---|
| SCOPE | Online SQLite snapshot creation, dual-destination verification, startup freshness, 24-hour scheduling, GFS retention, readiness/failure visibility, shutdown safety, Windows configuration/launchers, restore runbook, tests and registries. |
| DISCOVER | No active backup mechanism existed. The operations runbook explicitly assigned snapshots to the operator, the environment had no external destination, and launchers could report success without testing recoverability. |
| MODEL | One backup authority creates a consistent local SQLite snapshot, copies only that snapshot to the external destination, verifies all six daily/weekly/monthly local/external files, publishes managed names only after verification, and retains paired calendar buckets. |
| CHALLENGE | REPAIR by adding an operations service; do not restore migration machinery or add a schema-changing mechanism. `schema.sql` remains the sole database-shape authority. |
| DECIDE | SQLite online backup API; mandatory external Windows drive/UNC path; SHA-256 + size + SQLite integrity + FK integrity; health/readiness 503 on failure; 7/4/12 paired GFS retention. |
| CHECKPOINT | Owner supplied schedule, retention and destinations before implementation. External-path syntax is deployment configuration, not new business policy. |
| IMPLEMENT | Added `server/src/core/operations/database-backup.ts`, bootstrap/readiness integration, environment enforcement, Windows launcher gating, runbook procedures, tests and executable registry entries. |
| VERIFY | Focused backup suite: 11/11. Backup + logging + Windows script suites: 29/29. Both server typechecks, lint, registry, logging and source-cleanliness audits pass. |
| ATTACK | Missing/placeholder destination, same directory, same Windows drive, network-copy failure, later scheduled failure, exact 24-hour boundary, fresh restart, corrupt retained tier, unmatched partials, GFS overflow, unknown operator files, point-in-time behavior and offline restore were exercised. |
| REPAIR | Artifact-first review found and corrected six issues: only the daily pair was initially checked on restart; retention deletion errors were initially swallowed; overdue health was initially static; fatal startup could naturally exit 0; the PowerShell all-in-one launcher could start the frontend before backup readiness; and repeated environment bootstrap escaped Windows backslashes again on every run. |
| REVERIFY | Live compiled smoke test created six 2,277,376-byte snapshots with one SHA-256 across both destinations, `integrity_check=ok`, zero FK violations and healthy status. A restart created no duplicate and scheduled the remaining interval. Missing external configuration exited 1 before opening the listener. `npm run release:validate`: **22 passed · 0 failed · 0 skipped**. |
| INDEPENDENT REVIEW | Performed from the diff, filesystem state, compiled process behavior and failure artifacts. Findings below. Same-agent limitation remains TR-4. |
| CLEAN | Obsolete “no automatic backup” guidance removed; A-11, D-62, TR-5/TR-6, authority and invariant registries updated; smoke artifacts removed. |
| CERTIFY | A-11 verdict below. |

## Independent review findings

| # | Question | Evidence | Result |
|---|---|---|---|
| A11-R1 | Can a live SQLite file or WAL be copied raw? | Cold read of every copy source. | **PASS** — only `database.backup()` reads the live connection; every `copyFile` source is the resulting closed snapshot temporary file. |
| A11-R2 | Can local success be reported when external copying fails? | Injected copy failure before publication and after an earlier good run. | **PASS** — the new run has no managed final; status is failed; the previous paired recovery point remains; readiness is unhealthy. |
| A11-R3 | Does startup validate the entire GFS set or only daily? | First implementation checked daily only; monthly corruption attack remained possible. | **DEFECT, FIXED** — startup now verifies all six files for the candidate run and replaces the set if any tier/copy fails. |
| A11-R4 | Can retention silently exceed 7/4/12 when deletion fails? | Cold read found best-effort deletion in the retention path. | **DEFECT, FIXED** — managed retention deletion is strict and fails the run; best-effort deletion remains only for failed-run cleanup. |
| A11-R5 | Can process readiness remain healthy after the due time if a timer is delayed? | Compared persisted status with the 24-hour invariant. | **DEFECT, FIXED** — `getStatus()` dynamically reports overdue status unhealthy at the boundary, independent of timer dispatch. |
| A11-R6 | Does missing external configuration fail before serving requests with a nonzero exit? | Compiled process smoke test. | **DEFECT, FIXED** — the prior unreferenced exit timer allowed natural exit 0. Startup now sets exit code 1, closes the database, and never opens the HTTP listener. |
| A11-R7 | Do both Windows “start all” launchers wait for backup readiness? | Cold read of `.bat` and `.ps1`. | **DEFECT, FIXED** — both bootstrap first and withhold the frontend unless `/api/health` confirms database and backup readiness. |
| A11-R8 | Can backup shutdown race `db.close()`? | Signal-path review. | **PASS** — scheduling stops immediately and shutdown awaits any active backup before closing the shared SQLite connection. |
| A11-R9 | Is a restore demonstrably usable? | Test copies the verified external snapshot to an offline restore path, compares SHA-256, opens it read-only and checks data/integrity. | **PASS** — restored bytes match the verified recovery point and the snapshot remains independent of later live writes. |
| A11-R10 | Does repeated environment bootstrap preserve Windows path bytes? | Executed bootstrap twice with `E:\TOEFL-House-Backups`. | **DEFECT, FIXED** — replacement-string escaping doubled backslashes on each pass. Callback replacement now preserves backslashes and dollar signs literally; missing configuration exits 2 and configured rerun exits 0. |

## Verdict

**A-11: READY WITH TRACKED RISK**

The required backup path is implemented, tested and operationally visible. No run can be
healthy on a local copy alone, and the Windows backend cannot become ready without a
configured external drive/share and a current verified pair. The qualification is TR-4:
the artifact-first independent review was performed by the same agent. This verdict does
not certify unrelated Work Packages or the full system.
