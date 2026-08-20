import { nextScopedDocumentNumber } from '../utils/documentNumbers.js';
import { isLeadClosed } from '../core/visitors/lead-lifecycle.js';
import { Router } from 'express';
import { db } from '../db/connection.js';
import { authenticate, authorize, resolveBranchScope, canAccessBranchResource } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { id, today } from '../utils/ids.js';
import { isUniqueViolation } from '../utils/idempotency.js';
import { assertMoney } from '../utils/money.js';
import { getNumberSetting } from '../utils/settings.js';
import { recordIncome } from '../utils/income.js';
import { evaluateRules } from '../core/configuration/rule-engine.js';
import { resolveFee } from '../core/configuration/policy-resolver.js';

export const examsRouter = Router();
examsRouter.use(authenticate);

// ── Performance Optimization: Prepared Statements ──────────────────────────
const stmtGetExamById = db.prepare('SELECT * FROM exams WHERE id = ?');
const stmtGetAllExams = db.prepare(`
  SELECT e.*, (SELECT COUNT(*) FROM exam_results er WHERE er.exam_id = e.id) as enrolled_count 
  FROM exams e ORDER BY e.date DESC
`);
const stmtGetExamsByBranch = db.prepare(`
  SELECT e.*, (SELECT COUNT(*) FROM exam_results er WHERE er.exam_id = e.id) as enrolled_count 
  FROM exams e WHERE e.branch_id = ? ORDER BY e.date DESC
`);
const stmtInsertExam = db.prepare('INSERT INTO exams (id, title, date, fee, type, branch_id) VALUES (?, ?, ?, ?, ?, ?)');
const stmtUpdateExam = db.prepare('UPDATE exams SET title = ?, date = ?, fee = ?, type = ? WHERE id = ?');
const stmtDeleteExam = db.prepare('DELETE FROM exams WHERE id = ?');
const stmtCountScoredResults = db.prepare('SELECT COUNT(*) as c FROM exam_results WHERE exam_id = ? AND score > 0');
const stmtCountExamResults = db.prepare('SELECT COUNT(*) as c FROM exam_results WHERE exam_id = ?');

const stmtGetResultById = db.prepare('SELECT * FROM exam_results WHERE id = ?');
const stmtGetResultsByExam = db.prepare('SELECT * FROM exam_results WHERE exam_id = ?');
const stmtGetAllResults = db.prepare('SELECT * FROM exam_results ORDER BY created_at DESC');
const stmtGetResultsByBranch = db.prepare('SELECT * FROM exam_results WHERE branch_id = ? ORDER BY created_at DESC');

const stmtInsertExamResult = db.prepare(
  `INSERT INTO exam_results (id, exam_id, student_id, visitor_id, candidate_name, score, status, exam_fee_paid, certificate_issued, certificate_no, branch_id) 
   VALUES (?, ?, ?, ?, ?, 0, 'pending', ?, 0, NULL, ?)`
);
const stmtUpdateExamResult = db.prepare(
  `UPDATE exam_results SET score = ?, status = ?, certificate_issued = ?, certificate_no = ? WHERE id = ?`
);
const stmtCheckEnrollment = db.prepare(
  `SELECT id FROM exam_results WHERE exam_id = ? AND (student_id = ? OR visitor_id = ?) LIMIT 1`
);

const stmtGetStudentById = db.prepare('SELECT id, full_name, branch_id, status FROM students WHERE id = ?');
// `stage` is required: closed-lost lives on stage, not status (lead-lifecycle).
const stmtGetVisitorById = db.prepare('SELECT id, full_name, branch_id, status, stage FROM visitors WHERE id = ?');
const stmtCountCertificatesByStudent = db.prepare('SELECT COUNT(*) as c FROM certificates WHERE student_id = ?');
const stmtInsertCertificate = db.prepare(
  `INSERT INTO certificates (id, student_id, issue_date, certificate_no, grade, branch_id) VALUES (?, ?, ?, ?, ?, ?)`
);
// NEW: Prepared statements for score correction
const stmtUpdateCorrectedScore = db.prepare(
  `UPDATE exam_results SET score = ?, status = ?, certificate_issued = ?, certificate_no = ? WHERE id = ?`
);
const stmtDeleteCertificate = db.prepare('DELETE FROM certificates WHERE certificate_no = ?');

