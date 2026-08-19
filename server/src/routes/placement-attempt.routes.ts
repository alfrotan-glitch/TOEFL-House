/**
 * Placement Attempt Router — attempt lifecycle with server-authoritative
 * timing, policy-mode resolution, auto/manual scoring, decision engine,
 * audited overrides and score corrections.
 */
import { Router } from 'express';
import { db } from '../db/connection.js';
import { authorize, requirePermission, canAccessBranchResource, resolveBranchScope } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { id, today } from '../utils/ids.js';
import { nextReceiptNumber } from '../utils/receipt.js';
import { addNotification } from '../utils/notifications.js';
import { recordIncome } from '../utils/income.js';
import { resolveFee } from '../core/configuration/policy-resolver.js';
import {
  stmtVisitor, stmtAttempt, stmtCurrentAttempt, stmtAttempts, stmtResults, stmtInsertAttempt, stmtLastAttemptNumber,
  stmtCompleteAttempt, stmtInsertPlacementFeePayment, stmtUpdateVisitorPlacement, stmtVisitorCompletedCount, stmtSetAttemptOutcome,
  stmtUpsertResponse, stmtResponsesByAttemptTest, stmtTestById, stmtQuestionsByTest, stmtSectionsByTest,
  getVisitorOr404, assertVisitorBranchAccess, getUserContext, mapProfile, mapAttempt, getProgramAssessment,
  parseComponents, normalizeScore, upsertResult, getRequiredMissing, type PolicyComponent,
} from '../core/placement/store.js';
import { resolvePlacementRequirement, resolvePolicyForVisitor } from '../core/placement/policy-engine.js';
import {
  assertAttemptEditable, expireAttemptIfNeeded, enforceComponentTimeout, recordSubmissionTiming,
  startComponentTimer, pauseAttempt, resumeAttempt, componentTimingView, computeDeadline, nowIso, componentTimeLimitSeconds, timingState,
} from '../core/placement/timing-engine.js';
import { autoScoreQuestion, normalizeAutoScore, scoreProvenance, scoreComponentBody } from '../core/placement/scoring-engine.js';
import { evaluateDecision, assertNoConflictingLevels, evaluateOutcome } from '../core/placement/decision-engine.js';
import { readRetakePolicy, evaluateStartEligibility, evaluateBilling, WAIVED_STATUS } from '../core/placement/placement-policy.js';
import { placementActivityReport } from '../core/placement/reporting.js';

export const placementAttemptRouter = Router();

// ── Helpers ─────────────────────────────────────────────────────────────────
function loadAttemptContext(req: any, visitorId: string, attemptId: string) {
  const visitor = getVisitorOr404(visitorId);
  assertVisitorBranchAccess(req, visitor);
  const attempt = stmtAttempt.get(attemptId) as any;
  if (!attempt || attempt.visitor_id !== visitor.id) throw new HttpError(404, 'Placement attempt not found.');
  return { visitor, attempt };
}

function parseSnapshot(attempt: any) {
  try { return JSON.parse(attempt.snapshot_json || '{}'); }
  catch { throw new HttpError(409, 'Placement attempt snapshot is corrupted.'); }
}

// ============================================================================
// §VIEW — profile + requirement mode + attempts + live component timing
// ============================================================================
placementAttemptRouter.get('/visitors/:visitorId/placement', authorize('owner', 'registrar', 'manager', 'counselor'), ah(async (req, res) => {
  const visitor = getVisitorOr404(req.params.visitorId);
  assertVisitorBranchAccess(req, visitor);
  const targetLevelId = typeof req.query.targetLevelId === 'string' ? req.query.targetLevelId : null;
  const { version, profile, rules, requirement } = resolvePolicyForVisitor(visitor, targetLevelId);
  const levels = profile ? (() => { try { return mapProfile(profile, version, [], rules).levels; } catch { return []; } })() : [];
  const current = stmtCurrentAttempt.get(visitor.id) as any;
  if (current) expireAttemptIfNeeded(current);
  res.json({
    visitorId: visitor.id,
    programVersionId: visitor.program_version_id,
    requirement: { mode: requirement.mode, decision: requirement.decision, reason: requirement.reason, firstLevelExemptApplied: requirement.firstLevelExemptApplied, policySource: requirement.policySource },
    profile: profile ? mapProfile(profile, version, levels, rules) : { configured: false, enabled: false, required: false, requirementMode: 'not_required', components: [], levels, placementRules: rules, allowRetake: true, passScore: 60, maxScore: 100, instructions: null },
    attempts: (stmtAttempts.all(visitor.id) as any[]).map((a) => mapAttempt(a)),
    current: current ? mapAttempt(current) : null,
  });
}));

