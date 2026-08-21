import { describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { today } from '../../../utils/ids.js';
import { createSession, seedContext, type Wp06Context } from './fixtures.js';

/**
 * WP-06 session input hardening (D-97): calendar dates and times-of-day are
 * validated at the API boundary, the timetable generator refuses impossible
 * windows, and every rejection leaves the database untouched.
 */

describe('WP-06 session input guards', () => {
  async function expectRejected(ctx: Wp06Context, method: 'post' | 'put', url: string, body: unknown, actor = ctx.receptionist) {
    const res = await supertest(ctx.app)[method](url).set(actor).send(body as object);
    expect(res.status).toBe(400);
    return res;
  }

  it('rejects sessions with malformed or impossible dates', async () => {
    const ctx = seedContext();
    await expectRejected(ctx, 'post', '/api/sessions', {
      classId: ctx.classId, date: '2026-13-99', startTime: '08:00', endTime: '09:30',
    });
    await expectRejected(ctx, 'post', '/api/sessions', {
      classId: ctx.classId, date: 'not-a-date', startTime: '08:00', endTime: '09:30',
    });
    await expectRejected(ctx, 'post', '/api/sessions', {
      classId: ctx.classId, date: '2026-02-30', startTime: '08:00', endTime: '09:30',
    });
  });

  it('rejects sessions with malformed or reversed times', async () => {
    const ctx = seedContext();
    await expectRejected(ctx, 'post', '/api/sessions', {
      classId: ctx.classId, date: today(), startTime: '25:99', endTime: '09:30',
    });
    await expectRejected(ctx, 'post', '/api/sessions', {
      classId: ctx.classId, date: today(), startTime: '09:30', endTime: '09:30',
    });
    await expectRejected(ctx, 'post', '/api/sessions', {
      classId: ctx.classId, date: today(), startTime: '11:00', endTime: '09:30',
    });
  });

  it('normalizes a human time spelling to the canonical HH:MM', async () => {
    const ctx = seedContext();
    const res = await supertest(ctx.app).post('/api/sessions').set(ctx.receptionist).send({
      classId: ctx.classId, date: '2026-09-01', startTime: '8:05', endTime: '9:30',
    });
    expect(res.status).toBe(201);
    expect(res.body.startTime).toBe('08:05');
  });

  it('rejects an edited session with an invalid date or time', async () => {
    const ctx = seedContext();
    const sessionId = await createSession(ctx);
    await expectRejected(ctx, 'put', `/api/sessions/${sessionId}`, { date: 'garbage' });
    await expectRejected(ctx, 'put', `/api/sessions/${sessionId}`, { startTime: 'morning' });
    await expectRejected(ctx, 'put', `/api/sessions/${sessionId}`, { endTime: '07:00' });
  });

  it('timetable generation validates weeks, days and times', async () => {
    const ctx = seedContext();
    await expectRejected(ctx, 'post', '/api/sessions/generate', {
      classId: ctx.classId, weekStart: today(), weeks: 0, daysOfWeek: [1], startTime: '09:00', endTime: '10:00',
    });
    await expectRejected(ctx, 'post', '/api/sessions/generate', {
      classId: ctx.classId, weekStart: today(), weeks: 13, daysOfWeek: [1], startTime: '09:00', endTime: '10:00',
    });
    await expectRejected(ctx, 'post', '/api/sessions/generate', {
      classId: ctx.classId, weekStart: today(), weeks: 'abc', daysOfWeek: [1], startTime: '09:00', endTime: '10:00',
    });
    await expectRejected(ctx, 'post', '/api/sessions/generate', {
      classId: ctx.classId, weekStart: today(), weeks: 1, daysOfWeek: [9], startTime: '09:00', endTime: '10:00',
    });
    await expectRejected(ctx, 'post', '/api/sessions/generate', {
      classId: ctx.classId, weekStart: today(), weeks: 1, daysOfWeek: [1], startTime: '26:00', endTime: '10:00',
    });
    await expectRejected(ctx, 'post', '/api/sessions/generate', {
      classId: ctx.classId, weekStart: 'not-a-date', weeks: 1, daysOfWeek: [1], startTime: '09:00', endTime: '10:00',
    });
  });

  it('rejects homework with a malformed due date', async () => {
    const ctx = seedContext();
    const sessionId = await createSession(ctx);
    const res = await supertest(ctx.app).post(`/api/sessions/${sessionId}/homework`).set(ctx.teacher).send({
      title: 'Unit 1', dueDate: '2026-99-99',
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid roster commands and duplicate student ids', async () => {
    const ctx = seedContext();
    // A session that has already started — roster guards apply after the
    // started-session lock.
    const sessionId = await createSession(ctx, { date: today(), start: '00:00', end: '00:30' });
    const bad = await supertest(ctx.app).post(`/api/sessions/${sessionId}/roster`).set(ctx.receptionist).send({
      records: [{ studentId: ctx.studentA, status: 'levitating' }],
    });
    expect(bad.status).toBe(400);

    const dup = await supertest(ctx.app).post(`/api/sessions/${sessionId}/roster`).set(ctx.receptionist).send({
      records: [
        { studentId: ctx.studentA, status: 'present' },
        { studentId: ctx.studentA, status: 'absent' },
      ],
    });
    expect(dup.status).toBe(400);

    const stranger = await supertest(ctx.app).post(`/api/sessions/${sessionId}/roster`).set(ctx.receptionist).send({
      records: [{ studentId: 'no-such-student', status: 'present' }],
    });
    expect(stranger.status).toBe(409);
  });

  it('rejects completing a session before it starts and bogus status values', async () => {
    const ctx = seedContext();
    const sessionId = await createSession(ctx, { date: '2026-09-01', start: '08:00', end: '09:30' });
    const bogus = await supertest(ctx.app).patch(`/api/sessions/${sessionId}/status`).set(ctx.receptionist).send({ status: 'archived' });
    expect(bogus.status).toBe(400);

    const early = await supertest(ctx.app).patch(`/api/sessions/${sessionId}/status`).set(ctx.receptionist).send({ status: 'completed' });
    expect(early.status).toBe(400);
  });
});