/** Ensure exam exists and caller may access its branch. */
function requireExam(req: import('express').Request, examId: string): any {
  const row = stmtGetExamById.get(examId) as any;
  if (!row) throw new HttpError(404, 'Exam not found.');
  
  const { branchId, isAll } = resolveBranchScope(req);
  if (!isAll && branchId && row.branch_id && row.branch_id !== branchId) {
    const user = req.user;
    if (!user) throw new HttpError(401, 'Not authenticated');
    const scopes = req.rbac?.permissions.map((p: { scope: string }) => p.scope) ?? [];
    const cross = !!row.branch_id && canAccessBranchResource(req, row.branch_id);
    if (!cross) throw new HttpError(403, 'Exam belongs to another branch.');
  }
  return row;
}

// ============================================================================
// §1 — EXAM EVENTS (List, Create, Edit, Delete)
// ============================================================================

examsRouter.get(
  '/',
  authorize('receptionist', 'general_manager', 'teacher', 'head_of_department'),
  ah(async (req, res) => {
    const { branchId, isAll } = resolveBranchScope(req);
    const rows = isAll ? stmtGetAllExams.all() : stmtGetExamsByBranch.all(branchId);
    res.json(rows);
  })
);

examsRouter.post(
  '/',
  authorize('receptionist', 'general_manager', 'head_of_department'),
  ah(async (req, res) => {
    const { title, date, fee, type } = req.body;
    if (!title || !date) throw new HttpError(400, 'Exam title and date are required.');
    const allowedTypes = new Set(['placement', 'midterm', 'final', 'certification']);
    if (!allowedTypes.has(String(type))) throw new HttpError(400, 'A valid exam type is required.');
    
    const branchId = req.user?.branchId;
    if (!branchId) throw new HttpError(403, 'User branch context is missing.');
    
    // The exam fee is money and must clear the same bar as every other
    // monetary input. `Math.max(0, Number(fee ?? 0))` silently turned rubbish
    // into a real charge: "abc" reached SQLite and surfaced a raw NOT NULL
    // constraint error, 1e309 was stored as NULL, -500 became a free exam, and
    // 0.001 was accepted as a sub-cent fee.
    const resolvedFee = assertMoney(fee ?? 0, 'exam fee');

    const newId = id('ex');
    stmtInsertExam.run(newId, String(title).trim(), date, resolvedFee, String(type), branchId);
    writeAudit(req, `Created new exam event: ${title}`);
    res.status(201).json({ id: newId });
  })
);

examsRouter.put(
  '/:id',
  authorize('receptionist', 'general_manager', 'head_of_department'),
  ah(async (req, res) => {
    const exam = requireExam(req, req.params.id);
    const { title, date, fee, type } = req.body;
    
    const allowedTypes = new Set(['placement', 'midterm', 'final', 'certification']);
    const nextType = String(type || exam.type);
    // Same monetary bar as creation: a fee edited to 0.001 or 1e309 is not a
    // valid charge just because the row already exists.
    const nextFee = assertMoney(fee != null ? fee : exam.fee, 'exam fee');
    if (!allowedTypes.has(nextType)) throw new HttpError(400, 'Invalid exam type.');
    if (date && String(date) < String(exam.date) && (stmtCountScoredResults.get(exam.id) as { c: number }).c > 0) {
      throw new HttpError(409, 'Exam date cannot move backward after scores have been recorded.');
    }
    stmtUpdateExam.run(
      String(title || exam.title).trim(),
      date || exam.date,
      nextFee,
      nextType,
      req.params.id
    );
    
    writeAudit(req, `Updated exam event: ${exam.title}`);
    res.json({ ok: true });
  })
);

examsRouter.delete(
  '/:id',
  authorize('receptionist', 'general_manager', 'head_of_department'),
  ah(async (req, res) => {
    const exam = requireExam(req, req.params.id);
    
    const resultCount = (stmtCountExamResults.get(exam.id) as { c: number }).c;
    if (resultCount > 0) {
      throw new HttpError(409, `Cannot delete exam with ${resultCount} enrolled candidate(s). Archive it instead.`);
    }
    
    stmtDeleteExam.run(exam.id);
    writeAudit(req, `Deleted exam event: ${exam.title}`);
    res.json({ ok: true });
  })
);

examsRouter.get(
  '/:id/results',
  authorize('receptionist', 'general_manager', 'teacher', 'head_of_department'),
  ah(async (req, res) => {
    requireExam(req, req.params.id);
    res.json(stmtGetResultsByExam.all(req.params.id));
  })
);