// ============================================================================
// §START — policy-mode gate, immutable snapshot, timers, expiry
// ============================================================================
placementAttemptRouter.post('/visitors/:visitorId/placement/attempts', authorize('owner', 'registrar', 'manager', 'counselor'), ah(async (req, res) => {
  const user = getUserContext(req);
  const visitor = getVisitorOr404(req.params.visitorId);
  assertVisitorBranchAccess(req, visitor);
  const targetLevelId = typeof req.body?.targetLevelId === 'string' ? req.body.targetLevelId : null;
  const requirement = resolvePlacementRequirement(visitor.program_version_id, visitor.branch_id, targetLevelId);

  if (requirement.mode === 'not_required') {
    throw new HttpError(400, `Placement is not required for this program (${requirement.reason}).`);
  }
  // Optional mode: authorized skip records an audited exemption instead of an attempt.
  if (requirement.mode === 'optional' && req.body?.skip === true) {
    const reason = String(req.body?.reason || 'Candidate opted to skip optional placement.').trim().slice(0, 500);
    // Canonical waiver status is 'waived' — the only value the visitors
    // placement_status CHECK permits. The conversion gate previously looked for
    // 'exempt', a value nothing ever wrote, which made this audited skip a dead
    // end (the candidate could never be enrolled). Both boundaries now resolve
    // the term through the shared domain policy.
    db.prepare(`UPDATE visitors SET placement_status=?, placement_status_at=datetime('now'), placement_requirement_mode='optional', placement_score=? WHERE id=?`)
      .run(WAIVED_STATUS, JSON.stringify({ mode: 'optional', skipped: true, waived: true, reason, at: nowIso(), by: user.userId }), visitor.id);
    writeAudit(req, `Placement exempted (optional skip) for ${visitor.full_name}`, { newValue: JSON.stringify({ mode: 'optional', reason, operatorId: user.userId }) });
    res.json({ skipped: true, mode: 'optional', reason });
    return;
  }

  const assessment = getProgramAssessment(visitor);
  if (!assessment.profile) throw new HttpError(409, 'Placement is required but no placement policy is configured for this program.');
  const profile = assessment.profile;
  const { version, levels, rules } = assessment;
  const components = parseComponents(profile);
  const enabledComponents = components.filter((c) => c.enabled);
  if (enabledComponents.length === 0) throw new HttpError(409, 'Placement policy has no enabled components.');
  // Retake eligibility comes from the shared domain policy so the rule cannot
  // drift from the conversion/billing logic. This check is the friendly error
  // path; the hard guarantee is the partial unique index
  // `uq_placement_open_attempt` (migration 070), which makes "at most one open
  // attempt per visitor" atomic. Before that index, opening several attempts
  // before completing any bypassed allowRetake=false entirely.
  const retakePolicy = readRetakePolicy(profile);
  const eligibility = evaluateStartEligibility(retakePolicy, Number((stmtVisitorCompletedCount.get(visitor.id) as any).c || 0));
  if (!eligibility.allowed) throw new HttpError(409, eligibility.reason);

  const now = nowIso();
  const startedAt = now;
  const expiresMinutes = profile.expires_minutes ? Number(profile.expires_minutes) : null;
  const expiresAt = expiresMinutes ? computeDeadline(startedAt, expiresMinutes * 60) : null;

  // Immutable snapshot: policy + full test content + answer keys.
  const contentTests: any[] = [];
  for (const c of enabledComponents) {
    if (c.type === 'content_test' && c.testId) {
      const test = stmtTestById.get(c.testId) as any;
      if (test) contentTests.push({ ...test, sections: stmtSectionsByTest.all(test.id), questions: stmtQuestionsByTest.all(test.id) });
    }
  }
  const snapshot = JSON.stringify({
    profile: mapProfile(profile, version, levels, rules),
    tests: contentTests,
    requirementMode: requirement.mode,
    policyVersion: Number(profile.version ?? 1),
    decisionRules: profile.decision_rules_json ? JSON.parse(profile.decision_rules_json) : [],
    capturedAt: startedAt,
  });

  const attemptNumber = Number((stmtLastAttemptNumber.get(visitor.id) as any).n || 0) + 1;
  const attemptId = id('pat');
  const insertAttempt = db.transaction(() => {
    stmtInsertAttempt.run(attemptId, visitor.id, visitor.program_version_id, profile.id, visitor.branch_id, attemptNumber, snapshot, user.userId, null, expiresAt, Number(profile.version ?? 1));
    for (const c of enabledComponents) {
      upsertResult({
        attemptId, key: c.key, type: c.type, label: c.label, status: 'pending', score: null,
        maxScore: c.maxScore, weight: c.weight, evaluatorUserId: user.userId,
        startedAt: null, deadlineAt: null,
      });
    }
    db.prepare(`UPDATE visitors SET placement_status='in_progress', placement_status_at=datetime('now'), placement_requirement_mode=?, placement_method=?, current_placement_attempt_id=?, stage=CASE WHEN stage IN ('lead','inquiry','follow_up','placement_booking') THEN 'placement_booking' ELSE stage END WHERE id=?`)
      .run(requirement.mode, profile.method, attemptId, visitor.id);
  });
  try {
    insertAttempt();
  } catch (err) {
    // The database is the authority on both placement uniqueness invariants:
    //   uq_placement_open_attempt      — one open attempt per visitor
    //   UNIQUE(visitor_id, attempt_number) — no duplicate attempt numbering
    // Concurrent or duplicated requests land here; surface a precise 409
    // instead of leaking a raw SQLITE_CONSTRAINT error as a 500/400.
    // SQLite reports the offending COLUMNS, not the index name, e.g.
    //   "UNIQUE constraint failed: placement_assessment_attempts.visitor_id"
    //        → uq_placement_open_attempt (one open attempt per visitor)
    //   "...visitor_id, placement_assessment_attempts.attempt_number"
    //        → UNIQUE(visitor_id, attempt_number) (numbering race)
    const e = err as { code?: string; message?: string } | null;
    if (e?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      const message = String(e.message ?? '');
      if (message.includes('attempt_number')) {
        throw new HttpError(409, 'Another placement attempt was created for this candidate at the same moment. Please retry.');
      }
      if (message.includes('visitor_id')) {
        throw new HttpError(409, 'This candidate already has an open placement attempt. Complete, cancel or expire it before starting another.');
      }
    }
    throw err;
  }
  writeAudit(req, `Started placement assessment for ${visitor.full_name} (policy v${profile.version ?? 1}, mode ${requirement.mode})`, { newValue: JSON.stringify({ attemptId, policyVersion: profile.version ?? 1, expiresAt }) });
  res.status(201).json(mapAttempt(stmtAttempt.get(attemptId)));
}));

