/**
 * Student Journey Engine
 * ----------------------
 * Maintains an append-only chronology of student activity. Current lifecycle,
 * enrollment, placement snapshot, and card facts are overlaid from their
 * canonical tables so this stream never becomes a competing state authority.
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
    const parsed = JSON.parse(raw || '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

const FINANCIAL_PAYLOAD_KEY = /(amount|fee|tuition|balance|paid|payment|invoice|receipt|discount|price|cost)/i;

function redactFinancialValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactFinancialValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !FINANCIAL_PAYLOAD_KEY.test(key))
      .map(([key, nested]) => [key, redactFinancialValue(nested)]),
  );
}

function redactFinancialPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return redactFinancialValue(payload) as Record<string, unknown>;
}

function parsePayloadArray(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.every((value) => typeof value === 'string')
      ? parsed
      : null;
  } catch {
    return null;
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
  private readonly stmtGetStudentState: Database.Statement;
  private readonly stmtGetCurrentEnrollment: Database.Statement;

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
       ORDER BY occurred_at ASC, created_at ASC, id ASC`
    );
    this.stmtGetStudentState = db.prepare(
      'SELECT status, card_design, placement_score FROM students WHERE id = ?',
    );
    this.stmtGetCurrentEnrollment = db.prepare(
      `SELECT id, program_name, level_code, semester_name, class_id, enrollment_type, skills_focus
         FROM enrollments
        WHERE student_id = ?
          AND enrollment_type <> 'extra'
          AND status IN ('pending','reserved','confirmed','active','frozen','paused','suspended','retake','conditional_pass')
        ORDER BY started_at DESC, created_at DESC, id DESC
        LIMIT 1`,
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

  /**
   * The ACADEMIC lifecycle timeline.
   *
   * Financial events are excluded. They have their own timeline
   * (getFinancialTimeline) and rendering an invoice or payment in both places
   * duplicated the same transaction in the student profile: the academic
   * history became a second, weaker copy of the ledger, and the two views
   * disagreed the moment one was filtered differently.
   *
   * `listEvents` still returns the complete, unfiltered event log — this is a
   * presentation split, not a loss of history. Anything needing the full
   * chronology (audit, projection, `getState`) keeps using listEvents.
   */
  getTimeline(studentId: string, includeFinancialFields = false): TimelineItem[] {
    return this.listEvents(studentId)
      .filter((row) => !FINANCIAL_EVENT_TYPES.has(row.event_type as JourneyEventTypeName))
      .map((row) => {
        const payload = parsePayload(row.payload);
        return {
          id: row.id,
          eventType: row.event_type,
          label: JOURNEY_EVENT_LABELS[row.event_type as JourneyEventTypeName] || row.event_type,
          occurredAt: row.occurred_at,
          branchId: row.branch_id,
          enrollmentId: row.enrollment_id,
          payload: includeFinancialFields ? payload : redactFinancialPayload(payload),
          actorName: row.actor_name,
          correlationId: row.correlation_id,
        };
      });
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

  /** Project chronology-derived details, then overlay canonical current facts. */
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
          
        // Financial events remain in the append-only audit timeline, but money
        // is not projected here. Invoices/payments and studentBalance are the
        // canonical financial authorities; an activity stream can be missing a
        // historical event and must never become a second ledger.
        case JourneyEventType.INVOICE_ISSUED:
        case JourneyEventType.PAYMENT_RECORDED:
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

    // Current facts come from their canonical tables. The event stream is a
    // chronology, not a shadow status/enrollment database: status changes made
    // through the dedicated lifecycle routes and historical imports may not
    // have a corresponding old event.
    const student = this.stmtGetStudentState.get(studentId) as
      | { status: string; card_design: string | null; placement_score: string | null }
      | undefined;
    if (student) {
      state.lifecycleStatus = student.status;
      state.idCard.issued = Boolean(student.card_design);
      const placement = student.placement_score ? parsePayload(student.placement_score) : {};
      if (Object.keys(placement).length > 0) {
        const overall = placement.overall ?? placement.total ?? placement.percentage ?? placement.totalScore;
        if (typeof overall === 'number' && Number.isFinite(overall)) state.placement.overall = overall;
        const recommendation = placement.recommendation && typeof placement.recommendation === 'object'
          ? placement.recommendation as Record<string, unknown>
          : {};
        state.placement.recommendedLevel = safeStr(
          placement.recommendedLevel
          ?? placement.levelRecommendation
          ?? recommendation.text
          ?? recommendation.levelId,
        ) || state.placement.recommendedLevel;
        if (typeof placement.passed === 'boolean') {
          state.placement.passed = placement.passed;
        } else if (placement.outcome === 'passed' || placement.outcome === 'failed') {
          state.placement.passed = placement.outcome === 'passed';
        }
        if (placement.scores && typeof placement.scores === 'object' && !Array.isArray(placement.scores)) {
          state.placement.scores = placement.scores as Record<string, number>;
        } else if (Array.isArray(placement.results)) {
          const scores = Object.fromEntries(placement.results.flatMap((result, index) => {
            if (!result || typeof result !== 'object') return [];
            const row = result as Record<string, unknown>;
            const value = row.score ?? row.percentage;
            if (typeof value !== 'number' || !Number.isFinite(value)) return [];
            const key = safeStr(row.component_key ?? row.key ?? row.label) || `component-${index + 1}`;
            return [[key, value]];
          }));
          if (Object.keys(scores).length > 0) state.placement.scores = scores;
        }
      }
    }
    const enrollment = this.stmtGetCurrentEnrollment.get(studentId) as
      | {
          id: string;
          program_name: string | null;
          level_code: string | null;
          semester_name: string | null;
          class_id: string | null;
          enrollment_type: string | null;
          skills_focus: string | null;
        }
      | undefined;
    if (enrollment) {
      state.currentEnrollmentId = enrollment.id;
      state.currentProgram = enrollment.program_name;
      state.currentLevel = enrollment.level_code;
      state.currentSemester = enrollment.semester_name;
      state.currentClassId = enrollment.class_id;
      state.enrollmentType = enrollment.enrollment_type;
      const skills = parsePayloadArray(enrollment.skills_focus);
      state.skillsFocus = skills;
    } else {
      state.currentEnrollmentId = null;
      state.currentProgram = null;
      state.currentLevel = null;
      state.currentSemester = null;
      state.currentClassId = null;
      state.enrollmentType = null;
      state.skillsFocus = null;
    }
    return state;
  }

  // Enrollment creation belongs exclusively to EnrollmentService.enroll(),
  // where capacity, placement, gender, duplicate, branch and lifecycle guards
  // execute together. The journey layer records chronology via appendEvent()
  // and intentionally exposes no independent enrollment INSERT path.
}

export function getJourneyEngine(db: Database.Database): StudentJourneyEngine {
  return new StudentJourneyEngine(db);
}