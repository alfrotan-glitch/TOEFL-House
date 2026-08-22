/**
TOEFL House ERP — Impact Routes (BC #12)
============================================================
REST endpoints for the Impact Bounded Context: impact metrics,
auto-generated donor reports, and success stories.

The report generator computes every figure directly from operational
data (students, attendance, scholarships, donations, sponsorships) —
nothing is hand-entered, so donor reports always reflect the ledger.

Access control:
  donor_manager, manager, owner: full CRUD + report generation
  finance: read-only (reconciliation against donations ledger)
  registrar: read-only metrics (enrollment figures)

@module routes/impact.routes
@version 2.0.0
@license Apache-2.0
*/
import { Router } from 'express';
import { db } from '../db/connection.js';
import { authenticate, authorize, resolveBranchScope, canAccessBranchResource } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { id } from '../utils/ids.js';
import { addNotification } from '../utils/notifications.js';
import { eventBus } from '../core/events/event-bus.js';
import { ATTENDED_EQUIVALENT_STATUSES } from '../core/academic/attendance-policy-service.js';
import { STUDENT_ATTENDANCE_UNION } from '../core/academic/attendance-query.js';
import { periodBoundariesForKey } from '../core/calendar/periods.js';

export const impactRouter = Router();
impactRouter.use(authenticate);

// ── Performance Optimization: Prepared Statements ──────────────────────────
// Metrics
const stmtGetAllMetrics = db.prepare('SELECT * FROM impact_metrics ORDER BY category, name');
const stmtGetMetricsByBranch = db.prepare('SELECT * FROM impact_metrics WHERE branch_id = ? ORDER BY category, name');
const stmtGetMetricByNamePeriod = db.prepare('SELECT id FROM impact_metrics WHERE name = ? AND period = ? AND branch_id = ?');
const stmtUpdateMetric = db.prepare('UPDATE impact_metrics SET category = ?, target_value = ?, current_value = ? WHERE id = ?');
const stmtInsertMetric = db.prepare(
  `INSERT INTO impact_metrics (id, name, category, target_value, current_value, period, branch_id) VALUES (?, ?, ?, ?, ?, ?, ?)`
);

// Reports
const stmtGetAllReports = db.prepare(
  `SELECT ir.*, d.full_name AS donor_name, fc.name AS campaign_name FROM impact_reports ir LEFT JOIN donors d ON d.id = ir.donor_id LEFT JOIN funding_campaigns fc ON fc.id = ir.campaign_id ORDER BY ir.generated_at DESC`
);
const stmtGetReportsByBranch = db.prepare(
  `SELECT ir.*, d.full_name AS donor_name, fc.name AS campaign_name FROM impact_reports ir LEFT JOIN donors d ON d.id = ir.donor_id LEFT JOIN funding_campaigns fc ON fc.id = ir.campaign_id WHERE ir.branch_id = ? ORDER BY ir.generated_at DESC`
);
const stmtGetReportById = db.prepare('SELECT * FROM impact_reports WHERE id = ?');
const stmtInsertReport = db.prepare(
  `INSERT INTO impact_reports (id, title, donor_id, campaign_id, period, generated_at, metrics, narrative, status, branch_id) VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?, 'draft', ?)`
);
const stmtUpdateReport = db.prepare('UPDATE impact_reports SET status = ?, narrative = ? WHERE id = ?');

// Stories
const stmtGetAllStories = db.prepare(
  `SELECT ss.*, s.full_name AS student_name, s.student_code FROM success_stories ss JOIN students s ON s.id = ss.student_id ORDER BY ss.published_at DESC`
);
const stmtGetStoriesByBranch = db.prepare(
  `SELECT ss.*, s.full_name AS student_name, s.student_code FROM success_stories ss JOIN students s ON s.id = ss.student_id WHERE ss.branch_id = ? ORDER BY ss.published_at DESC`
);
const stmtInsertStory = db.prepare(
  `INSERT INTO success_stories (id, student_id, title, content, photo_url, published_at, tags, branch_id) VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?)`
);
const stmtGetStudentById = db.prepare('SELECT * FROM students WHERE id = ?');