// ============================================================================
// §TIMER — start a component's server timer (idempotent)
// ============================================================================
placementAttemptRouter.put('/visitors/:visitorId/placement/attempts/:attemptId/tests/:componentKey/start', authorize('owner', 'registrar', 'manager', 'counselor'), ah(async (req, res) => {
  const user = getUserContext(req);
  const { visitor, attempt } = loadAttemptContext(req, req.params.visitorId, req.params.attemptId);
  assertAttemptEditable(attempt);
  const snapshot = parseSnapshot(attempt);
  const component = (snapshot.profile?.components || []).find((c: any) => c.key === req.params.componentKey);
  if (!component) throw new HttpError(404, 'Assessment component not found.');
  const result = (stmtResults.all(attempt.id) as any[]).find((r) => r.component_key === component.key);
  if (!result) throw new HttpError(404, 'Component result not found.');
  startComponentTimer(attempt.id, component.key, component, result, user.userId);
  writeAudit(req, `Started placement component timer "${component.label}" for ${visitor.full_name}`);
  const updated = (stmtResults.all(attempt.id) as any[]).find((r) => r.component_key === component.key);
  res.json({ componentKey: component.key, ...componentTimingView(component, updated) });
}));

// ============================================================================
// §RESPONSES — candidate answers + auto-scoring + timing enforcement
// ============================================================================
placementAttemptRouter.put('/visitors/:visitorId/placement/attempts/:attemptId/tests/:componentKey/responses', authorize('owner', 'registrar', 'manager', 'counselor'), ah(async (req, res) => {
  const user = getUserContext(req);
  const { visitor, attempt } = loadAttemptContext(req, req.params.visitorId, req.params.attemptId);
  assertAttemptEditable(attempt);
  const snapshot = parseSnapshot(attempt);
  const component = (snapshot.profile?.components || []).find((c: PolicyComponent) => c.key === req.params.componentKey);
  if (!component || component.type !== 'content_test' || !component.testId) throw new HttpError(404, 'Content assessment component not found.');
  const test = (snapshot.tests || []).find((t: any) => t.id === component.testId);
  if (!test) throw new HttpError(404, 'Test content not found in the attempt snapshot.');
  const result = (stmtResults.all(attempt.id) as any[]).find((r) => r.component_key === component.key);
  if (!result) throw new HttpError(404, 'Component result not found.');

  // Enforce the server-side timer BEFORE accepting anything.
  const { elapsedSeconds } = recordSubmissionTiming(attempt.id, component.key, component, result);

  const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
  const feedbacks: Record<string, string> = {};
  // ATOMIC: every submitted answer plus the component result derived from them
  // is one submission. A partial write (some answers stored, the derived score
  // not updated) would leave the component's recorded score disagreeing with
  // the responses it was computed from.
  let stored: any[] = [];
  let earned = 0;
  let max = 0;
  let answered = 0;
  let autoComplete = false;
  const applySubmission = db.transaction(() => {
  for (const a of answers) {
    const q = test.questions.find((tq: any) => String(tq.question_key) === String(a?.questionKey));
    if (!q) throw new HttpError(400, `Unknown question key "${a?.questionKey}" in test "${test.title}".`);
    const response = a?.response;
    if (response === undefined || response === null || response === '') continue;
    // Speaking answers may attach a recorded-audio media reference (validated
    // server-side: the media must exist and be in scope — branch or global).
    if (q.qtype === 'speaking' && response && typeof response === 'object' && (response as any).audioMediaId) {
      const media = db.prepare('SELECT id, branch_id FROM placement_media WHERE id = ?').get((response as any).audioMediaId) as { id: string; branch_id: string | null } | undefined;
      if (!media) throw new HttpError(400, `Unknown audio media id "${(response as any).audioMediaId}" for speaking question "${q.question_key}".`);
      if (media.branch_id && media.branch_id !== visitor.branch_id && !canAccessBranchResource(req, media.branch_id)) {
        throw new HttpError(403, 'Audio media belongs to another branch.');
      }
    }
    const graded = autoScoreQuestion(q, response);
    feedbacks[String(q.question_key)] = graded.feedback;
    stmtUpsertResponse.run(id('pr'), attempt.id, test.id, q.id, q.question_key, JSON.stringify(response), graded.score, Number(q.points || 0), graded.feedback);
  }

  // Component state derives from ALL stored responses (server truth).
  stored = stmtResponsesByAttemptTest.all(attempt.id, test.id) as any[];
  const storedByKey = new Map(stored.map((r) => [String(r.question_key), r]));
  earned = 0;
  max = 0;
  answered = 0;
  for (const q of test.questions) {
    const pts = Number(q.points || 0);
    max += pts;
    const row = storedByKey.get(String(q.question_key));
    if (row) { answered += 1; earned += Number(row.auto_score || 0); }
  }
  const allAnswered = answered === test.questions.length;
  const hasManual = test.questions.some((q: any) => q.qtype === 'essay' || q.qtype === 'speaking');
  autoComplete = allAnswered && !hasManual;
  const autoResult = normalizeAutoScore(earned, max, component.maxScore);

  if (autoComplete) {
    const prov = scoreProvenance(autoResult, component.maxScore, component.weight);
    upsertResult({
      attemptId: attempt.id, key: component.key, type: component.type, label: component.label,
      status: 'completed', score: autoResult, maxScore: component.maxScore, weight: component.weight,
      evaluatorUserId: user.userId, rawScore: earned, percentage: prov.percentage, weightedScore: prov.weightedScore,
      payloadJson: JSON.stringify({ mode: 'auto', earned, max, testId: test.id, testVersion: test.version ?? 1 }),
      submittedAt: nowIso(), elapsedSeconds,
    });
  } else {
    upsertResult({
      attemptId: attempt.id, key: component.key, type: component.type, label: component.label,
      status: allAnswered ? 'in_progress' : 'pending', score: null, maxScore: component.maxScore, weight: component.weight,
      evaluatorUserId: user.userId,
      payloadJson: JSON.stringify({ mode: 'auto', earned, max, answered, total: test.questions.length, testId: test.id, testVersion: test.version ?? 1 }),
      submittedAt: allAnswered ? nowIso() : null, elapsedSeconds: allAnswered ? elapsedSeconds : null,
    });
  }
  });
  applySubmission();

  writeAudit(req, `Recorded content responses for ${visitor.full_name} on test "${test.title}" (${answered}/${test.questions.length} answered, ${earned}/${max} auto points)`);
  res.json({
    componentKey: component.key,
    answered, total: test.questions.length,
    autoScore: earned, maxScore: max,
    complete: autoComplete,
    timing: componentTimingView(component, stmtResults.all(attempt.id).find((r: any) => r.component_key === component.key)),
    feedback: feedbacks,
    responses: stored.map((r) => ({ questionKey: r.question_key, response: JSON.parse(r.response_json || 'null'), autoScore: r.auto_score, feedback: r.feedback })),
  });
}));

