import { describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { db } from '../../../db/connection.js';
import { runReport } from '../../../core/reporting/report-engine.js';
import { today } from '../../../utils/ids.js';
import { createSession, seedContext, type Wp06Context } from './fixtures.js';

/**
 * WP-06 attendance authority (D-94): session marks live in `rosters` only;
 * day-level/teacher marks live in `attendance` only; every read surface
 * (list, summary, report metrics) sees exactly the union of the two — never a
 * mirror, so the two stores cannot drift apart.
 */

function daysAgo(n: number): string {
  const d = new Date(`${today()}T12:00:00`);
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A session that is always markable: today, starting at 00:00. */
async function markableSession(ctx: Wp06Context, date = today(), start = '00:00', end = '00:30') {
  return createSession(ctx, { date, start, end });
}

async function markBulk(
  ctx: Wp06Context,
  sessionId: string,
  records: Array<{ studentId: string; status: string; lateMinutes?: number }>,
  actor = ctx.receptionist,
) {
  return supertest(ctx.app).post(`/api/sessions/${sessionId}/roster`).set(actor).send({ records });
}

async function markOne(
  ctx: Wp06Context,
  sessionId: string,
  rosterId: string,
  body: { status: string; lateMinutes?: number },
  actor = ctx.receptionist,
) {
  return supertest(ctx.app).patch(`/api/sessions/${sessionId}/roster/${rosterId}`).set(actor).send(body);
}

function rosterId(sessionId: string, studentId: string): string {
  const row = db
    .prepare('SELECT id FROM rosters WHERE session_id = ? AND student_id = ?')
    .get(sessionId, studentId) as { id: string } | undefined;
  if (!row) throw new Error('roster fixture missing');
  return row.id;
}

describe('WP-06 attendance single-authority boundary', () => {
  it('a session mark is one roster fact, never mirrored into attendance', async () => {
    const ctx = seedContext();
    const sessionId = await markableSession(ctx);

    const res = await markBulk(ctx, sessionId, [{ studentId: ctx.studentA, status: 'present' }]);
    expect(res.status).toBe(201);

    const stray = db
      .prepare(`SELECT COUNT(*) AS c FROM attendance WHERE target_id = ? AND date = ?`)
      .get(ctx.studentA, today()) as { c: number };
    // The attendance table holds no session-anchored row — the roster row is
    // the only copy of the fact.
    expect(stray.c).toBe(0);

    const list = await supertest(ctx.app).get('/api/attendance').set(ctx.receptionist).query({ targetId: ctx.studentA });
    expect(list.status).toBe(200);
    const rows = list.body.filter((r: { target_id: string }) => r.target_id === ctx.studentA);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('present');
    expect(rows[0].session_id).toBe(sessionId);
  });

  it('the single-mark PATCH surface shows the same fact the bulk surface shows', async () => {
    const ctx = seedContext();
    // Start at 00:00, not later: marking is gated on the session having
    // STARTED, and a fixture start of 00:45 leaves the suite red whenever it
    // runs in the first 45 minutes of the day.
    const sessionId = await markableSession(ctx, today(), '00:00', '00:30');

    const res = await markOne(ctx, sessionId, rosterId(sessionId, ctx.studentB), { status: 'absent' });
    expect(res.status).toBe(200);

    const list = await supertest(ctx.app).get('/api/attendance').set(ctx.receptionist).query({ targetId: ctx.studentB });
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].status).toBe('absent');
    expect(list.body[0].session_id).toBe(sessionId);
  });

  it('a day-level mark and a session mark on the same day are two facts', async () => {
    const ctx = seedContext();
    const sessionId = await markableSession(ctx);
    await markBulk(ctx, sessionId, [{ studentId: ctx.studentA, status: 'present' }]);

    const day = await supertest(ctx.app)
      .post('/api/attendance')
      .set(ctx.manager)
      .send({ date: today(), records: [{ targetId: ctx.studentA, targetType: 'student', status: 'present' }] });
    expect(day.status).toBe(201);

    const summary = await supertest(ctx.app).get('/api/attendance/summary').set(ctx.receptionist).query({ targetId: ctx.studentA });
    expect(summary.status).toBe(200);
    const row = summary.body[0];
    expect(row.total).toBe(2);
    expect(row.rate).toBe(100);
  });

  it('teacher attendance never pollutes the student surfaces or metrics', async () => {
    const ctx = seedContext();
    const sessionId = await markableSession(ctx);
    await markBulk(ctx, sessionId, [{ studentId: ctx.studentA, status: 'present' }]);

    const teacherDay = await supertest(ctx.app)
      .post('/api/attendance')
      .set(ctx.manager)
      .send({ date: today(), records: [{ targetId: ctx.teacherId, targetType: 'teacher', status: 'present' }] });
    expect(teacherDay.status).toBe(201);

    const summary = await supertest(ctx.app).get('/api/attendance/summary').set(ctx.receptionist);
    expect(summary.status).toBe(200);
    expect(summary.body.filter((r: { targetId: string }) => r.targetId === ctx.teacherId)).toHaveLength(0);

    const result = runReport(db, 'attendance-summary', 'today', { branchId: ctx.branchA, isAll: false }, today());
    const present = result.metrics.find((m) => m.id === 'attendance.present')?.value ?? 0;
    const recorded = result.metrics.find((m) => m.id === 'attendance.recorded')?.value ?? 0;
    // One student session mark; the teacher row is a staff record and counts
    // nowhere in the student attendance report.
    expect(present).toBe(1);
    expect(recorded).toBe(1);
  });

  it('unmarked roster placeholders are not attendance facts', async () => {
    const ctx = seedContext();
    await markableSession(ctx);

    const list = await supertest(ctx.app).get('/api/attendance').set(ctx.receptionist).query({ targetId: ctx.studentA });
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(0);

    const summary = await supertest(ctx.app).get('/api/attendance/summary').set(ctx.receptionist).query({ targetId: ctx.studentA });
    expect(summary.status).toBe(200);
    expect(summary.body).toHaveLength(0);
  });

  it('the summary rate credits the attended-equivalent statuses', async () => {
    const ctx = seedContext();
    const s1 = await markableSession(ctx, daysAgo(2));
    const s2 = await markableSession(ctx, daysAgo(1));
    await markBulk(ctx, s1, [{ studentId: ctx.studentA, status: 'late', lateMinutes: 5 }]);
    await markBulk(ctx, s2, [{ studentId: ctx.studentA, status: 'online' }]);

    const summary = await supertest(ctx.app).get('/api/attendance/summary').set(ctx.receptionist).query({ targetId: ctx.studentA });
    expect(summary.status).toBe(200);
    expect(summary.body[0].total).toBe(2);
    expect(summary.body[0].rate).toBe(100);
  });

  it('serves the summary with no filters at all (org-wide caller)', async () => {
    const ctx = seedContext();
    const sessionId = await markableSession(ctx);
    await markBulk(ctx, sessionId, [{ studentId: ctx.studentA, status: 'present' }]);

    const summary = await supertest(ctx.app).get('/api/attendance/summary').set(ctx.owner).query({ branchId: 'all' });
    expect(summary.status).toBe(200);
    expect(summary.body.find((r: { targetId: string }) => r.targetId === ctx.studentA)).toBeDefined();
  });

  it('refuses to delete a session that carries recorded marks', async () => {
    const ctx = seedContext();
    const sessionId = await markableSession(ctx);
    await markBulk(ctx, sessionId, [{ studentId: ctx.studentA, status: 'present' }]);

    const del = await supertest(ctx.app).delete(`/api/sessions/${sessionId}`).set(ctx.manager);
    expect(del.status).toBe(409);
    expect(db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId)).toBeDefined();
  });

  it('allows deleting an unmarked session and cascades its placeholders', async () => {
    const ctx = seedContext();
    const sessionId = await markableSession(ctx);

    const del = await supertest(ctx.app).delete(`/api/sessions/${sessionId}`).set(ctx.manager);
    expect(del.status).toBe(200);
    expect(db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId)).toBeUndefined();
    expect((db.prepare('SELECT COUNT(*) AS c FROM rosters WHERE session_id = ?').get(sessionId) as { c: number }).c).toBe(0);
  });

  it('a completed session is immutable history unless a manager corrects it', async () => {
    const ctx = seedContext();
    const sessionId = await markableSession(ctx);
    const complete = await supertest(ctx.app)
      .patch(`/api/sessions/${sessionId}/status`)
      .set(ctx.receptionist)
      .send({ status: 'completed' });
    expect(complete.status).toBe(200);

    const move = await supertest(ctx.app)
      .put(`/api/sessions/${sessionId}`)
      .set(ctx.receptionist)
      .send({ date: daysAgo(1), startTime: '08:00', endTime: '09:30' });
    expect(move.status).toBe(409);

    const teacherCorrection = await markOne(ctx, sessionId, rosterId(sessionId, ctx.studentA), { status: 'absent' }, ctx.teacher);
    expect(teacherCorrection.status).toBe(400);

    const managerCorrection = await markOne(ctx, sessionId, rosterId(sessionId, ctx.studentA), { status: 'absent' }, ctx.manager);
    expect(managerCorrection.status).toBe(200);
  });
});
