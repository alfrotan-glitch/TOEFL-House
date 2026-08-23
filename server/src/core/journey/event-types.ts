/**
 * Student Journey event vocabulary.
 * Events are append-only facts. Current state is always projected from history.
 */
export const JourneyEventType = {
  STUDENT_REGISTERED: 'journey.student_registered',
  PLACEMENT_TEST_RECORDED: 'journey.placement_test_recorded',
  PLACEMENT_PASSED: 'journey.placement_passed',
  PLACEMENT_FAILED: 'journey.placement_failed',
  ENROLLMENT_CREATED: 'journey.enrollment_created',
  ENROLLMENT_STATUS_CHANGED: 'journey.enrollment_status_changed',
  CLASS_ASSIGNED: 'journey.class_assigned',
  INVOICE_ISSUED: 'journey.invoice_issued',
  PAYMENT_RECORDED: 'journey.payment_recorded',
  ID_CARD_ISSUED: 'journey.id_card_issued',
  ID_CARD_REPRINTED: 'journey.id_card_reprinted',
  BOOK_ISSUED: 'journey.book_issued',
  BOOK_RETURNED: 'journey.book_returned',
  ATTENDANCE_RECORDED: 'journey.attendance_recorded',
  EXAM_RESULT_RECORDED: 'journey.exam_result_recorded',
  PROMOTION_DECIDED: 'journey.promotion_decided',
  RETAKE_STARTED: 'journey.retake_started',
  STATUS_CHANGED: 'journey.status_changed',
  GRADUATED: 'journey.graduated',
  ALUMNI_ENTERED: 'journey.alumni_entered',
  PROGRAM_STARTED: 'journey.program_started',
  NOTE_ADDED: 'journey.note_added',
} as const;

export type JourneyEventTypeName = (typeof JourneyEventType)[keyof typeof JourneyEventType];
// Usage in other files: if (FINANCIAL_EVENT_TYPES.has(eventType)) { ... }
export const FINANCIAL_EVENT_TYPES: Set<JourneyEventTypeName> = new Set([
  JourneyEventType.INVOICE_ISSUED,
  JourneyEventType.PAYMENT_RECORDED,
]);

export const JOURNEY_EVENT_LABELS: Record<JourneyEventTypeName, string> = {
  [JourneyEventType.STUDENT_REGISTERED]: 'Registered',
  [JourneyEventType.PLACEMENT_TEST_RECORDED]: 'Placement test recorded',
  [JourneyEventType.PLACEMENT_PASSED]: 'Placement passed',
  [JourneyEventType.PLACEMENT_FAILED]: 'Placement failed',
  [JourneyEventType.ENROLLMENT_CREATED]: 'Enrollment created',
  [JourneyEventType.ENROLLMENT_STATUS_CHANGED]: 'Enrollment status changed',
  [JourneyEventType.CLASS_ASSIGNED]: 'Assigned to class',
  [JourneyEventType.INVOICE_ISSUED]: 'Invoice issued',
  [JourneyEventType.PAYMENT_RECORDED]: 'Payment recorded',
  [JourneyEventType.ID_CARD_ISSUED]: 'ID card issued',
  [JourneyEventType.ID_CARD_REPRINTED]: 'ID card reprinted',
  [JourneyEventType.BOOK_ISSUED]: 'Book issued',
  [JourneyEventType.BOOK_RETURNED]: 'Book returned',
  [JourneyEventType.ATTENDANCE_RECORDED]: 'Attendance recorded',
  [JourneyEventType.EXAM_RESULT_RECORDED]: 'Exam result recorded',
  [JourneyEventType.PROMOTION_DECIDED]: 'Promotion decision',
  [JourneyEventType.RETAKE_STARTED]: 'Retake started',
  [JourneyEventType.STATUS_CHANGED]: 'Status changed',
  [JourneyEventType.GRADUATED]: 'Graduated',
  [JourneyEventType.ALUMNI_ENTERED]: 'Entered alumni',
  [JourneyEventType.PROGRAM_STARTED]: 'Program started',
  [JourneyEventType.NOTE_ADDED]: 'Note added',
};