// Report Generation Aggregations
const stmtCountTotalEnrolled = db.prepare('SELECT COUNT(*) AS totalEnrolled FROM students WHERE branch_id = ?');
const stmtCountEnrolledInPeriod = db.prepare('SELECT COUNT(*) AS enrolledInPeriod FROM students WHERE branch_id = ? AND registration_date BETWEEN ? AND ?');
const stmtCountFemaleStudents = db.prepare("SELECT COUNT(*) AS femaleStudents FROM students WHERE branch_id = ? AND gender = 'female'");
const stmtCountScholarshipRecipients = db.prepare('SELECT COUNT(DISTINCT student_id) AS scholarshipRecipients FROM scholarship_awards WHERE branch_id = ? AND award_date BETWEEN ? AND ?');
const stmtSumScholarshipAmount = db.prepare('SELECT COALESCE(SUM(amount), 0) AS scholarshipAmount FROM scholarship_awards WHERE branch_id = ? AND award_date BETWEEN ? AND ?');
const stmtSumDonations = db.prepare('SELECT COALESCE(SUM(amount), 0) AS donationsTotal FROM donations WHERE branch_id = ? AND date BETWEEN ? AND ?');
const stmtCountSponsoredStudents = db.prepare("SELECT COUNT(DISTINCT student_id) AS sponsoredStudents FROM sponsorship_agreements WHERE branch_id = ? AND status = 'active' AND student_id IS NOT NULL");
const stmtCountGraduates = db.prepare("SELECT COUNT(*) AS graduates FROM students WHERE branch_id = ? AND status = 'graduated'");
const stmtGetAttendanceStats = db.prepare(
  `SELECT COUNT(*) AS total, SUM(CASE WHEN status IN (${ATTENDED_EQUIVALENT_STATUSES.map(() => '?').join(',')}) THEN 1 ELSE 0 END) AS attended
   FROM (${STUDENT_ATTENDANCE_UNION})
   WHERE branch_id = ? AND date BETWEEN ? AND ?`
);

// Summary Aggregations
const stmtSumTotalDonationsAll = db.prepare('SELECT COALESCE(SUM(amount), 0) AS totalDonations FROM donations');
const stmtSumTotalDonationsByBranch = db.prepare('SELECT COALESCE(SUM(amount), 0) AS totalDonations FROM donations WHERE branch_id = ?');
const stmtCountAllStudents = db.prepare('SELECT COUNT(*) AS totalEnrolled FROM students');
const stmtCountStudentsByBranch = db.prepare('SELECT COUNT(*) AS totalEnrolled FROM students WHERE branch_id = ?');
const stmtCountAllFemaleStudents = db.prepare("SELECT COUNT(*) AS femaleStudents FROM students WHERE gender = 'female'");
const stmtCountFemaleStudentsByBranch = db.prepare("SELECT COUNT(*) AS femaleStudents FROM students WHERE branch_id = ? AND gender = 'female'");
const stmtCountAllScholarshipRecipients = db.prepare('SELECT COUNT(DISTINCT student_id) AS scholarshipRecipients FROM scholarship_awards');
const stmtCountScholarshipRecipientsByBranch = db.prepare('SELECT COUNT(DISTINCT student_id) AS scholarshipRecipients FROM scholarship_awards WHERE branch_id = ?');
const stmtCountAllGraduates = db.prepare("SELECT COUNT(*) AS graduates FROM students WHERE status = 'graduated'");
const stmtCountGraduatesByBranch = db.prepare("SELECT COUNT(*) AS graduates FROM students WHERE branch_id = ? AND status = 'graduated'");
const stmtCountAllPublishedReports = db.prepare("SELECT COUNT(*) AS publishedReports FROM impact_reports WHERE status != 'draft'");
const stmtCountPublishedReportsByBranch = db.prepare("SELECT COUNT(*) AS publishedReports FROM impact_reports WHERE branch_id = ? AND status != 'draft'");