examsRouter.get(
  '/results/all',
  authorize('receptionist', 'general_manager', 'teacher', 'head_of_department'),
  ah(async (req, res) => {
    const { branchId, isAll } = resolveBranchScope(req);
    const rows = isAll ? stmtGetAllResults.all() : stmtGetResultsByBranch.all(branchId);
    res.json(rows);
  })
);

// ============================================================================
// §2 — PHASE 1: ENROLL CANDIDATE & COLLECT FEE
// ============================================================================

examsRouter.post(
  '/:id/enroll',
  authorize('receptionist', 'general_manager', 'head_of_department'),
  ah(async (req, res) => {
    const exam = requireExam(req, req.params.id);
    const { studentId, visitorId, feePaid } = req.body as { studentId?: string; visitorId?: string; feePaid: boolean };

    if (!studentId && !visitorId) throw new HttpError(400, 'Either studentId or visitorId is required.');

    const user = req.user;
    if (!user?.branchId || !user?.fullName) throw new HttpError(403, 'User context is missing.');

    let candidateName = 'Unknown Candidate';
    if (studentId) {
      const student = stmtGetStudentById.get(studentId) as any;
      if (!student) throw new HttpError(404, 'Student not found.');
      if (student.branch_id !== exam.branch_id) throw new HttpError(403, 'Student belongs to another branch.');
      if (student.status && !['active', 'registered'].includes(student.status)) throw new HttpError(409, 'Student is not eligible for exam enrollment.');
      candidateName = student.full_name;
    } else if (visitorId) {
      const visitor = stmtGetVisitorById.get(visitorId) as any;
      if (!visitor) throw new HttpError(404, 'Visitor not found.');
      if (visitor.branch_id !== exam.branch_id) throw new HttpError(403, 'Visitor belongs to another branch.');
      // This guard tested `visitor.status` against a list of STAGE values
      // ('new', 'lead', 'inquiry', 'placement', ...). `status` only ever holds
      // 'visited' or 'registered', neither of which appears in that list, so
      // the condition was true for every visitor and exam enrolment was
      // refused 100% of the time — verified live before this fix.
      //
      // The intent is plainly "do not enrol a dead lead". That is the
      // closed-lost bucket, which lives on `stage` and is defined once in
      // core/visitors/lead-lifecycle.ts.
      if (isLeadClosed(visitor)) throw new HttpError(409, 'This lead is closed (lost) and cannot be enrolled in an exam.');
      candidateName = visitor.full_name;
    }

    const existing = stmtCheckEnrollment.get(exam.id, studentId || null, visitorId || null);
    if (existing) throw new HttpError(409, `${candidateName} is already enrolled in this exam.`);

    const newId = id('er');
    const date = today();

    const enrollTx = db.transaction(() => {
      stmtInsertExamResult.run(newId, exam.id, studentId || null, visitorId || null, candidateName, feePaid ? 1 : 0, exam.branch_id);
      if (feePaid && exam.fee > 0) {
        recordIncome({
          category: 'exam',
          amount: exam.fee,
          date,
          description: `Exam fee for ${exam.title} from ${candidateName}`,
          referenceId: exam.id,
          operatorName: user.fullName, operatorRole: req.rbac?.primaryRole ?? null,
          branchId: exam.branch_id,
        });
      }
    });
    try {
      enrollTx();
    } catch (err) {
      // uq_exam_results_student / uq_exam_results_visitor (migration 062) are
      // the authoritative guard; the SELECT above is only a fast path. Two
      // requests that pass it together must still produce ONE enrolment and
      // ONE exam-fee income row, reported as the same business error.
      if (isUniqueViolation(err)) {
        throw new HttpError(409, `${candidateName} is already enrolled in this exam.`);
      }
      throw err;
    }

    writeAudit(req, `Enrolled ${candidateName} in exam ${exam.title}`);
    res.status(201).json({ id: newId, candidateName });
  })
);

// ============================================================================
// §3 — PHASE 2: ENTER SCORES & ISSUE CERTIFICATE
// ============================================================================