// ============================================================================
// §COMPONENT SCORE — staff scoring (manual/hybrid) with provenance
// ============================================================================
placementAttemptRouter.put('/visitors/:visitorId/placement/attempts/:attemptId/components/:componentKey', authorize('owner', 'registrar', 'manager', 'counselor'), ah(async (req, res) => {
  const user = getUserContext(req);
  const { visitor, attempt } = loadAttemptContext(req, req.params.visitorId, req.params.attemptId);
  assertAttemptEditable(attempt);
  const snapshot = parseSnapshot(attempt);
  const component = (snapshot.profile?.components || []).find((c: PolicyComponent) => c.key === req.params.componentKey);
  if (!component) throw new HttpError(404, 'Assessment component not found.');
  const selectedLevelId = req.body?.selectedLevelId || null;
  if (selectedLevelId && !(snapshot.profile.levels || []).some((l: any) => l.id === selectedLevelId)) throw new HttpError(400, 'Selected level is not part of this program.');
  const result = (stmtResults.all(attempt.id) as any[]).find((r) => r.component_key === component.key) as any;

  const status = req.body?.status === 'waived' ? 'waived' : 'completed';
  if (status === 'waived') {
    const role = String(req.user?.role || '');
    if (component.required && !['owner', 'manager'].includes(role)) throw new HttpError(403, 'Only management can waive a required assessment section.');
    if (!String(req.body?.notes || '').trim()) throw new HttpError(400, 'A reason is required when waiving an assessment section.');
    upsertResult({ attemptId: attempt.id, key: component.key, type: component.type, label: component.label, status: 'waived', score: null, maxScore: component.maxScore, weight: component.weight, selectedLevelId, notes: req.body?.notes || null, evaluatorUserId: user.userId, payloadJson: JSON.stringify({ waived: true }) });
    res.json(stmtResults.all(attempt.id));
    return;
  }

  // Timing: a timed-out component cannot be scored as completed (waive instead).
  if (result?.timeout_flag || result?.status === 'timed_out') throw new HttpError(409, `Component "${component.label}" timed out; it can only be waived with management approval.`);

  const scored = scoreComponentBody(component, req.body ?? {}, snapshot.tests || [], attempt.id);
  const prov = scoreProvenance(scored.score ?? 0, component.maxScore, component.weight);
  upsertResult({
    attemptId: attempt.id, key: component.key, type: component.type, label: component.label,
    status: 'completed', score: scored.score, maxScore: component.maxScore, weight: component.weight,
    selectedLevelId, notes: req.body?.notes || null, resultText: req.body?.resultText || null,
    evaluatorUserId: user.userId, rawScore: scored.rawScore ?? scored.score, percentage: prov.percentage, weightedScore: prov.weightedScore,
    payloadJson: JSON.stringify(scored.payload),
    submittedAt: result?.submitted_at ?? nowIso(),
    elapsedSeconds: result?.elapsed_seconds ?? null,
  });
  writeAudit(req, `Scored placement component "${component.label}" for ${visitor.full_name} (${scored.score}/${component.maxScore})`);
  res.json(stmtResults.all(attempt.id));
}));