/** Safely extracts user context required for mutations */
function getUserContext(req: import('express').Request) {
  const user = req.user;
  if (!user?.userId || !user?.branchId) {
    throw new HttpError(403, 'User context is missing for impact operation.');
  }
  return user;
}

// ============================================================================
// §1 — IMPACT METRICS
// ============================================================================

impactRouter.get(
  '/metrics',
  authorize('owner', 'general_manager', 'finance_manager', 'donor_manager', 'receptionist'),
  ah(async (req, res) => {
    const { branchId, isAll } = resolveBranchScope(req);
    const period = req.query.period as string | undefined;
    
    let rows = isAll ? stmtGetAllMetrics.all() : stmtGetMetricsByBranch.all(branchId);
    if (period) {
      rows = (rows as any[]).filter(r => r.period === period);
    }
    res.json(rows);
  })
);

impactRouter.post(
  '/metrics',
  authorize('owner', 'general_manager', 'donor_manager'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const { name, category, targetValue, currentValue, period } = req.body;
    
    if (!name || !category || !period) throw new HttpError(400, 'Metric name, category, and period are required.');
    if (!['academic', 'social', 'economic', 'demographic'].includes(category)) {
      throw new HttpError(400, 'Invalid metric category.');
    }
    const existing = stmtGetMetricByNamePeriod.get(name, period, user.branchId) as any;

    if (existing) {
      stmtUpdateMetric.run(category, targetValue ?? 0, currentValue ?? 0, existing.id);
      writeAudit(req, `Updated impact metric "${name}" for ${period}`);
      return res.json({ id: existing.id, updated: true });
    }

    const newId = id('im');
    stmtInsertMetric.run(newId, name, category, targetValue ?? 0, currentValue ?? 0, period, user.branchId);

    writeAudit(req, `Created impact metric "${name}" for ${period}`);
    res.status(201).json({ id: newId });
  })
);

// ============================================================================
// §2 — IMPACT REPORTS
// ============================================================================

impactRouter.get(
  '/reports',
  authorize('owner', 'general_manager', 'finance_manager', 'donor_manager', 'receptionist'),
  ah(async (req, res) => {
    const { branchId, isAll } = resolveBranchScope(req);
    const rows = isAll ? stmtGetAllReports.all() : stmtGetReportsByBranch.all(branchId);
    res.json((rows as any[]).map(r => ({ ...r, metrics: JSON.parse(r.metrics || '[]') })));
  })
);

