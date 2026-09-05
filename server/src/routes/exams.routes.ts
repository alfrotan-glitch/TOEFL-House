import { nextScopedDocumentNumber } from '../utils/documentNumbers.js';
import { nextReceiptNumber } from '../utils/receipt.js';
import { isLeadClosed } from '../core/visitors/lead-lifecycle.js';
import { Router } from 'express';
import { db } from '../db/connection.js';
import { authenticate, authorize, requirePermission, resolveBranchScope, canAccessBranchResource } from '../middleware/auth.js';
import { eventBus } from '../core/events/event-bus.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { id, today } from '../utils/ids.js';
import { isUniqueViolation } from '../utils/idempotency.js';
import { assertOptionalIsoDate } from '../utils/isoDate.js';
import { assertMoney } from '../utils/money.js';
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
const stmtRevokeCertificate = db.prepare(
  `UPDATE certificates SET status = 'revoked', revoked_at = datetime('now'), revoked_by = ? WHERE certificate_no = ?`
);

/** Ensure exam exists and caller may access its branch. */
function requireExam(req: import('express').Request, examId: string): any {
  const row = stmtGetExamById.get(examId) as any;
  if (!row) throw new HttpError(404, 'Exam not found.');
  
  const { branchId, isAll } = resolveBranchScope(req);
  if (!isAll && branchId && row.branch_id && row.branch_id !== branchId) {
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
  requirePermission('Exam.View'),
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
    const examDate = assertOptionalIsoDate(date, 'date')!;
    const allowedTypes = new Set(['placement', 'midterm', 'final', 'certification']);
    if (!allowedTypes.has(String(type))) throw new HttpError(400, 'A valid exam type is required.');

    // The exam's branch is the caller's AUTHORIZED scope, not their identity
    // branch: an assignment for branch B never authorizes creating an exam in
    // an unrelated identity branch A. A concrete branch is required — a
    // request that explicitly asks for the all-branches scope cannot name the
    // branch an exam belongs to.
    const { branchId, isAll } = resolveBranchScope(req);
    if (isAll || !branchId) throw new HttpError(400, 'Exam creation requires a specific branch (do not request branchId=all).');
    
    // The exam fee is money and must clear the same bar as every other
    // monetary input. `Math.max(0, Number(fee ?? 0))` silently turned rubbish
    // into a real charge: "abc" reached SQLite and surfaced a raw NOT NULL
    // constraint error, 1e309 was stored as NULL, -500 became a free exam, and
    // 0.001 was accepted as a sub-cent fee.
    const resolvedFee = assertMoney(fee ?? 0, 'exam fee');

    const newId = id('ex');
    stmtInsertExam.run(newId, String(title).trim(), examDate, resolvedFee, String(type), branchId);
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
    const nextDate = date ? assertOptionalIsoDate(date, 'date')! : exam.date;
    if (nextDate < exam.date && (stmtCountScoredResults.get(exam.id) as { c: number }).c > 0) {
      throw new HttpError(409, 'Exam date cannot move backward after scores have been recorded.');
    }
    stmtUpdateExam.run(
      String(title || exam.title).trim(),
      nextDate,
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
  requirePermission('Exam.View'),
  ah(async (req, res) => {
    requireExam(req, req.params.id);
    res.json(stmtGetResultsByExam.all(req.params.id));
  })
);

examsRouter.get(
  '/results/all',
  requirePermission('Exam.View'),
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

    let examFeeReceipt: string | null = null;
    const enrollTx = db.transaction(() => {
      stmtInsertExamResult.run(newId, exam.id, studentId || null, visitorId || null, candidateName, feePaid ? 1 : 0, exam.branch_id);
      if (feePaid && exam.fee > 0) {
        // Cash taken at the desk is a PAYMENT with a receipt from the gap-free
        // series, whoever the payer is. Booking only the ledger income left
        // this money invisible to every payment-derived report and to the
        // receipt series the drawer is reconciled against — income without a
        // document. The payment row is the cash authority; the ledger row
        // points at it through payment_id like every other collection path.
        const paymentId = id('pay');
        const receipt = nextReceiptNumber();
        examFeeReceipt = receipt;
        // Keyed on the enrolment identity: one exam seat, one fee payment —
        // a retried submit collapses onto the same key instead of charging twice.
        db.prepare(
          `INSERT INTO payments (id, student_id, amount, date, payment_method, status, category, notes, receipt_number, branch_id, idempotency_key)
           VALUES (?, ?, ?, ?, 'cash', 'completed', 'exam', ?, ?, ?, ?)`
        ).run(paymentId, studentId || null, exam.fee, date, `Exam fee: ${exam.title} — ${candidateName}`, receipt, exam.branch_id, `exam-fee:${newId}`);
        recordIncome({
          category: 'exam',
          amount: exam.fee,
          date,
          description: `Exam fee for ${exam.title} from ${candidateName}`,
          referenceId: exam.id,
          paymentId,
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
    res.status(201).json({ id: newId, candidateName, receiptNumber: examFeeReceipt });
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
    // `status` is the scored marker: a pending result has no score yet, and a
    // scored result — pass or fail, including a legitimate score of 0 — can
    // only be changed through the privileged correction tool.
    if (result.status !== 'pending') throw new HttpError(409, 'Scores have already been submitted for this candidate. Use the correction tool if needed.');

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
        if (priorCertCount === 0 && !alreadyPaid) {
          const configuredDiplomaFee = resolveFee(db, exam.branch_id, 'diplomaFee');
          if (configuredDiplomaFee == null) {
            throw new HttpError(409, 'No active diploma fee is configured for this branch. Configure it in Academic Control Center before issuing the certificate.');
          }
          diplomaFee = configuredDiplomaFee;
        }
      } else {
        const configuredDiplomaFee = resolveFee(db, exam.branch_id, 'diplomaFee');
        if (configuredDiplomaFee == null) {
          throw new HttpError(409, 'No active diploma fee is configured for this branch. Configure it in Academic Control Center before issuing the certificate.');
        }
        diplomaFee = configuredDiplomaFee;
      }
    }

    let resultEvent: ReturnType<typeof eventBus.emit> | undefined;
    let diplomaReceipt: string | null = null;
    const scoreTx = db.transaction(() => {
      stmtUpdateExamResult.run(score, status, certIssued ? 1 : 0, certNo, result.id);
      if (certIssued && result.student_id) {
        stmtInsertCertificate.run(id('cert'), result.student_id, date, certNo, status, exam.branch_id);
      }
      if (certIssued && diplomaFee > 0) {
        // Cash taken at issuance is a PAYMENT with a receipt from the gap-free
        // series — the same authority every collection path uses. Booking only
        // the ledger income left the diploma fee outside the payment history,
        // outside the receipt series the drawer reconciles, and outside the
        // refund route (which reverses by paymentId); the once-per-student
        // probe above had to read raw financial_transactions to even see it.
        const diplomaPaymentId = id('pay');
        diplomaReceipt = nextReceiptNumber();
        db.prepare(
          `INSERT INTO payments (id, student_id, amount, date, payment_method, status, category, notes, receipt_number, branch_id, idempotency_key)
           VALUES (?, ?, ?, ?, 'cash', 'completed', 'diploma', ?, ?, ?, ?)`,
        ).run(
          diplomaPaymentId, result.student_id || null, diplomaFee, date,
          `Diploma fee: ${certNo}`, diplomaReceipt, exam.branch_id,
          // Keyed on the certificate identity: one certificate, one charge.
          `diploma-fee:${certNo}`,
        );
        recordIncome({
          category: 'diploma',
          amount: diplomaFee,
          date,
          description: `Diploma fee for ${result.candidate_name} (${certNo})`,
          referenceId: result.student_id || result.visitor_id,
          paymentId: diplomaPaymentId,
          operatorName: user.fullName, operatorRole: req.rbac?.primaryRole ?? null,
          branchId: exam.branch_id,
        });
      }
      // Outbox row committed with the score it describes (audit F-A2: the
      // seeded "High Exam Result Review" automation conditions on `score`,
      // and no emitter existed).
      resultEvent = eventBus.emit(
        'exam.result_recorded', 'exam', result.id,
        { score, status, examId: exam.id, examTitle: exam.title, candidateName: result.candidate_name, certificateIssued: !!certIssued, branchId: exam.branch_id },
        { operatorId: user.userId, branchId: exam.branch_id },
      );
    });
    scoreTx();
    if (resultEvent) void eventBus.dispatch(resultEvent);

    writeAudit(req, `Recorded score ${score} for ${result.candidate_name} in ${req.params.id}. Certificate: ${certIssued ? 'Yes' : 'No'}`);
    res.json({ id: result.id, status, certificateNo: certNo, diplomaFee: certIssued ? diplomaFee : 0, diplomaReceipt });
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

    // A correction that crosses the pass threshold issues a real certificate,
    // so it carries the diploma fee under exactly the score-entry rule: once
    // per student, whether already settled by a certificate issuance or at the
    // payment desk. Re-issuing after a revocation therefore never bills the
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
      if (priorCertCount === 0 && !alreadyPaid) {
        const configuredDiplomaFee = resolveFee(db, exam.branch_id, 'diplomaFee');
        if (configuredDiplomaFee == null) {
          throw new HttpError(409, 'No active diploma fee is configured for this branch. Configure it in Academic Control Center before issuing the certificate.');
        }
        correctionDiplomaFee = configuredDiplomaFee;
      }
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
        // Revocation is a state transition, not a deletion: the certificate is
        // an academic output fact and stays on record as revoked.
        //
        // Revocation deliberately does NOT reverse money — the exam correction
        // engine is not a financial authority. The 'exam' fee was for a service
        // already delivered, and the 'diploma' fee is charged once per student
        // (the `priorCertCount === 0 && !alreadyPaid` rule above). Retaining
        // the charge keeps the ledger reconciled: cash remains backed by its
        // income row, and a correct-down / correct-up cycle re-issues a new
        // certificate without minting or refunding money. Refunding a revoked
        // certificate is an owner policy decision executed only through the one
        // refund authority (POST /students/:id/refund) — never from here.
        if (certNo) stmtRevokeCertificate.run(user.fullName, certNo);
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