// ============================================================================
// §COMPLETE — weighted total → decision engine → recommendation → fee
// ============================================================================
placementAttemptRouter.post('/visitors/:visitorId/placement/attempts/:attemptId/complete', authorize('owner', 'registrar', 'manager', 'counselor'), ah(async (req, res) => {
  const user = getUserContext(req);
  const { visitor, attempt } = loadAttemptContext(req, req.params.visitorId, req.params.attemptId);
  assertAttemptEditable(attempt);
  const snapshot = parseSnapshot(attempt);
  const components: PolicyComponent[] = snapshot.profile?.components || [];
  const results = stmtResults.all(attempt.id) as any[];
  // Lazily mark any expired component timers before evaluating completeness.
  for (const r of results) enforceComponentTimeout(attempt.id, r.component_key, r);
  const profile = snapshot.profile || {};

  const missing = getRequiredMissing(components, results);
  if (missing.length > 0) throw new HttpError(400, `Complete all required assessment sections first: ${missing.join(', ')}`);
  const explicitLevel = assertNoConflictingLevels(results);

  const scored = results.filter((r) => r.status === 'completed' && Number(r.weight) > 0 && r.score != null);
  if (scored.length === 0 && !explicitLevel) throw new HttpError(400, 'At least one scored section or an explicit level assessment is required.');

  const decisionRulesJson = profile.decisionRules != null ? JSON.stringify(profile.decisionRules) : (snapshot.decisionRules != null ? JSON.stringify(snapshot.decisionRules) : null);
  const decision = evaluateDecision({
    components, results, rules: snapshot.profile?.placementRules || [],
    decisionRulesJson,
    levels: profile.levels || [], scoringModel: String(profile.scoringModel || 'weighted_average'),
    passScore: Number(profile.passScore ?? 60),
  });
  const { percentage, recommendedLevelId, decisionRuleId, recommendationText } = decision;
  const totalScore = percentage == null ? null : Math.round(percentage * 100) / 100;
  const maxScore = 100;

  // AUTHORITATIVE OUTCOME. The decision engine already knows whether the policy
  // was met (required components, per-component minScore, overall passScore);
  // before this hardening every caller discarded that verdict, which is how a
  // 10% candidate completed and enrolled. The sitting is still RECORDED — a
  // failed exam is a real, auditable, billable business event — but the
  // outcome is persisted so the conversion boundary can refuse it.
  const { outcome, reasons } = evaluateOutcome(decision);

  // Billing is policy-driven and snapshotted with the attempt, so changing the
  // academic configuration mid-flight cannot alter what this sitting costs.
  const retakePolicy = readRetakePolicy(profile);
  const priorCompleted = Number((stmtVisitorCompletedCount.get(visitor.id) as any).c || 0);
  const billing = evaluateBilling(retakePolicy, priorCompleted, Number(resolveFee(db, visitor.branch_id, 'placementTestFee') || 0));
  const placementFee = billing.amount;
  const date = today();
  const resultSnapshot = JSON.stringify({ percentage, totalScore, maxScore, outcome, unmetRequirements: decision.unmetRequirements, recommendation: { levelId: recommendedLevelId, text: recommendationText, ruleId: decisionRuleId }, results, policyVersion: snapshot.policyVersion ?? profile.policyVersion ?? 1 });

  let feeReceipt: string | null = null;
  let feePaymentId: string | null = null;
  const tx = db.transaction(() => {
    const updated = stmtCompleteAttempt.run(totalScore, maxScore, percentage, recommendedLevelId, recommendationText, user.userId, decisionRuleId, outcome, attempt.id) as any;
    if (updated.changes !== 1) throw new HttpError(409, 'This placement attempt is already closed.');
    stmtUpdateVisitorPlacement.run(resultSnapshot, profile.method, attempt.id, visitor.id);
    if (billing.billable && placementFee > 0) {
      const paymentId = id('pay');
      const receiptNumber = nextReceiptNumber();
      stmtInsertPlacementFeePayment.run(paymentId, placementFee, date, `Placement assessment fee — ${visitor.full_name}`, receiptNumber, visitor.branch_id, `placement:${attempt.id}`);
      recordIncome({ category: 'placement', amount: placementFee, date, description: `Placement assessment fee for ${visitor.full_name}`, referenceId: attempt.id, paymentId, operatorName: user.fullName, operatorRole: user.role ?? null, branchId: visitor.branch_id });
      feeReceipt = receiptNumber;
      feePaymentId = paymentId;
    }
  });
  tx();
  if (billing.billable && placementFee > 0) addNotification('Placement Assessment Recorded', `Placement assessment completed for ${visitor.full_name}. Fee: ${placementFee} AFN.`, 'success', visitor.branch_id);
  writeAudit(req, `Completed placement assessment for ${visitor.full_name}: ${percentage}% — ${outcome.toUpperCase()} — ${recommendationText}`, {
    newValue: JSON.stringify({ ...JSON.parse(resultSnapshot), decisionRuleId, fee: { amount: placementFee, receipt: feeReceipt, paymentId: feePaymentId, attemptId: attempt.id, reason: billing.reason } }),
  });
  // A failed sitting is a successful recording of a real outcome, so this stays
  // HTTP 200 and reports the authoritative verdict in the body. Enrollment is
  // blocked independently at the conversion boundary.
  res.json({
    ok: true,
    outcome,
    passed: outcome === 'passed',
    unmetRequirements: decision.unmetRequirements,
    failureReasons: reasons,
    feeCharged: placementFee,
    decision: { percentage, recommendedLevelId, decisionRuleId, recommendationText },
    attempt: mapAttempt(stmtAttempt.get(attempt.id)),
  });
}));

