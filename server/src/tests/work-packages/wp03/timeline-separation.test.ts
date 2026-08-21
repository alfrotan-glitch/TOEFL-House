/**
 * Academic and financial timelines are distinct views
 * ============================================================================
 * ISSUE 6, reproduced against the running API:
 *
 *   ACADEMIC  : [student_registered, payment_recorded, enrollment_created]
 *   FINANCIAL : [payment_recorded]
 *
 * `getTimeline` returned every event, so each payment and invoice appeared in
 * BOTH panels of the student profile. The academic history became a second,
 * weaker copy of the ledger — and the two views would disagree the moment one
 * was filtered or paginated differently.
 *
 * The rule: the academic timeline carries lifecycle events, the financial
 * timeline carries money events, and no event type appears in both. The
 * underlying event log stays complete — this is a presentation split, so
 * nothing may be lost from `listEvents`, which audit and state projection use.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { db, initSchema } from '../../../db/connection.js';
import { getJourneyEngine } from '../../../core/journey/journey-engine.js';
import { JourneyEventType, FINANCIAL_EVENT_TYPES } from '../../../core/journey/event-types.js';
import { today } from '../../../utils/ids.js';

const BRANCH = 'tl_branch';
const STUDENT = 'tl_student';

beforeAll(() => {
  initSchema();
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'Timeline Branch', 'Loc');
  db.prepare(
    `INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender)
     VALUES (?, ?, ?, 'active', ?, ?, 'male')`
  ).run(STUDENT, 'TH-TL-001', 'Timeline Student', today(), BRANCH);

  const engine = getJourneyEngine(db);
  // A realistic mix: lifecycle events interleaved with money events.
  engine.appendEvent({ studentId: STUDENT, eventType: JourneyEventType.STUDENT_REGISTERED, branchId: BRANCH, payload: {} });
  engine.appendEvent({ studentId: STUDENT, eventType: JourneyEventType.ENROLLMENT_CREATED, branchId: BRANCH, payload: {} });
  engine.appendEvent({ studentId: STUDENT, eventType: JourneyEventType.INVOICE_ISSUED, branchId: BRANCH, payload: { amount: 5000 } });
  engine.appendEvent({ studentId: STUDENT, eventType: JourneyEventType.PAYMENT_RECORDED, branchId: BRANCH, payload: { amount: 2000 } });
  engine.appendEvent({ studentId: STUDENT, eventType: JourneyEventType.CLASS_ASSIGNED, branchId: BRANCH, payload: {} });
});

describe('student profile timelines do not duplicate each other', () => {
  it('the academic timeline contains no financial events', () => {
    const academic = getJourneyEngine(db).getTimeline(STUDENT).map((i) => i.eventType);

    expect(academic).toContain(JourneyEventType.ENROLLMENT_CREATED);
    expect(academic).toContain(JourneyEventType.CLASS_ASSIGNED);
    // The regression: these used to appear here too.
    expect(academic).not.toContain(JourneyEventType.PAYMENT_RECORDED);
    expect(academic).not.toContain(JourneyEventType.INVOICE_ISSUED);
    for (const type of academic) {
      expect(FINANCIAL_EVENT_TYPES.has(type as never)).toBe(false);
    }
  });

  it('the financial timeline contains the financial events', () => {
    const financial = getJourneyEngine(db).getFinancialTimeline(STUDENT).map((i) => i.eventType);
    expect(financial).toContain(JourneyEventType.PAYMENT_RECORDED);
    expect(financial).toContain(JourneyEventType.INVOICE_ISSUED);
    // ...and none of the academic lifecycle noise.
    expect(financial).not.toContain(JourneyEventType.CLASS_ASSIGNED);
  });

  it('no event type appears in both timelines', () => {
    const engine = getJourneyEngine(db);
    const academic = new Set(engine.getTimeline(STUDENT).map((i) => i.eventType));
    const financial = new Set(engine.getFinancialTimeline(STUDENT).map((i) => i.eventType));
    const both = [...academic].filter((t) => financial.has(t));
    expect(both, `event types duplicated across timelines: ${both.join(', ')}`).toEqual([]);
  });

  it('the underlying event log keeps every event — nothing is deleted', () => {
    // The split is presentational. Audit and state projection read listEvents,
    // which must still see the complete history.
    const all = getJourneyEngine(db).listEvents(STUDENT).map((r) => r.event_type);
    expect(all).toContain(JourneyEventType.PAYMENT_RECORDED);
    expect(all).toContain(JourneyEventType.INVOICE_ISSUED);
    expect(all).toContain(JourneyEventType.CLASS_ASSIGNED);
    expect(all.length).toBe(5);
  });
});