examsRouter.patch(
  '/:id/results/:resultId',
  authorize('receptionist', 'general_manager', 'head_of_department'),
  ah(async (req, res) => {
    const exam = requireExam(req, req.params.id);
    
    // Prevent scoring before the exam date
    const todayStr = today();
    if (exam.date > todayStr) {
      throw new HttpError(403, 'Scores cannot be entered before the exam date.');
    }

    const result = stmtGetResultById.get(req.params.resultId) as any;
    if (!result) throw new HttpError(404, 'Exam result record not found.');
    if (result.exam_id !== exam.id) throw new HttpError(400, 'Exam result does not belong to this exam.');
    if (result.score > 0) throw new HttpError(409, 'Scores have already been submitted for this candidate. Use the correction tool if needed.');

    const user = req.user;
    if (!user?.branchId || !user?.fullName) throw new HttpError(403, 'User context is missing.');

    const { score, certIssued } = req.body as { score: number; certIssued: boolean };
    if (typeof score !== 'number' || score < 0 || score > 120) throw new HttpError(400, 'Invalid score.');

    const promotionResult = evaluateRules({
      category: 'promotion',
      branchId: exam.branch_id,
      data: { examScore: score },
    });
    
    const status: 'pass' | 'fail' = promotionResult.finalOutputs.promotionStatus === 'pass' ? 'pass' : 'fail';

    const certNo = certIssued ? nextScopedDocumentNumber('certificate', exam.branch_id, 'TH-CERT') : null;
    const date = today();

    let diplomaFee = 0;
    if (certIssued) {
      if (result.student_id) {
        const priorCertCount = (stmtCountCertificatesByStudent.get(result.student_id) as { c: number }).c;
        // Financial integrity: the diploma fee is charged once per student,
        // whether it was paid via the certificate issuance or the payment
        // desk. If a payment/income row for this student+category already
        // exists, the certificate is issued without an additional charge.
        const alreadyPaid = db.prepare(`
          SELECT 1 FROM (
            SELECT 1 FROM payments WHERE student_id = ? AND category = 'diploma' AND status = 'completed'
            UNION ALL
            SELECT 1 FROM financial_transactions WHERE type = 'income' AND category = 'diploma' AND reference_id = ? AND amount > 0
          ) LIMIT 1
        `).get(result.student_id, result.student_id);
        diplomaFee = priorCertCount === 0 && !alreadyPaid ? Number(resolveFee(db, exam.branch_id, 'diplomaFee') || 0) : 0;
      } else {
        diplomaFee = resolveFee(db, exam.branch_id, 'diplomaFee');
      }
    }

    const scoreTx = db.transaction(() => {
      stmtUpdateExamResult.run(score, status, certIssued ? 1 : 0, certNo, result.id);
      if (certIssued && result.student_id) {
        stmtInsertCertificate.run(id('cert'), result.student_id, date, certNo, status, exam.branch_id);
      }
      if (certIssued && diplomaFee > 0) {
        recordIncome({
          category: 'diploma',
          amount: diplomaFee,
          date,
          description: `Diploma fee for ${result.candidate_name} (${certNo})`,
          referenceId: result.student_id || result.visitor_id,
          operatorName: user.fullName, operatorRole: req.rbac?.primaryRole ?? null,
          branchId: exam.branch_id,
        });
      }
    });
    scoreTx();

    writeAudit(req, `Recorded score ${score} for ${result.candidate_name} in ${req.params.id}. Certificate: ${certIssued ? 'Yes' : 'No'}`);
    res.json({ id: result.id, status, certificateNo: certNo, diplomaFee: certIssued ? diplomaFee : 0 });
  })
);

// ============================================================================
// §4 — CORRECT SCORES & MANAGE CERTIFICATES (Owner/Manager Only)
// ============================================================================