impactRouter.post(
  '/reports/generate',
  authorize('owner', 'general_manager', 'donor_manager'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const { period, donorId, campaignId, narrative } = req.body;
    
    if (!period) throw new HttpError(400, 'Report period is required (e.g. "1405-Q2").');
    const branchId = user.branchId;
    // The one period authority. Resolving 'YYYY-Qn'/'YYYY-MM'/'YYYY' here in the
    // GREGORIAN calendar, while Finance and reporting resolve the same shapes in
    // Shamsi, makes a donor report and a ledger report for the same named period
    // cover different days.
    let from: string;
    let to: string;
    try {
      const span = periodBoundariesForKey(String(period));
      from = span.from;
      to = span.to;
    } catch (error) {
      throw new HttpError(
        400,
        `Report period must be a Shamsi key such as 1405-05 (month), 1405-Q2 (quarter) or 1405 (year). ${
          error instanceof Error ? error.message : ''
        }`.trim(),
      );
    }

    const totalEnrolled = (stmtCountTotalEnrolled.get(branchId) as any).totalEnrolled;
    const enrolledInPeriod = (stmtCountEnrolledInPeriod.get(branchId, from, to) as any).enrolledInPeriod;
    const femaleStudents = (stmtCountFemaleStudents.get(branchId) as any).femaleStudents;
    const scholarshipRecipients = (stmtCountScholarshipRecipients.get(branchId, from, to) as any).scholarshipRecipients;
    const scholarshipAmount = (stmtSumScholarshipAmount.get(branchId, from, to) as any).scholarshipAmount;
    const donationsTotal = (stmtSumDonations.get(branchId, from, to) as any).donationsTotal;
    const sponsoredStudents = (stmtCountSponsoredStudents.get(branchId) as any).sponsoredStudents;
    const graduates = (stmtCountGraduates.get(branchId) as any).graduates;
    const attRows = stmtGetAttendanceStats.get(...ATTENDED_EQUIVALENT_STATUSES, branchId, from, to) as any;

    const attendanceRate = attRows.total > 0 ? Math.round((attRows.attended / attRows.total) * 100) : 100;
    const completionRate = totalEnrolled > 0 ? Math.round((graduates / totalEnrolled) * 100) : 0;
    const femaleShare = totalEnrolled > 0 ? Math.round((femaleStudents / totalEnrolled) * 100) : 0;

    const metrics = [
      { name: 'Students Enrolled (Total)', category: 'academic', value: totalEnrolled },
      { name: 'New Enrollments in Period', category: 'academic', value: enrolledInPeriod },
      { name: 'Female Students', category: 'demographic', value: femaleStudents },
      { name: 'Female Share of Enrollment', category: 'demographic', value: femaleShare, unit: '%' },
      { name: 'Scholarship Recipients in Period', category: 'social', value: scholarshipRecipients },
      { name: 'Scholarship Funds Disbursed', category: 'economic', value: scholarshipAmount, unit: 'AFN' },
      { name: 'Donations Received in Period', category: 'economic', value: donationsTotal, unit: 'AFN' },
      { name: 'Actively Sponsored Students', category: 'social', value: sponsoredStudents },
      { name: 'Average Attendance Rate', category: 'academic', value: attendanceRate, unit: '%' },
      { name: 'Course Completion Rate', category: 'academic', value: completionRate, unit: '%' },
      { name: 'Graduates (Cumulative)', category: 'academic', value: graduates },
    ];

    const newId = id('ir');
    const title = `Impact Report — ${period}`;

    const tx = db.transaction(() => {
      stmtInsertReport.run(
        newId, title, donorId || null, campaignId || null, period,
        JSON.stringify(metrics), narrative || buildDefaultNarrative(period, metrics), branchId
      );
      return eventBus.emit(
      'impact.report_generated', 'impact', newId,
      { period, donorId, campaignId, metricsCount: metrics.length },
      { operatorId: user.userId, branchId: branchId }
      );
    });
    const event = tx();
    void eventBus.dispatch(event);

    addNotification(
      'Impact Report Generated',
      `A donor-ready impact report for ${period} was generated with ${metrics.length} computed metrics.`,
      'success', branchId
    );

    writeAudit(req, `Generated impact report for ${period} (${metrics.length} metrics)`);
    res.status(201).json({ id: newId, title, period, metrics });
  })
);

impactRouter.patch(
  '/reports/:id',
  authorize('owner', 'general_manager', 'donor_manager'),
  ah(async (req, res) => {
    const existing = stmtGetReportById.get(req.params.id) as any;
    if (!existing) throw new HttpError(404, 'Impact report not found.');
    if (!canAccessBranchResource(req, existing.branch_id)) {
      throw new HttpError(403, 'Impact report belongs to another branch.');
    }

    const { status, narrative } = req.body;
    if (status && !['draft', 'published', 'sent'].includes(status)) {
      throw new HttpError(400, 'Invalid report status.');
    }

    stmtUpdateReport.run(status ?? existing.status, narrative ?? existing.narrative, req.params.id);
    writeAudit(req, `Updated impact report "${existing.title}" → ${status ?? 'narrative edit'}`);
    res.json({ ok: true });
  })
);

// ============================================================================
// §3 — SUCCESS STORIES
// ============================================================================

impactRouter.get(
  '/stories',
  authorize('owner', 'general_manager', 'finance_manager', 'donor_manager', 'receptionist'),
  ah(async (req, res) => {
    const { branchId, isAll } = resolveBranchScope(req);
    const rows = isAll ? stmtGetAllStories.all() : stmtGetStoriesByBranch.all(branchId);
    res.json((rows as any[]).map(r => ({ ...r, tags: JSON.parse(r.tags || '[]') })));
  })
);