// ============================================================================
// §PAUSE / RESUME
// ============================================================================
placementAttemptRouter.post('/visitors/:visitorId/placement/attempts/:attemptId/pause', authorize('owner', 'manager', 'counselor'), ah(async (req, res) => {
  const user = getUserContext(req);
  const { visitor, attempt } = loadAttemptContext(req, req.params.visitorId, req.params.attemptId);
  const { pausedAt } = pauseAttempt(attempt, req.body?.reason || null);
  writeAudit(req, `Paused placement attempt for ${visitor.full_name}`, { newValue: JSON.stringify({ attemptId: attempt.id, pausedAt, reason: req.body?.reason || null, operatorId: user.userId }) });
  res.json({ ok: true, status: 'paused', pausedAt });
}));

placementAttemptRouter.post('/visitors/:visitorId/placement/attempts/:attemptId/resume', authorize('owner', 'manager', 'counselor'), ah(async (req, res) => {
  const user = getUserContext(req);
  const { visitor, attempt } = loadAttemptContext(req, req.params.visitorId, req.params.attemptId);
  const { resumedAt, pauseSeconds } = resumeAttempt(attempt);
  writeAudit(req, `Resumed placement attempt for ${visitor.full_name} (${pauseSeconds}s pause applied)`, { newValue: JSON.stringify({ attemptId: attempt.id, resumedAt, pauseSeconds }) });
  res.json({ ok: true, status: 'in_progress', resumedAt, pauseSeconds });
}));

// ============================================================================
// §CANCEL
// ============================================================================
placementAttemptRouter.post('/visitors/:visitorId/placement/attempts/:attemptId/cancel', authorize('owner', 'registrar', 'manager', 'counselor'), ah(async (req, res) => {
  const user = getUserContext(req);
  const { visitor, attempt } = loadAttemptContext(req, req.params.visitorId, req.params.attemptId);
  if (!['in_progress', 'paused'].includes(attempt.status)) throw new HttpError(409, 'Only an in-progress placement attempt can be cancelled.');
  db.transaction(() => {
    db.prepare(`UPDATE placement_assessment_attempts SET status='cancelled', completed_at=datetime('now'), updated_at=datetime('now'), notes=? WHERE id=?`)
      .run(String(req.body?.reason || 'Cancelled by operator').trim().slice(0, 500), attempt.id);
    db.prepare(`UPDATE visitors SET placement_status='scheduled', placement_status_at=datetime('now'), current_placement_attempt_id=NULL WHERE id=? AND current_placement_attempt_id=?`)
      .run(visitor.id, attempt.id);
  })();
  writeAudit(req, `Cancelled placement assessment for ${visitor.full_name}`, { newValue: JSON.stringify({ attemptId: attempt.id, reason: String(req.body?.reason || 'Cancelled by operator').trim().slice(0, 500), operatorId: user.userId }) });
  res.json({ ok: true, status: 'cancelled' });
}));

