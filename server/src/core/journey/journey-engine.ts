/**
 * Student Journey Engine
 * ----------------------
 * Center of the academic domain: Student is a static profile;
 * lifecycle is an append-only stream of journey events.
 * Current state is always projected from the event history.
 */
import type Database from 'better-sqlite3';
import { id } from '../../utils/ids.js';
import {
  JourneyEventType,
  JOURNEY_EVENT_LABELS,
  FINANCIAL_EVENT_TYPES,
  type JourneyEventTypeName,
} from './event-types.js';

// Extract financial event types for SQL IN clause safely (constants, no user input)
const FINANCIAL_EVENT_SQL_LIST = Array.from(FINANCIAL_EVENT_TYPES).map(e => `'${e}'`).join(',');

export interface AppendJourneyEventInput {
  studentId: string;
  eventType: JourneyEventTypeName | string;
  occurredAt?: string;
  branchId?: string | null;
  enrollmentId?: string | null;
  payload?: Record<string, unknown>;
  actorUserId?: string | null;
  actorName?: string | null;
  correlationId?: string | null;
  causationId?: string | null;
}

export interface JourneyEventRow {
  id: string;
  student_id: string;
  event_type: string;
  occurred_at: string;
  branch_id: string | null;
  enrollment_id: string | null;
  payload: string;
  actor_user_id: string | null;
  actor_name: string | null;
  correlation_id: string | null;
  causation_id: string | null;
  schema_version: number;
  created_at: string;
}

export interface TimelineItem {
  id: string;
  eventType: string;
  label: string;
  occurredAt: string;
  branchId: string | null;
  enrollmentId: string | null;
  payload: Record<string, unknown>;
  actorName: string | null;
  correlationId: string | null;
}