impactRouter.post(
  '/stories',
  authorize('owner', 'general_manager', 'donor_manager'),
  ah(async (req, res) => {
    getUserContext(req);
    const { studentId, title, content, photoUrl, tags } = req.body;
    
    if (!studentId || !title || !content) throw new HttpError(400, 'Student, title, and content are required.');

    const student = stmtGetStudentById.get(studentId) as any;
    if (!student) throw new HttpError(404, 'Student not found.');
    if (!canAccessBranchResource(req, student.branch_id)) {
      throw new HttpError(403, 'Student belongs to another branch.');
    }
    // The story belongs to the STUDENT's branch. Requiring it to equal the
    // operator's home branch refused every legitimate multi-branch author
    // (an owner was authorized by canAccessBranchResource on the line above
    // and then rejected here), and filed the story under the wrong branch.
    const newId = id('ss');
    stmtInsertStory.run(newId, studentId, title, content, photoUrl || null, JSON.stringify(tags || []), student.branch_id);

    writeAudit(req, `Published success story for ${student.full_name}: "${title}"`);
    res.status(201).json({ id: newId });
  })
);

// ============================================================================
// §4 — IMPACT SUMMARY (Dashboard Widget)
// ============================================================================

impactRouter.get(
  '/summary',
  authorize('owner', 'general_manager', 'finance_manager', 'donor_manager', 'receptionist'),
  ah(async (req, res) => {
    const { branchId, isAll } = resolveBranchScope(req);

    const totalEnrolled = isAll 
      ? (stmtCountAllStudents.get() as any).totalEnrolled 
      : (stmtCountStudentsByBranch.get(branchId) as any).totalEnrolled;

    const femaleStudents = isAll 
      ? (stmtCountAllFemaleStudents.get() as any).femaleStudents 
      : (stmtCountFemaleStudentsByBranch.get(branchId) as any).femaleStudents;

    const scholarshipRecipients = isAll 
      ? (stmtCountAllScholarshipRecipients.get() as any).scholarshipRecipients 
      : (stmtCountScholarshipRecipientsByBranch.get(branchId) as any).scholarshipRecipients;

    const graduates = isAll 
      ? (stmtCountAllGraduates.get() as any).graduates 
      : (stmtCountGraduatesByBranch.get(branchId) as any).graduates;

    const publishedReports = isAll 
      ? (stmtCountAllPublishedReports.get() as any).publishedReports 
      : (stmtCountPublishedReportsByBranch.get(branchId) as any).publishedReports;

    const totalDonations = isAll 
      ? (stmtSumTotalDonationsAll.get() as any).totalDonations 
      : (stmtSumTotalDonationsByBranch.get(branchId) as any).totalDonations;

    res.json({
      totalEnrolled,
      femaleStudents,
      femaleShare: totalEnrolled > 0 ? Math.round((femaleStudents / totalEnrolled) * 100) : 0,
      scholarshipRecipients,
      graduates,
      completionRate: totalEnrolled > 0 ? Math.round((graduates / totalEnrolled) * 100) : 0,
      publishedReports,
      totalDonations,
    });
  })
);

// ============================================================================
// §5 — INTERNAL HELPERS
// ============================================================================


function buildDefaultNarrative(
  period: string,
  metrics: Array<{ name: string; value: number; unit?: string }>
): string {
  const get = (name: string) => metrics.find((m) => m.name === name)?.value ?? 0;
  return (
    `During ${period}, TOEFL House served ${get('Students Enrolled (Total)')} students, ` +
    `with ${get('New Enrollments in Period')} new enrollments and a female share of ` +
    `${get('Female Share of Enrollment')}%. ${get('Scholarship Recipients in Period')} students ` +
    `received scholarships totaling ${get('Scholarship Funds Disbursed').toLocaleString()} AFN, ` +
    `supported by ${get('Donations Received in Period').toLocaleString()} AFN in donations. ` +
    `Average attendance reached ${get('Average Attendance Rate')}% and the course completion ` +
    `rate stood at ${get('Course Completion Rate')}%.`
  );
}

export default impactRouter;