// ============================================================================
// §OVERRIDE — authorized manual placement decision (audited)
// ============================================================================
placementAttemptRouter.post('/visitors/:visitorId/placement/attempts/:attemptId/override', authorize('owner', 'manager'), ah(async (req, res) => {
  const user = getUserContext(req);
  const { visitor, attempt } = loadAttemptContext(req, req.params.visitorId, req.params.attemptId);
  if (attempt.status !== 'completed') throw new HttpError(409, 'Only a completed placement attempt can be overridden.');
  const levelId = req.body?.levelId ? String(req.body.levelId) : null;
  const reason = String(req.body?.reason || '').trim();
  if (!levelId || !reason) throw new HttpError(400, 'Override requires a levelId and a reason.');
  const snapshot = parseSnapshot(attempt);
  const level = (snapshot.profile?.levels || []).find((l: any) => l.id === levelId);
  if (!level) throw new HttpError(400, 'Override level is not part of this program.');
  const before = { recommendedLevelId: attempt.recommended_level_id, recommendationText: attempt.recommendation_text };
  const visitorRow = getVisitorOr404(req.params.visitorId);
  // ATOMIC: the attempt row and the visitor's denormalised placement_score copy
  // describe the same decision. Writing them outside a transaction allowed a
  // failure between the two to leave the enrolled level contradicting the
  // audited override, with no error surfaced.
  const applyOverride = db.transaction(() => {
    db.prepare(`UPDATE placement_assessment_attempts SET override_level_id=?, override_reason=?, override_by=?, override_at=datetime('now'), recommended_level_id=?, recommendation_text=?, updated_at=datetime('now') WHERE id=?`)
      .run(levelId, reason, user.userId, levelId, `${level.name} — manual override: ${reason}`, attempt.id);
    if (visitorRow.placement_score) {
      try {
        const score = JSON.parse(visitorRow.placement_score);
        score.recommendation = { ...score.recommendation, levelId, text: `${level.name} — manual override: ${reason}`, overridden: true, overrideBy: user.userId, overrideAt: nowIso() };
        db.prepare(`UPDATE visitors SET placement_score=? WHERE id=?`).run(JSON.stringify(score), visitorRow.id);
      } catch { /* placement_score not JSON — leave untouched */ }
    }
  });
  applyOverride();
  writeAudit(req, `Manual placement override for ${visitor.full_name}: ${before.recommendedLevelId} → ${levelId}`, { oldValue: JSON.stringify(before), newValue: JSON.stringify({ recommendedLevelId: levelId, reason, operatorId: user.userId, attemptId: attempt.id }) });
  res.json({ ok: true, recommendedLevelId: levelId, recommendationText: `${level.name} — manual override: ${reason}` });
}));

// ============================================================================
// §SCORE CORRECTION — audited post-completion correction (recomputes decision)
// ============================================================================
placementAttemptRouter.post('/visitors/:visitorId/placement/attempts/:attemptId/components/:componentKey/correct', authorize('owner', 'manager'), ah(async (req, res) => {
  const user = getUserContext(req);
  const { visitor, attempt } = loadAttemptContext(req, req.params.visitorId, req.params.attemptId);
  if (attempt.status !== 'completed') throw new HttpError(409, 'Only a completed placement attempt can have scores corrected.');
  const reason = String(req.body?.reason || '').trim();
  if (!reason) throw new HttpError(400, 'A correction reason is required (audit).');
  const snapshot = parseSnapshot(attempt);
  const component = (snapshot.profile?.components || []).find((c: PolicyComponent) => c.key === req.params.componentKey);
  if (!component) throw new HttpError(404, 'Assessment component not found.');
  const results = stmtResults.all(attempt.id) as any[];
  const existing = results.find((r) => r.component_key === component.key);
  if (!existing || existing.status !== 'completed') throw new HttpError(409, 'Only completed components can be corrected.');

  const scored = scoreComponentBody(component, req.body ?? {}, snapshot.tests || [], attempt.id);
  const prov = scoreProvenance(scored.score ?? 0, component.maxScore, component.weight);
  const nextVersion = Number(existing.score_version || 1) + 1;
  const profile = snapshot.profile || {};
  const visitorRow = getVisitorOr404(req.params.visitorId);

  // ATOMIC: a correction rewrites the component result, its correction
  // metadata, the attempt's recomputed decision AND the visitor's denormalised
  // copy. These are one business fact; a partial write would leave the
  // recorded decision disagreeing with the scores it was derived from.
  let decision!: ReturnType<typeof evaluateDecision>;
  let outcome!: 'passed' | 'failed';
  const applyCorrection = db.transaction(() => {
    upsertResult({
      attemptId: attempt.id, key: component.key, type: component.type, label: component.label,
      status: 'completed', score: scored.score, maxScore: component.maxScore, weight: component.weight,
      notes: existing.notes, resultText: String(req.body?.resultText ?? existing.result_text ?? ''),
      evaluatorUserId: user.userId, rawScore: scored.rawScore ?? scored.score, percentage: prov.percentage, weightedScore: prov.weightedScore,
      scoreVersion: nextVersion, payloadJson: JSON.stringify(scored.payload),
    });
    db.prepare(`UPDATE placement_assessment_results SET corrected_at=datetime('now'), correction_reason=?, updated_at=datetime('now') WHERE attempt_id=? AND component_key=?`)
      .run(reason.slice(0, 500), attempt.id, component.key);

    // Re-run the decision engine and re-derive the authoritative outcome, so a
    // correction can legitimately flip a sitting between passed and failed.
    decision = evaluateDecision({
      components: snapshot.profile?.components || [], results: stmtResults.all(attempt.id) as any[],
      rules: snapshot.profile?.placementRules || [], decisionRulesJson: profile.decisionRules != null ? JSON.stringify(profile.decisionRules) : null,
      levels: profile.levels || [], scoringModel: String(profile.scoringModel || 'weighted_average'), passScore: Number(profile.passScore ?? 60),
    });
    outcome = evaluateOutcome(decision).outcome;
    db.prepare(`UPDATE placement_assessment_attempts SET total_score=?, percentage=?, recommended_level_id=?, recommendation_text=?, decision_rule_id=?, outcome=?, updated_at=datetime('now') WHERE id=?`)
      .run(decision.percentage, decision.percentage, decision.recommendedLevelId, decision.recommendationText, decision.decisionRuleId, outcome, attempt.id);
    const resultSnapshot = JSON.stringify({ percentage: decision.percentage, totalScore: decision.percentage, maxScore: 100, outcome, unmetRequirements: decision.unmetRequirements, recommendation: { levelId: decision.recommendedLevelId, text: decision.recommendationText, ruleId: decision.decisionRuleId }, results: stmtResults.all(attempt.id), policyVersion: snapshot.policyVersion ?? 1 });
    db.prepare(`UPDATE visitors SET placement_score=? WHERE id=?`).run(resultSnapshot, visitorRow.id);
  });
  applyCorrection();

  writeAudit(req, `Score correction for ${visitor.full_name} component "${component.label}" (v${existing.score_version || 1} → v${nextVersion})`, {
    oldValue: JSON.stringify({ score: existing.score, percentage: existing.percentage, resultText: existing.result_text }),
    newValue: JSON.stringify({ score: scored.score, percentage: prov.percentage, outcome, reason, operatorId: user.userId }),
  });
  res.json({ ok: true, score: scored.score, percentage: prov.percentage, scoreVersion: nextVersion, outcome, decision: { percentage: decision.percentage, recommendedLevelId: decision.recommendedLevelId, decisionRuleId: decision.decisionRuleId, recommendationText: decision.recommendationText } });
}));