examsRouter.put(
  '/:id/results/:resultId/correct',
  authorize('owner', 'general_manager'), // Strict access control for score correction
  ah(async (req, res) => {
    const exam = requireExam(req, req.params.id);
    const result = stmtGetResultById.get(req.params.resultId) as any;
    if (!result) throw new HttpError(404, 'Exam result record not found.');
    if (result.exam_id !== exam.id) throw new HttpError(400, 'Exam result does not belong to this exam.');

    const user = req.user;
    if (!user?.branchId || !user?.fullName) throw new HttpError(403, 'User context is missing.');

    const { score } = req.body as { score: number };
    if (typeof score !== 'number' || score < 0 || score > 120) throw new HttpError(400, 'Invalid score. Must be between 0 and 120.');

    // Recalculate pass/fail status
    const promotionResult = evaluateRules({
      category: 'promotion',
      branchId: exam.branch_id,
      data: { examScore: score },
    });
    const status: 'pass' | 'fail' = promotionResult.finalOutputs.promotionStatus === 'pass' ? 'pass' : 'fail';

    const shouldHaveCert = status === 'pass';
    let certNo = result.certificate_no;
    let certIssued = 0;

    // EXM-1: a correction that crosses the pass threshold issues a real
    // certificate, so it must carry the diploma fee exactly as the score-entry
    // path does. This handler had no recordIncome call at all, so the identical
    // document was produced for free — reachable through the ordinary
    // split-role workflow where a registrar records a failing score and a
    // manager later corrects it upward (proven live: 500 AFN vs 0 AFN for the
    // same certificate).
    //
    // The charge reuses the score-entry rule verbatim: once per student,
    // whether it was already settled by a certificate issuance or at the
    // payment desk. Re-issuing after a revocation therefore does not bill the
    // student a second time.
    let correctionDiplomaFee = 0;
    if (shouldHaveCert && !result.certificate_issued && result.student_id) {
      const priorCertCount = (stmtCountCertificatesByStudent.get(result.student_id) as { c: number }).c;
      const alreadyPaid = db.prepare(`
        SELECT 1 FROM (
          SELECT 1 FROM payments WHERE student_id = ? AND category = 'diploma' AND status = 'completed'
          UNION ALL
          SELECT 1 FROM financial_transactions WHERE type = 'income' AND category = 'diploma' AND reference_id = ? AND amount > 0
        ) LIMIT 1
      `).get(result.student_id, result.student_id);
      correctionDiplomaFee =
        priorCertCount === 0 && !alreadyPaid ? Number(resolveFee(db, exam.branch_id, 'diplomaFee') || 0) : 0;
    }

    const correctTx = db.transaction(() => {
      if (shouldHaveCert && !result.certificate_issued) {
        // Issue new certificate if score was corrected to passing threshold
        certNo = nextScopedDocumentNumber('certificate', exam.branch_id, 'TH-CERT');
        certIssued = 1;
        if (result.student_id) {
          stmtInsertCertificate.run(id('cert'), result.student_id, today(), certNo, status, exam.branch_id);
          if (correctionDiplomaFee > 0) {
            recordIncome({
              category: 'diploma',
              amount: correctionDiplomaFee,
              date: today(),
              description: `Diploma fee for ${result.candidate_name} (${certNo}) — issued on score correction`,
              referenceId: result.student_id,
              operatorName: user.fullName,
              operatorRole: req.rbac?.primaryRole ?? null,
              branchId: exam.branch_id,
            });
          }
        }
      } else if (!shouldHaveCert && result.certificate_issued) {
        // Revoke certificate if score was corrected to below the passing threshold.
        //
        // EXM-2 (POLICY, deliberate): revocation does NOT reverse money, and
        // the exam correction engine is NOT a financial authority. Two fee
        // semantics exist and the system distinguishes them explicitly:
        //
        //   payments/income category 'exam'    — the examination SERVICE, paid
        //       at enrolment (exams.routes ~L234). It was delivered: the
        //       candidate sat the exam. A score change never makes it
        //       refundable.
        //   payments/income category 'diploma' — certificate ISSUANCE, charged
        //       ONCE PER STUDENT and only when no prior certificate and no
        //       prior diploma payment exist (the `priorCertCount === 0 &&
        //       !alreadyPaid` rule above).
        //
        // Because the diploma charge is once-per-student and the re-issue path
        // deliberately does not re-bill, auto-reversing it here would let a
        // correct-down / correct-up cycle hand back money and then re-issue the
        // same certificate for free. The charge is therefore retained, and the
        // ledger stays reconciled (cash remains backed by its income row;
        // nothing is minted, destroyed or duplicated).
        //
        // If the institution decides a revoked certificate should be refunded,
        // that is an OWNER POLICY DECISION and must be executed through the one
        // refund authority — POST /students/:id/refund, which carries
        // `Refund.Approve`, mandatory idempotency, the refundable-balance
        // recompute and recordIncome(). It must never be written from here.
        if (certNo) stmtDeleteCertificate.run(certNo);
        certNo = null;
        certIssued = 0;
      } else if (shouldHaveCert && result.certificate_issued) {
        certIssued = 1; // Keep existing cert
      }
      
      stmtUpdateCorrectedScore.run(score, status, certIssued, certNo, result.id);
    });
    correctTx();

    writeAudit(req, `Corrected score to ${score} for ${result.candidate_name}. Certificate: ${certIssued ? 'Issued' : 'Revoked/None'}`);
    res.json({ id: result.id, status, certificateNo: certNo, certificateIssued: !!certIssued, diplomaFee: correctionDiplomaFee });
  })
);

export default examsRouter;