export interface StudentJourneyState {
  studentId: string;
  lifecycleStatus: string;
  currentProgram: string | null;
  currentLevel: string | null;
  currentSemester: string | null;
  currentClassId: string | null;
  currentEnrollmentId: string | null;
  enrollmentType: string | null;
  skillsFocus: string[] | null;
  placement: {
    overall: number | null;
    recommendedLevel: string | null;
    passed: boolean | null;
    scores: Record<string, number> | null;
  };
  finance: {
    invoicedTotal: number;
    paidTotal: number;
    remaining: number;
    lastPaymentAt: string | null;
  };
  idCard: {
    issued: boolean;
    lastIssuedAt: string | null;
    reprints: number;
  };
  books: Array<{ title?: string; status: string; at: string }>;
  lastExam: {
    title?: string;
    score?: number;
    status?: string;
    at: string;
  } | null;
  lastPromotion: {
    decision?: string;
    fromLevel?: string;
    toLevel?: string;
    at: string;
  } | null;
  eventCount: number;
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

// Helper to safely extract numbers from untrusted JSON payloads
function safeNum(val: unknown, fallback = 0): number {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

// Helper to safely extract strings
function safeStr(val: unknown): string | undefined {
  return typeof val === 'string' ? val : undefined;
}

export class StudentJourneyEngine {
  // ── Performance: Class-level Prepared Statements ───────────────────────
  private readonly stmtAppendEvent: Database.Statement;
  private readonly stmtListEvents: Database.Statement;
  private readonly stmtListFinancialEvents: Database.Statement;
  private readonly stmtInsertEnrollment: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.stmtAppendEvent = db.prepare(
      `INSERT INTO student_journey_events (
         id, student_id, event_type, occurred_at, branch_id, enrollment_id,
         payload, actor_user_id, actor_name, correlation_id, causation_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    
    this.stmtListEvents = db.prepare(
      `SELECT * FROM student_journey_events WHERE student_id = ? ORDER BY occurred_at ASC, created_at ASC, id ASC`
    );

    this.stmtListFinancialEvents = db.prepare(
      `SELECT * FROM student_journey_events 
       WHERE student_id = ? AND event_type IN (${FINANCIAL_EVENT_SQL_LIST}) 
       ORDER BY occurred_at ASC, created_at ASC`
    );

    this.stmtInsertEnrollment = db.prepare(
      `INSERT INTO enrollments (
         id, student_id, program_id, program_name, semester_name, level_code,
         class_id, branch_id, enrollment_type, status, skills_focus, started_at, notes
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
    );
  }

  /**
   * Append a lifecycle fact. Never updates or deletes prior events.
   * CRITICAL: If called externally, ensure it is wrapped in a transaction if other DB writes are happening.
   */
  appendEvent(input: AppendJourneyEventInput): TimelineItem {
    const eventId = id('sje');
    const occurredAt = input.occurredAt || new Date().toISOString().replace('T', ' ').slice(0, 19);
    const payload = JSON.stringify(input.payload || {});

    this.stmtAppendEvent.run(
      eventId, input.studentId, input.eventType, occurredAt,
      input.branchId ?? null, input.enrollmentId ?? null, payload,
      input.actorUserId ?? null, input.actorName ?? null,
      input.correlationId ?? null, input.causationId ?? null
    );

    return {
      id: eventId,
      eventType: input.eventType,
      label: JOURNEY_EVENT_LABELS[input.eventType as JourneyEventTypeName] || input.eventType,
      occurredAt,
      branchId: input.branchId ?? null,
      enrollmentId: input.enrollmentId ?? null,
      payload: input.payload || {},
      actorName: input.actorName ?? null,
      correlationId: input.correlationId ?? null,
    };
  }

  listEvents(studentId: string): JourneyEventRow[] {
    return this.stmtListEvents.all(studentId) as JourneyEventRow[];
  }

  getTimeline(studentId: string): TimelineItem[] {
    return this.listEvents(studentId).map((row) => ({
      id: row.id,
      eventType: row.event_type,
      label: JOURNEY_EVENT_LABELS[row.event_type as JourneyEventTypeName] || row.event_type,
      occurredAt: row.occurred_at,
      branchId: row.branch_id,
      enrollmentId: row.enrollment_id,
      payload: parsePayload(row.payload),
      actorName: row.actor_name,
      correlationId: row.correlation_id,
    }));
  }

  getFinancialTimeline(studentId: string): TimelineItem[] {
    const rows = this.stmtListFinancialEvents.all(studentId) as JourneyEventRow[];
    return rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      label: JOURNEY_EVENT_LABELS[row.event_type as JourneyEventTypeName] || row.event_type,
      occurredAt: row.occurred_at,
      branchId: row.branch_id,
      enrollmentId: row.enrollment_id,
      payload: parsePayload(row.payload),
      actorName: row.actor_name,
      correlationId: row.correlation_id,
    }));
  }

  /**
   * Project current lifecycle state purely from the event stream.
   */
  getCurrentState(studentId: string): StudentJourneyState {
    const events = this.listEvents(studentId);
    const state: StudentJourneyState = {
      studentId,
      lifecycleStatus: 'unknown',
      currentProgram: null,
      currentLevel: null,
      currentSemester: null,
      currentClassId: null,
      currentEnrollmentId: null,
      enrollmentType: null,
      skillsFocus: null,
      placement: { overall: null, recommendedLevel: null, passed: null, scores: null },
      finance: { invoicedTotal: 0, paidTotal: 0, remaining: 0, lastPaymentAt: null },
      idCard: { issued: false, lastIssuedAt: null, reprints: 0 },
      books: [],
      lastExam: null,
      lastPromotion: null,
      eventCount: events.length,
    };

    for (const row of events) {
      const p = parsePayload(row.payload);
      
      switch (row.event_type) {
        case JourneyEventType.STUDENT_REGISTERED:
          state.lifecycleStatus = 'registered';
          break;
          
        case JourneyEventType.PLACEMENT_TEST_RECORDED:
          state.placement.scores = (p.scores as Record<string, number>) || null;
          if (typeof p.overall === 'number') state.placement.overall = p.overall;
          state.placement.recommendedLevel = safeStr(p.recommendedLevel) || state.placement.recommendedLevel;
          break;
          
        case JourneyEventType.PLACEMENT_PASSED:
          state.placement.passed = true;
          state.placement.recommendedLevel = safeStr(p.recommendedLevel) || state.placement.recommendedLevel;
          state.currentLevel = safeStr(p.recommendedLevel) || state.currentLevel;
          break;
          
        case JourneyEventType.PLACEMENT_FAILED:
          state.placement.passed = false;
          break;
          
        case JourneyEventType.ENROLLMENT_CREATED:
        case JourneyEventType.RETAKE_STARTED:
        case JourneyEventType.PROGRAM_STARTED:
          state.currentEnrollmentId = row.enrollment_id || safeStr(p.enrollmentId) || null;
          state.currentProgram = safeStr(p.programName) || state.currentProgram;
          state.currentSemester = safeStr(p.semesterName) || state.currentSemester;
          state.currentLevel = safeStr(p.levelCode) || state.currentLevel;
          state.currentClassId = safeStr(p.classId) || state.currentClassId;
          state.enrollmentType = safeStr(p.enrollmentType) || state.enrollmentType;
          if (Array.isArray(p.skillsFocus)) state.skillsFocus = p.skillsFocus as string[];
          state.lifecycleStatus = 'enrolled';
          break;
          
        case JourneyEventType.CLASS_ASSIGNED:
          state.currentClassId = safeStr(p.classId) || state.currentClassId;
          break;
          
        case JourneyEventType.ENROLLMENT_STATUS_CHANGED:
        case JourneyEventType.STATUS_CHANGED:
          state.lifecycleStatus = safeStr(p.status) || state.lifecycleStatus;
          break;
          
        case JourneyEventType.INVOICE_ISSUED:
          state.finance.invoicedTotal += safeNum(p.amount, 0);
          break;
          
        case JourneyEventType.PAYMENT_RECORDED:
          state.finance.paidTotal += safeNum(p.amount, 0);
          state.finance.lastPaymentAt = row.occurred_at;
          break;
          
        case JourneyEventType.ID_CARD_ISSUED:
          state.idCard.issued = true;
          state.idCard.lastIssuedAt = row.occurred_at;
          break;
          
        case JourneyEventType.ID_CARD_REPRINTED:
          state.idCard.reprints += 1;
          state.idCard.lastIssuedAt = row.occurred_at;
          break;
          
        case JourneyEventType.BOOK_ISSUED:
        case JourneyEventType.BOOK_RETURNED:
        case JourneyEventType.BOOK_LOST:
          state.books.push({
            title: safeStr(p.title),
            status: row.event_type === JourneyEventType.BOOK_RETURNED 
              ? 'returned' 
              : row.event_type === JourneyEventType.BOOK_LOST 
                ? 'lost' 
                : 'issued',
            at: row.occurred_at,
          });
          break;
          
        case JourneyEventType.EXAM_RESULT_RECORDED:
          state.lastExam = {
            title: safeStr(p.title),
            score: safeNum(p.score, 0),
            status: safeStr(p.status),
            at: row.occurred_at,
          };
          break;
          
        case JourneyEventType.PROMOTION_DECIDED:
          state.lastPromotion = {
            decision: safeStr(p.decision),
            fromLevel: safeStr(p.fromLevel),
            toLevel: safeStr(p.toLevel),
            at: row.occurred_at,
          };
          if (p.decision === 'promote' && p.toLevel) {
            state.currentLevel = safeStr(p.toLevel) || state.currentLevel;
          }
          if (Array.isArray(p.skillsFocus)) state.skillsFocus = p.skillsFocus as string[];
          break;
          
        case JourneyEventType.GRADUATED:
          state.lifecycleStatus = 'graduated';
          break;
          
        case JourneyEventType.ALUMNI_ENTERED:
          state.lifecycleStatus = 'alumni';
          break;
          
        default:
          break;
      }
    }

    state.finance.remaining = Math.max(0, state.finance.invoicedTotal - state.finance.paidTotal);
    return state;
  }

  /**
   * Create a canonical enrollment row and emit ENROLLMENT_CREATED (or RETAKE / PROGRAM).
   */
  createEnrollment(params: {
    studentId: string;
    branchId: string;
    programId?: string | null;
    programName?: string | null;
    semesterName?: string | null;
    levelCode?: string | null;
    classId?: string | null;
    enrollmentType?: 'new' | 'repeat' | 'partial_repeat' | 'resume' | 'jump';
    skillsFocus?: string[] | null;
    notes?: string | null;
    actorUserId?: string | null;
    actorName?: string | null;
    startedAt?: string;
  }): { enrollmentId: string; event: TimelineItem } {
    const enrollmentId = id('enr');
    const startedAt = params.startedAt || new Date().toISOString().replace('T', ' ').slice(0, 19);
    const enrollmentType = params.enrollmentType || 'new';
    const skillsJson = params.skillsFocus ? JSON.stringify(params.skillsFocus) : null;

    const eventType =
      enrollmentType === 'repeat' || enrollmentType === 'partial_repeat'
        ? JourneyEventType.RETAKE_STARTED
        : enrollmentType === 'jump'
          ? JourneyEventType.PROGRAM_STARTED
          : JourneyEventType.ENROLLMENT_CREATED;

    // Wrap DB operations in a transaction to guarantee Event Sourcing atomicity
    const createTx = this.db.transaction(() => {
      this.stmtInsertEnrollment.run(
        enrollmentId, params.studentId, params.programId ?? null, params.programName ?? null,
        params.semesterName ?? null, params.levelCode ?? null, params.classId ?? null,
        params.branchId, enrollmentType, skillsJson, startedAt, params.notes ?? null
      );

      return this.appendEvent({
        studentId: params.studentId,
        eventType,
        occurredAt: startedAt,
        branchId: params.branchId,
        enrollmentId,
        actorUserId: params.actorUserId,
        actorName: params.actorName,
        payload: {
          enrollmentId, enrollmentType,
          programName: params.programName,
          semesterName: params.semesterName,
          levelCode: params.levelCode,
          classId: params.classId,
          skillsFocus: params.skillsFocus,
        },
      });
    });

    const event = createTx();
    return { enrollmentId, event };
  }
}

export function getJourneyEngine(db: Database.Database): StudentJourneyEngine {
  return new StudentJourneyEngine(db);
}