// ============================================================================
// §HISTORY
// ============================================================================
placementAttemptRouter.get('/visitors/:visitorId/placement/attempts', authorize('owner', 'registrar', 'manager', 'counselor'), ah(async (req, res) => {
  const visitor = getVisitorOr404(req.params.visitorId);
  assertVisitorBranchAccess(req, visitor);
  res.json((stmtAttempts.all(visitor.id) as any[]).map((a) => mapAttempt(a)));
}));

// ============================================================================
// §MAINTENANCE — on-demand expiry sweep (owner/manager)
// ============================================================================
placementAttemptRouter.post('/maintenance/expire', authorize('owner', 'manager'), ah(async (req, res) => {
  const user = getUserContext(req);
  const now = nowIso();
  let expiredCount = 0;
  // Branch scope is mandatory for this sweep. It used to run unfiltered, so a
  // manager at ANY branch expired live attempts across every other branch —
  // the only cross-branch mutation in the subsystem (certification finding
  // C-3). `resolveBranchScope` is the established convention: it silently
  // re-scopes a foreign ?branchId= to the caller's own branch, and only grants
  // isAll to a role that genuinely holds all-branch access.
  const scope = resolveBranchScope(req);
  db.transaction(() => {
    // Expire both in-progress AND paused attempts that are past their expiry
    // (pause freezes component timers; it does not exempt the attempt from its
    // overall deadline).
    const due = (scope.isAll
      ? db.prepare(`SELECT id, visitor_id FROM placement_assessment_attempts WHERE status IN ('in_progress','paused') AND expires_at IS NOT NULL AND expires_at < ?`).all(now)
      : db.prepare(`SELECT id, visitor_id FROM placement_assessment_attempts WHERE status IN ('in_progress','paused') AND expires_at IS NOT NULL AND expires_at < ? AND branch_id = ?`).all(now, scope.branchId)
    ) as Array<{ id: string; visitor_id: string }>;
    expiredCount = due.length;
    for (const a of due) {
      db.prepare(`UPDATE placement_assessment_attempts SET status='expired', completed_at=datetime('now'), updated_at=datetime('now') WHERE id=? AND status IN ('in_progress','paused')`).run(a.id);
      db.prepare(`UPDATE visitors SET placement_status='not_started', placement_status_at=datetime('now'), current_placement_attempt_id=NULL WHERE id=? AND current_placement_attempt_id=?`).run(a.visitor_id, a.id);
    }
  })();
  writeAudit(req, `Placement expiry sweep: ${expiredCount} attempt(s) marked expired`, { newValue: JSON.stringify({ count: expiredCount, operatorId: user.userId, scope: scope.isAll ? 'all_branches' : scope.branchId }) });
  res.json({ ok: true, expired: expiredCount });
}));

// ============================================================================
// §REPORT — placement activity (actual-activity-only)
// ============================================================================
placementAttemptRouter.get('/report', requirePermission('Report.View', 'Finance.Report'), ah(async (req, res) => {
  const { from, to } = req.query as Record<string, string | undefined>;
  if (!from || !to) throw new HttpError(400, 'from and to (YYYY-MM-DD) are required.');
  const branchId = typeof req.query.branchId === 'string' ? req.query.branchId : null;
  res.json(placementActivityReport({ from, to, branchId }));
}));
