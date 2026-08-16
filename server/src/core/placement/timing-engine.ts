/**
 * Placement Timing Engine — server-authoritative component and attempt
 * timers. The client is never the source of truth for time: deadlines are
 * computed and enforced on the server; late submissions are rejected and the
 * component is marked timed_out. Supports pause/resume (deadlines extended by
 * the pause span) and lazy attempt expiry.
 */
import { db } from '../../db/connection.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { stmtAttempt, stmtResults, upsertResult, type PolicyComponent } from './store.js';

/** Current UTC time as SQLite datetime('now') string. */
export function nowIso(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function isoToSeconds(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso.replace(' ', 'T') + 'Z');
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

/** Component time limit in seconds (timeLimitSeconds > durationMinutes). */
export function componentTimeLimitSeconds(c: PolicyComponent): number | null {
  if (c.timeLimitSeconds != null && c.timeLimitSeconds > 0) return c.timeLimitSeconds;
  if (c.durationMinutes != null && c.durationMinutes > 0) return Math.round(c.durationMinutes * 60);
  return null;
}

export function computeDeadline(startIso: string, limitSeconds: number): string {
  const t = isoToSeconds(startIso);
  if (t == null) return startIso;
  const d = new Date((t + limitSeconds) * 1000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

export interface TimingState {
  startedAt: string | null;
  deadlineAt: string | null;
  elapsedSeconds: number | null;
  timedOut: boolean;
  remainingSeconds: number | null;
}

/** Evaluate a component's timing state against now. */
export function timingState(result: any, now = nowIso()): TimingState {
  const startedAt: string | null = result.started_at ?? null;
  const deadlineAt: string | null = result.deadline_at ?? null;
  const nowSec = isoToSeconds(now) ?? 0;
  const startedSec = isoToSeconds(startedAt);
  const deadlineSec = isoToSeconds(deadlineAt);
  const timedOut = !!result.timeout_flag || (result.status === 'timed_out')
    || (deadlineSec != null && result.status !== 'completed' && result.status !== 'waived' && nowSec > deadlineSec);
  const remainingSeconds = deadlineSec != null ? Math.max(0, deadlineSec - nowSec) : null;
  const elapsedSeconds = result.elapsed_seconds != null
    ? Number(result.elapsed_seconds)
    : (startedSec != null ? Math.max(0, nowSec - startedSec) : null);
  return { startedAt, deadlineAt, elapsedSeconds, timedOut, remainingSeconds };
}

/** Lazily mark a timed-out component in the DB (idempotent). */
export function enforceComponentTimeout(attemptId: string, componentKey: string, result: any, now = nowIso()): void {
  const st = timingState(result, now);
  if (st.timedOut && result.status !== 'timed_out' && result.status !== 'completed' && result.status !== 'waived') {
    db.prepare(`UPDATE placement_assessment_results SET status='timed_out', timeout_flag=1, elapsed_seconds=?, updated_at=datetime('now') WHERE attempt_id=? AND component_key=?`)
      .run(st.elapsedSeconds ?? 0, attemptId, componentKey);
  }
}

/** Attempt-level expiry: in_progress attempt past its expires_at → expired. Returns true if just expired. */
export function expireAttemptIfNeeded(attempt: any, now = nowIso()): boolean {
  if (!attempt || attempt.status !== 'in_progress') return false;
  if (!attempt.expires_at) return false;
  if (isoToSeconds(now)! > (isoToSeconds(attempt.expires_at) ?? Infinity)) {
    db.prepare(`UPDATE placement_assessment_attempts SET status='expired', completed_at=datetime('now'), updated_at=datetime('now') WHERE id=? AND status='in_progress'`).run(attempt.id);
    return true;
  }
  return false;
}

/** Guard used by every mutating attempt route: expiry + status checks. */
export function assertAttemptEditable(attempt: any, now = nowIso()): void {
  if (!attempt) throw new HttpError(404, 'Placement attempt not found.');
  if (attempt.status === 'expired') throw new HttpError(409, 'This placement attempt has expired.');
  if (attempt.status === 'completed') throw new HttpError(409, 'This placement attempt is already completed.');
  if (attempt.status === 'cancelled') throw new HttpError(409, 'This placement attempt was cancelled.');
  if (attempt.status === 'paused') throw new HttpError(409, 'This placement attempt is paused. Resume it before continuing.');
  expireAttemptIfNeeded(attempt, now);
  // expireAttemptIfNeeded flips the DB row; re-read so the caller sees the
  // authoritative status (avoids acting on a stale in-memory object).
  const fresh = stmtAttempt.get(attempt.id) as any;
  if (fresh && fresh.status !== 'in_progress') throw new HttpError(409, fresh.status === 'expired' ? 'This placement attempt has expired.' : 'This placement attempt is no longer editable.');
}

/** Start a component timer (idempotent): sets started_at + deadline if absent. */
export function startComponentTimer(attemptId: string, componentKey: string, component: PolicyComponent, result: any, evaluatorUserId: string | null = null): void {
  if (result.started_at) return; // already started
  const limit = componentTimeLimitSeconds(component);
  const startedAt = nowIso();
  const deadlineAt: string | null = limit ? computeDeadline(startedAt, limit) : null;
  upsertResult({
    attemptId, key: componentKey, type: component.type, label: component.label,
    status: 'in_progress', score: null, maxScore: component.maxScore, weight: component.weight,
    evaluatorUserId, startedAt, deadlineAt,
  });
}

/**
 * Record submission timing: elapsed seconds + submitted_at; if the deadline
 * passed, mark timed_out and reject.
 */
export function recordSubmissionTiming(attemptId: string, componentKey: string, component: PolicyComponent, result: any, now = nowIso()): { timedOut: boolean; elapsedSeconds: number } {
  const st = timingState(result, now);
  const elapsedSeconds = st.elapsedSeconds ?? 0;
  if (st.timedOut) {
    db.prepare(`UPDATE placement_assessment_results SET status='timed_out', timeout_flag=1, submitted_at=?, elapsed_seconds=?, updated_at=datetime('now') WHERE attempt_id=? AND component_key=?`)
      .run(now, elapsedSeconds, attemptId, componentKey);
    throw new HttpError(409, `The time limit for "${component.label}" has expired; the component was marked timed out.`);
  }
  return { timedOut: false, elapsedSeconds };
}

/** Pause: freeze component timers + record attempt pause. */
export function pauseAttempt(attempt: any, reason?: string | null): { pausedAt: string } {
  if (attempt.status !== 'in_progress') throw new HttpError(409, 'Only an in-progress placement attempt can be paused.');
  const pausedAt = nowIso();
  db.transaction(() => {
    db.prepare(`UPDATE placement_assessment_attempts SET status='paused', paused_at=?, notes=COALESCE(notes,'') || ?, updated_at=datetime('now') WHERE id=?`).run(pausedAt, reason ? ` Paused: ${String(reason).trim().slice(0, 300)}` : '', attempt.id);
    db.prepare(`UPDATE placement_assessment_results SET paused_at=?, updated_at=datetime('now') WHERE attempt_id=? AND status IN ('in_progress','pending') AND started_at IS NOT NULL`).run(pausedAt, attempt.id);
  })();
  return { pausedAt };
}

/** Resume: shift deadlines by the pause span and restore in_progress. */
export function resumeAttempt(attempt: any): { resumedAt: string; pauseSeconds: number } {
  if (attempt.status !== 'paused') throw new HttpError(409, 'Only a paused placement attempt can be resumed.');
  const resumedAt = nowIso();
  const pausedSec = isoToSeconds(attempt.paused_at);
  const resumedSec = isoToSeconds(resumedAt);
  const pauseSeconds = pausedSec != null && resumedSec != null ? Math.max(0, resumedSec - pausedSec) : 0;
  db.transaction(() => {
    if (pauseSeconds > 0) {
      // Extend component deadlines + attempt expiry by the pause span.
      db.prepare(`UPDATE placement_assessment_results
        SET deadline_at = CASE WHEN deadline_at IS NOT NULL THEN datetime(deadline_at, ?) ELSE NULL END,
            paused_at = NULL, updated_at = datetime('now')
        WHERE attempt_id=? AND deadline_at IS NOT NULL`)
        .run(`+${pauseSeconds} seconds`, attempt.id);
      db.prepare(`UPDATE placement_assessment_attempts
        SET status='in_progress', resumed_at=?, paused_at=NULL, expires_at=CASE WHEN expires_at IS NOT NULL THEN datetime(expires_at, ?) ELSE NULL END, updated_at=datetime('now')
        WHERE id=?`).run(resumedAt, `+${pauseSeconds} seconds`, attempt.id);
    } else {
      db.prepare(`UPDATE placement_assessment_attempts SET status='in_progress', resumed_at=?, paused_at=NULL, updated_at=datetime('now') WHERE id=?`).run(resumedAt, attempt.id);
      db.prepare(`UPDATE placement_assessment_results SET paused_at=NULL, updated_at=datetime('now') WHERE attempt_id=?`).run(attempt.id);
    }
  })();
  return { resumedAt, pauseSeconds };
}

/** Serialize component timing for API views. */
export function componentTimingView(component: PolicyComponent, result: any): Record<string, unknown> {
  const st = timingState(result);
  return {
    startedAt: st.startedAt,
    deadlineAt: st.deadlineAt,
    elapsedSeconds: st.elapsedSeconds,
    timeout: st.timedOut,
    remainingSeconds: st.remainingSeconds,
    timeLimitSeconds: componentTimeLimitSeconds(component),
  };
}

export { stmtAttempt, stmtResults };
