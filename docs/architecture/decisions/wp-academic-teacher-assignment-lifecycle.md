# Teacher Assignment Lifecycle — Architecture Decision (AC15)

**Status:** APPROVED (implementation authorized for the scope described below)
**Date:** 2026-09-06
**Applies to:** ending, extending, and handing over teacher assignments;
post-end read access; console transport.
**Supersedes:** nothing. Implements the decided D-F-058 and D-F-061–069
assignment requirements; D-F-059 (Owner access removal) stays with the
Access module, D-F-070 (teacher appeal) with HR, push notification
(D-F-069) with WP-5 Q.
**Related decisions:** gradesheets viewer rule (amended, not replaced);
assessment/attendance capability authorities (unchanged); Finance
untouched (no financial meaning in assignments).

## Problem

Assignments are create-only: an open assignment can never be ended, so
D-F-061–065 (handover approval, management continuance, reasoned
extensions with explicit end dates) have no path; ended teachers lose
all gradesheet access although D-F-058/066 keep read-only viewing
until term end; and handover is two unlinked calls with no integrity.

## Decision

1. **Three additive primitives on `MaintainClass` (same
   `academic.schedule` authority, no new capabilities):**
   `endAssignment` (open → dated, reason mandatory, date after start),
   `extendAssignment` (dated → later date, reason mandatory), and
   `handoverAssignment` (single transaction: end outgoing on the
   handover date + open the successor from that date, reason
   mandatory, successor must exist and hold no open assignment on the
   class). Every verb is idempotent, audited with before/after, and
   denial-audited. No migration: reasons live in audit events.
2. **"Open" keeps its certified meaning** (`effective_to IS NULL`):
   class activation, the duplicate guard, and the append-only trigger
   are untouched. Ending the last open assignment of an active class
   is allowed (D-F-062: management decides continuance procedurally);
   no class auto-transition is added.
3. **Gradesheet viewer gains the decided read-only tier** (D-F-058,
   D-F-066): an open assignment views as before; an ended assignment
   views while its class period has not ended (`ends_on >= today`),
   otherwise denied; oversight unchanged. Nothing is removed: no
   previously viewable gradesheet becomes denied.
4. **Mutation authority stays capability-based and unchanged**
   (D-F-067/068): scoring/moderation/approval/release/correction keep
   their capabilities, independence checks, and reason/audit rules; a
   viewer rule never grants mutation (already proven). Post-end edits
   remain possible only through these governed paths, and corrections
   always carry reason + audit.
5. **D-F-069 is met as audit + visible history:** every end/extend/
   handover records actor, reason, and before/after; the console shows
   the full dated history. Push notification belongs to WP-5 Q (no
   messaging primitive is invented here).
6. **Console transport** for end/extend/handover on the assignments
   table with per-state forms; dated history stays visible.

Out of scope: any assessment/attendance/class-lifecycle change, new
capabilities, Owner removal (Access), HR appeals, push notification,
API changes.

## Consequences

- Tests prove over HTTP: end → in-term read continuity → extend →
   handover with successor lineage and full history; refusals (end
   dated, extend open, bad date order, duplicate successor,
   post-term read denial); capability denials governed and audited.
- No migration, no seeder change, no API change, no new capabilities;
   no certified behavior altered.
