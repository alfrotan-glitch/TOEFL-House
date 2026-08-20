/**
 * Academic Configuration API
 * Data-driven programs, levels, branch fees, time slots, rooms, terms.
 * Operational modules must resolve fees/slots from this configuration — never hard-code.
 */
import { Router } from 'express';
import { db } from '../db/connection.js';
import { assertTextLengths, TEXT_LIMITS } from '../utils/textInput.js';
import { authenticate, authorize, requirePermission, denyPermissionless, resolveBranchScope, canAccessBranchResource } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { assertMoney, assertPerformanceScore } from '../utils/money.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { assertOptionalIsoDate, assertDateRange } from '../utils/isoDate.js';
import { id } from '../utils/ids.js';
import { ACADEMIC_DEFAULTS, PLACEMENT_DEFAULTS } from '../core/configuration/policy-catalog.js';
import { validatePolicyComponents, validateDecisionRules } from '../core/placement/policy-engine.js';

export const academicRouter = Router();
academicRouter.use(authenticate);
// Academic configuration is branch-wide operational data (calendar, rooms,
// slots, fees, programs). Several reads below carry no permission gate of their
// own, which let a permissionless principal — notably the `student` portal
// role, whose position deliberately grants `permissions: {}` — read the whole
// branch's configuration. `denyPermissionless` is the project's existing guard
// for exactly this (see audit.routes.ts and branches.routes.ts): it admits any
// position holding at least one permission and rejects self-service principals.
// It grants nobody new access; it only closes the permissionless read path.
academicRouter.use(denyPermissionless);
academicRouter.get('/defaults', requirePermission('AcademicSetup.Edit'), ah(async (_req, res) => {
  res.json({
    levelDurationMonths: ACADEMIC_DEFAULTS.levelDurationMonths,
    levelDefaultFee: ACADEMIC_DEFAULTS.levelDefaultFee,
    levelPassMark: ACADEMIC_DEFAULTS.levelPassMark,
    levelMinViableSize: ACADEMIC_DEFAULTS.levelMinViableSize,
  });
}));


// ── Performance Optimization: Prepared Statements ──────────────────────────
// Compile SQL queries ONCE at module load to maximize API throughput.
const stmtGetProgramsActive = db.prepare(`SELECT * FROM programs WHERE COALESCE(is_active, 1) = 1 ORDER BY name`);
const stmtGetProgramsAll = db.prepare(`SELECT * FROM programs ORDER BY name`);
const stmtGetProgramById = db.prepare('SELECT * FROM programs WHERE id = ?');
const stmtInsertProgram = db.prepare(
  `INSERT INTO programs (id, name, description, duration_months, branch_id, code, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)`
);
const stmtUpdateProgram = db.prepare(
  `UPDATE programs SET name=?, description=?, duration_months=?, code=?, is_active=? WHERE id=?`
);
const stmtCountLevelsByProgram = db.prepare('SELECT COUNT(*) as c FROM levels WHERE program_id = ?');
const stmtCountClassesByProgram = db.prepare('SELECT COUNT(*) as c FROM classes WHERE program_id = ?');
const stmtDeactivateProgram = db.prepare('UPDATE programs SET is_active = 0 WHERE id = ?');
const stmtDeleteProgram = db.prepare('DELETE FROM programs WHERE id = ?');

const stmtGetLevelsByProgram = db.prepare('SELECT * FROM levels WHERE program_id = ? ORDER BY "order" ASC');
const stmtGetAllLevels = db.prepare('SELECT * FROM levels ORDER BY program_id, "order" ASC');
const stmtGetLevelById = db.prepare('SELECT * FROM levels WHERE id = ?');
const stmtInsertLevel = db.prepare(
  `INSERT INTO levels (id, program_id, name, "order", prerequisites, code, duration_months, default_fee, pass_mark, is_active, min_viable_size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const stmtUpdateLevel = db.prepare(
  `UPDATE levels SET name=?, "order"=?, prerequisites=?, code=?, duration_months=?, default_fee=?, pass_mark=?, is_active=?, min_viable_size=? WHERE id=?`
);
const stmtCountClassesByLevel = db.prepare('SELECT COUNT(*) as c FROM classes WHERE level_id = ?');
const stmtDeactivateLevel = db.prepare('UPDATE levels SET is_active = 0 WHERE id = ?');
const stmtDeleteLevelFees = db.prepare('DELETE FROM level_branch_fees WHERE level_id = ?');
const stmtDeleteLevel = db.prepare('DELETE FROM levels WHERE id = ?');

const stmtGetFeesByLevelBranch = db.prepare('SELECT * FROM level_branch_fees WHERE level_id = ? AND branch_id = ?');
const stmtGetFeesByBranch = db.prepare('SELECT * FROM level_branch_fees WHERE branch_id = ?');
const stmtGetFeeById = db.prepare('SELECT * FROM level_branch_fees WHERE id = ?');
const stmtUpdateLevelFee = db.prepare('UPDATE level_branch_fees SET fee = ? WHERE id = ?');
const stmtInsertLevelFee = db.prepare('INSERT INTO level_branch_fees (id, level_id, branch_id, fee) VALUES (?, ?, ?, ?)');

const stmtGetAllTimeSlots = db.prepare('SELECT * FROM time_slots ORDER BY branch_id, sort_order, start_time');
const stmtGetTimeSlotsByBranch = db.prepare('SELECT * FROM time_slots WHERE branch_id = ? ORDER BY sort_order, start_time');
const stmtGetTimeSlotById = db.prepare('SELECT * FROM time_slots WHERE id = ?');
const stmtInsertTimeSlot = db.prepare(
  `INSERT INTO time_slots (id, branch_id, code, label, start_time, end_time, is_active, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);
const stmtUpdateTimeSlot = db.prepare(
  `UPDATE time_slots SET code=?, label=?, start_time=?, end_time=?, sort_order=?, is_active=? WHERE id=?`
);
const stmtDeactivateTimeSlot = db.prepare('UPDATE time_slots SET is_active = 0 WHERE id = ?');

const stmtGetAllRooms = db.prepare('SELECT * FROM rooms ORDER BY branch_id, name');
const stmtGetRoomsByBranch = db.prepare('SELECT * FROM rooms WHERE branch_id = ? ORDER BY name');
const stmtGetRoomById = db.prepare('SELECT * FROM rooms WHERE id = ?');
const stmtInsertRoom = db.prepare(
  `INSERT INTO rooms (id, branch_id, code, name, capacity, is_active, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`
);
const stmtUpdateRoom = db.prepare(`UPDATE rooms SET code=?, name=?, capacity=?, notes=?, is_active=? WHERE id=?`);
const stmtDeactivateRoom = db.prepare('UPDATE rooms SET is_active = 0 WHERE id = ?');

const stmtGetAllTerms = db.prepare('SELECT * FROM academic_terms ORDER BY year DESC, code');
const stmtGetTermsByBranch = db.prepare('SELECT * FROM academic_terms WHERE branch_id = ? ORDER BY year DESC, code');
const stmtGetTermById = db.prepare('SELECT * FROM academic_terms WHERE id = ?');
const stmtInsertTerm = db.prepare(
  `INSERT INTO academic_terms (id, branch_id, year, code, name, start_date, end_date, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);
const stmtUpdateTerm = db.prepare(
  `UPDATE academic_terms SET year=?, code=?, name=?, start_date=?, end_date=?, is_active=? WHERE id=?`
);

// ── Mappers ─────────────────────────────────────────────────────────────────

function mapProgram(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    code: row.code ?? null,
    description: row.description ?? null,
    durationMonths: row.duration_months ?? 0,
    branchId: row.branch_id,
    isActive: row.is_active === undefined ? true : !!row.is_active,
    organizationId: row.organization_id ?? null,
    createdAt: row.created_at ?? null,
  };
}

function mapLevel(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    programId: row.program_id,
    name: row.name,
    code: row.code ?? null,
    order: row.order ?? row['order'] ?? 1,
    prerequisites: (() => {
      try {
        return JSON.parse(row.prerequisites || '[]');
      } catch {
        return [];
      }
    })(),
    durationMonths: row.duration_months ?? ACADEMIC_DEFAULTS.levelDurationMonths,
    defaultFee: row.default_fee ?? ACADEMIC_DEFAULTS.levelDefaultFee,
    passMark: row.pass_mark ?? ACADEMIC_DEFAULTS.levelPassMark,
    minViableSize: row.min_viable_size ?? ACADEMIC_DEFAULTS.levelMinViableSize,
    isActive: row.is_active === undefined ? true : !!row.is_active,
  };
}

function mapFee(row: any) {
  return {
    id: row.id,
    levelId: row.level_id,
    branchId: row.branch_id,
    fee: row.fee,
    currency: row.currency || 'AFN',
    effectiveFrom: row.effective_from ?? null,
    effectiveTo: row.effective_to ?? null,
  };
}

function mapSlot(row: any) {
  return {
    id: row.id,
    branchId: row.branch_id,
    code: row.code,
    label: row.label,
    startTime: row.start_time,
    endTime: row.end_time,
    isActive: !!row.is_active,
    sortOrder: row.sort_order ?? 0,
  };
}

function mapRoom(row: any) {
  return {
    id: row.id,
    branchId: row.branch_id,
    code: row.code,
    name: row.name,
    capacity: row.capacity ?? 0,
    isActive: !!row.is_active,
    notes: row.notes ?? null,
  };
}

function mapTerm(row: any) {
  return {
    id: row.id,
    branchId: row.branch_id,
    year: row.year,
    code: row.code,
    name: row.name,
    startDate: row.start_date ?? null,
    endDate: row.end_date ?? null,
    isActive: !!row.is_active,
  };
}

// P1 scope-hardening helpers: academic configuration is branch-owned.
const stmtGetProgramBranch = db.prepare('SELECT branch_id FROM programs WHERE id = ?');
const stmtGetLevelProgramBranch = db.prepare(`
  SELECT p.branch_id AS branch_id
  FROM levels l JOIN programs p ON p.id = l.program_id
  WHERE l.id = ?
`);

function requireAcademicBranchAccess(req: import('express').Request, branchId: string | null | undefined) {
  if (!branchId || !canAccessBranchResource(req, branchId)) {
    throw new HttpError(403, 'Academic resource belongs to another branch.');
  }
}

function requireProgramAccess(req: import('express').Request, programId: string) {
  const row = stmtGetProgramBranch.get(programId) as { branch_id: string } | undefined;
  if (!row) throw new HttpError(404, 'Program not found.');
  requireAcademicBranchAccess(req, row.branch_id);
  return row;
}

function requireLevelAccess(req: import('express').Request, levelId: string) {
  const row = stmtGetLevelProgramBranch.get(levelId) as { branch_id: string } | undefined;
  if (!row) throw new HttpError(404, 'Level not found.');
  requireAcademicBranchAccess(req, row.branch_id);
  return row;
}

// ── Programs ───────────────────────────────────────────────────────────────

academicRouter.get(
  '/programs',
  requirePermission('AcademicSetup.View', 'Class.View', 'Student.View', 'Lead.View'),
  ah(async (req, res) => {
    const activeOnly = req.query.active === 'true' || req.query.active === '1';
    const { branchId, isAll } = resolveBranchScope(req);
    const rows = isAll
      ? (activeOnly ? stmtGetProgramsActive.all() : stmtGetProgramsAll.all())
      : (activeOnly ? stmtGetProgramsActive.all().filter((r: any) => r.branch_id === branchId) : stmtGetProgramsAll.all().filter((r: any) => r.branch_id === branchId));
    res.json(rows.map(mapProgram));
  })
);

academicRouter.post(
  '/programs',
  requirePermission('AcademicSetup.Edit'),
  ah(async (req, res) => {
    const { name, code, description, durationMonths, isActive, branchId } = req.body ?? {};
    if (!name || !String(name).trim()) throw new HttpError(400, 'Program name is required.');
    assertTextLengths([[name, 'Program name', TEXT_LIMITS.name], [code, 'Code', TEXT_LIMITS.short], [description, 'Description', TEXT_LIMITS.notes]]);
    const resolvedBranch = branchId || req.user?.branchId;
    requireAcademicBranchAccess(req, resolvedBranch);
    const newId = id('prog');
    stmtInsertProgram.run(
      newId,
      String(name).trim(),
      description?.trim() || null,
      Number(durationMonths) || 0,
      resolvedBranch,
      code?.trim()?.toUpperCase() || null,
      isActive === false || isActive === 0 ? 0 : 1
    );
    writeAudit(req, `Created academic program: ${name}`);
    res.status(201).json(mapProgram(stmtGetProgramById.get(newId)));
  })
);

academicRouter.put(
  '/programs/:id',
  requirePermission('AcademicSetup.Edit'),
  ah(async (req, res) => {
    const existing = stmtGetProgramById.get(req.params.id) as any;
    if (!existing) throw new HttpError(404, 'Program not found.');
    requireAcademicBranchAccess(req, existing.branch_id);
    const { name, code, description, durationMonths, isActive } = req.body ?? {};
    stmtUpdateProgram.run(
      name ?? existing.name,
      description !== undefined ? description : existing.description,
      durationMonths ?? existing.duration_months,
      code !== undefined ? code : existing.code,
      isActive === false || isActive === 0 ? 0 : isActive === true || isActive === 1 ? 1 : existing.is_active ?? 1,
      req.params.id
    );
    writeAudit(req, `Updated academic program: ${existing.name}`);
    res.json(mapProgram(stmtGetProgramById.get(req.params.id)));
  })
);

academicRouter.delete(
  '/programs/:id',
  authorize('owner'),
  ah(async (req, res) => {
    const existing = stmtGetProgramById.get(req.params.id) as any;
    if (!existing) throw new HttpError(404, 'Program not found.');
    requireAcademicBranchAccess(req, existing.branch_id);
    
    const levelCount = (stmtCountLevelsByProgram.get(req.params.id) as { c: number }).c;
    const classCount = (stmtCountClassesByProgram.get(req.params.id) as { c: number }).c;
    
    if (levelCount > 0 || classCount > 0) {
      stmtDeactivateProgram.run(req.params.id);
      writeAudit(req, `Deactivated academic program (has dependencies): ${existing.name}`);
      res.json({ ok: true, deactivated: true });
      return;
    }
    stmtDeleteProgram.run(req.params.id);
    writeAudit(req, `Deleted academic program: ${existing.name}`);
    res.json({ ok: true, deleted: true });
  })
);

// ── Levels ─────────────────────────────────────────────────────────────────

academicRouter.get(
  '/levels',
  requirePermission('AcademicSetup.View', 'Class.View', 'Student.View', 'Lead.View'),
  ah(async (req, res) => {
    const programId = typeof req.query.programId === 'string' ? req.query.programId : null;
    const { branchId, isAll } = resolveBranchScope(req);
    if (programId) requireProgramAccess(req, programId);
    const rows = programId ? stmtGetLevelsByProgram.all(programId) : stmtGetAllLevels.all();
    const visible = isAll ? rows : (rows as any[]).filter((r) => {
      const p = stmtGetProgramBranch.get(r.program_id) as { branch_id: string } | undefined;
      return p?.branch_id === branchId;
    });
    res.json(visible.map(mapLevel));
  })
);

academicRouter.post(
  '/levels',
  requirePermission('AcademicSetup.Edit'),
  ah(async (req, res) => {
    const { programId, name, code, order, durationMonths, defaultFee, passMark, minViableSize, prerequisites, isActive } = req.body ?? {};
    if (!programId) throw new HttpError(400, 'programId is required.');
    if (!name || !String(name).trim()) throw new HttpError(400, 'Level name is required.');
    
    requireProgramAccess(req, programId);

    const newId = id('lvl');
    stmtInsertLevel.run(
      newId,
      programId,
      String(name).trim(),
      Number(order) || 1,
      JSON.stringify(prerequisites || []),
      code?.trim()?.toUpperCase() || null,
      Number(durationMonths) || ACADEMIC_DEFAULTS.levelDurationMonths,
      // `Number(defaultFee) || fallback` accepted 'abc' (NaN -> falls back
      // silently), -6000 and 1e15. A level fee is the SOURCE of every class
      // fee and therefore of every student's tuition, so a bad value here
      // propagates into enrolment and invoicing.
      defaultFee == null ? ACADEMIC_DEFAULTS.levelDefaultFee : assertMoney(defaultFee, 'default fee'),
      // ACFG-1: `Number(passMark) || levelPassMark` was a coercion, not a
      // validation. 'abc' became NaN and fell through to 70, and an explicit 0
      // did the same, so a typo silently became a valid-looking threshold; -1,
      // 101 and 1e9 were stored verbatim. levels.pass_mark is Layer 2 of the
      // promotion authority (promotion-engine.resolvePromotionCriteria) and
      // feeds `scoreOk = finalPercentage >= minScore`, whose outcome writes
      // student_semesters.status and drives enrollment transitions. Bounded
      // with the same 0..100 discipline the branch profile (Layer 3) already
      // enforced. Omitted/null still means "use the configured default".
      passMark == null ? ACADEMIC_DEFAULTS.levelPassMark : assertPerformanceScore(passMark, 'Level pass mark'),
      isActive === false || isActive === 0 ? 0 : 1,
      Number(minViableSize) >= 0 ? Number(minViableSize) : ACADEMIC_DEFAULTS.levelMinViableSize
    );
    writeAudit(req, `Created level: ${name}`);
    res.status(201).json(mapLevel(stmtGetLevelById.get(newId)));
  })
);

academicRouter.put(
  '/levels/:id',
  requirePermission('AcademicSetup.Edit'),
  ah(async (req, res) => {
    const existing = stmtGetLevelById.get(req.params.id) as any;
    if (!existing) throw new HttpError(404, 'Level not found.');
    requireLevelAccess(req, req.params.id);
    const { name, code, order, durationMonths, defaultFee, passMark, minViableSize, prerequisites, isActive } = req.body ?? {};
    
    stmtUpdateLevel.run(
      name ?? existing.name,
      order ?? existing.order,
      prerequisites !== undefined ? JSON.stringify(prerequisites) : existing.prerequisites,
      code !== undefined ? code : existing.code,
      durationMonths ?? existing.duration_months,
      defaultFee == null ? existing.default_fee : assertMoney(defaultFee, 'default fee'),
      // ACFG-1: this update wrote the raw body value with no validation at all,
      // so -1, 101, 1e9, 'abc' and true all reached levels.pass_mark (no CHECK
      // on the column). Same canonical bound as the create path; an omitted or
      // null passMark still means "leave unchanged".
      passMark == null ? existing.pass_mark : assertPerformanceScore(passMark, 'Level pass mark'),
      isActive === false || isActive === 0 ? 0 : isActive === true || isActive === 1 ? 1 : existing.is_active ?? 1,
      minViableSize !== undefined ? Number(minViableSize) : (existing.min_viable_size ?? ACADEMIC_DEFAULTS.levelMinViableSize),
      req.params.id
    );
    writeAudit(req, `Updated level: ${existing.name}`);
    res.json(mapLevel(stmtGetLevelById.get(req.params.id)));
  })
);

academicRouter.delete(
  '/levels/:id',
  authorize('owner'),
  ah(async (req, res) => {
    const existing = stmtGetLevelById.get(req.params.id) as any;
    if (!existing) throw new HttpError(404, 'Level not found.');
    requireLevelAccess(req, req.params.id);
    
    const classCount = (stmtCountClassesByLevel.get(req.params.id) as { c: number }).c;
    if (classCount > 0) {
      stmtDeactivateLevel.run(req.params.id);
      writeAudit(req, `Deactivated level (has classes): ${existing.name}`);
      res.json({ ok: true, deactivated: true });
      return;
    }
    
    stmtDeleteLevelFees.run(req.params.id);
    stmtDeleteLevel.run(req.params.id);
    writeAudit(req, `Deleted level: ${existing.name}`);
    res.json({ ok: true, deleted: true });
  })
);

// ── Branch fees ────────────────────────────────────────────────────────────

academicRouter.get(
  '/level-fees',
  ah(async (req, res) => {
    const { branchId } = resolveBranchScope(req);
    const levelId = typeof req.query.levelId === 'string' ? req.query.levelId : null;
    const rows = levelId ? stmtGetFeesByLevelBranch.all(levelId, branchId) : stmtGetFeesByBranch.all(branchId);
    res.json(rows.map(mapFee));
  })
);

academicRouter.put(
  '/level-fees',
  requirePermission('AcademicSetup.Edit'),
  ah(async (req, res) => {
    const { levelId, branchId, fee } = req.body ?? {};
    if (!levelId || fee == null) throw new HttpError(400, 'levelId and fee are required.');
    const validatedOverrideFee = assertMoney(fee, 'level fee');
    const resolvedBranch = branchId || req.user?.branchId;
    requireAcademicBranchAccess(req, resolvedBranch);
    requireLevelAccess(req, levelId);

    const existing = stmtGetFeesByLevelBranch.get(levelId, resolvedBranch) as any;
    if (existing) {
      stmtUpdateLevelFee.run(validatedOverrideFee, existing.id);
      res.json(mapFee(stmtGetFeeById.get(existing.id)));
      return;
    }
    
    const newId = id('lbf');
    stmtInsertLevelFee.run(newId, levelId, resolvedBranch, validatedOverrideFee);
    writeAudit(req, `Set branch fee for level ${levelId}: ${validatedOverrideFee}`);
    res.status(201).json(mapFee(stmtGetFeeById.get(newId)));
  })
);

/** Resolve effective fee for a level at a branch (override → default). */
academicRouter.get(
  '/resolve-fee',
  ah(async (req, res) => {
    const levelId = String(req.query.levelId || '');
    const branchId = String(req.query.branchId || req.user?.branchId);
    if (!levelId) throw new HttpError(400, 'levelId is required.');
    
    const level = stmtGetLevelById.get(levelId) as any;
    if (!level) throw new HttpError(404, 'Level not found.');
    requireAcademicBranchAccess(req, branchId);
    requireLevelAccess(req, levelId);
    
    const override = stmtGetFeesByLevelBranch.get(levelId, branchId) as any;
    res.json({
      levelId,
      branchId,
      fee: override ? override.fee : level.default_fee ?? 0,
      source: override ? 'branch_override' : 'level_default',
    });
  })
);


// ── Placement Assessment Profiles ───────────────────────────────────────────
const stmtGetPlacementProfiles = db.prepare(`SELECT pap.*, pv.program_id, pv.version_label, p.name AS program_name FROM placement_assessment_profiles pap JOIN program_versions pv ON pv.id = pap.program_version_id JOIN programs p ON p.id = pv.program_id WHERE pap.program_version_id = ? AND (pap.branch_id = ? OR pap.branch_id IS NULL) ORDER BY pap.branch_id IS NOT NULL DESC`);
const stmtUpsertPlacementProfile = db.prepare(`INSERT INTO placement_assessment_profiles (id, program_version_id, branch_id, enabled, required, method, sections_json, components_json, scoring_model, allow_retake, max_score, pass_score, instructions, requirement_mode, first_level_exempt, expires_minutes, decision_rules_json, max_attempts, first_attempt_billable, retake_billable, retake_fee_amount, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now')) ON CONFLICT(program_version_id, branch_id) DO UPDATE SET enabled=excluded.enabled, required=excluded.required, method=excluded.method, sections_json=excluded.sections_json, components_json=excluded.components_json, scoring_model=excluded.scoring_model, allow_retake=excluded.allow_retake, max_score=excluded.max_score, pass_score=excluded.pass_score, instructions=excluded.instructions, requirement_mode=excluded.requirement_mode, first_level_exempt=excluded.first_level_exempt, expires_minutes=excluded.expires_minutes, decision_rules_json=excluded.decision_rules_json, max_attempts=excluded.max_attempts, first_attempt_billable=excluded.first_attempt_billable, retake_billable=excluded.retake_billable, retake_fee_amount=excluded.retake_fee_amount, version=placement_assessment_profiles.version+1, updated_at=datetime('now')`);

academicRouter.get('/program-versions/:id/placement-profile', ah(async (req, res) => {
  const version = db.prepare(`SELECT pv.id, pv.status, pv.program_id, p.branch_id, p.name AS program_name, pv.version_label FROM program_versions pv JOIN programs p ON p.id = pv.program_id WHERE pv.id = ?`).get(req.params.id) as any;
  if (!version) throw new HttpError(404, 'Program version not found.');
  requireAcademicBranchAccess(req, version.branch_id);
  const profile = stmtGetPlacementProfiles.get(req.params.id, version.branch_id) as any;
  const defaults = {
    configured: false,
    programVersionId: version.id,
    programName: version.program_name,
    versionLabel: version.version_label,
    required: false,
    enabled: false,
    method: PLACEMENT_DEFAULTS.method,
    sections: [...PLACEMENT_DEFAULTS.sections],
    components: [...PLACEMENT_DEFAULTS.components],
    scoringModel: PLACEMENT_DEFAULTS.scoringModel,
    allowRetake: PLACEMENT_DEFAULTS.allowRetake,
    maxScore: PLACEMENT_DEFAULTS.maxScore,
    passScore: PLACEMENT_DEFAULTS.passScore,
    instructions: null,
  };
  if (!profile) return res.json(defaults);
  const sections = (() => {
    try { return JSON.parse(profile.sections_json || '[]'); } catch { return []; }
  })();
  let components = (() => {
    try { return JSON.parse(profile.components_json || '[]'); } catch { return []; }
  })();
  if (!Array.isArray(components) || components.length===0) components=defaults.components;
  res.json({ configured:true, programVersionId:version.id, programName:version.program_name, versionLabel:version.version_label, required:!!profile.required, enabled:!!profile.enabled, method:profile.method, sections, components, scoringModel:profile.scoring_model || 'weighted_average', allowRetake:!!profile.allow_retake, maxAttempts:profile.max_attempts == null ? null : Number(profile.max_attempts), firstAttemptBillable:profile.first_attempt_billable == null ? true : !!profile.first_attempt_billable, retakeBillable:!!profile.retake_billable, retakeFeeAmount:profile.retake_fee_amount == null ? null : Number(profile.retake_fee_amount), maxScore:Number(profile.max_score), passScore:Number(profile.pass_score), instructions:profile.instructions });
}));

academicRouter.put('/program-versions/:id/placement-profile', requirePermission('Curriculum.PlacementPolicy'), ah(async (req, res) => {
  const version = db.prepare(`SELECT pv.id, pv.status, p.branch_id, p.name AS program_name, pv.version_label FROM program_versions pv JOIN programs p ON p.id = pv.program_id WHERE pv.id = ?`).get(req.params.id) as any;
  if (!version) throw new HttpError(404, 'Program version not found.');
  requireAcademicBranchAccess(req, version.branch_id);
  const body = req.body ?? {};
  const requirementMode = String(body.requirementMode || (body.required === true ? 'required' : body.enabled === false ? 'not_required' : 'optional'));
  if (!['required', 'optional', 'not_required'].includes(requirementMode)) throw new HttpError(400, 'Invalid requirementMode (required/optional/not_required).');
  const enabled = body.enabled !== false && requirementMode !== 'not_required';
  const required = requirementMode === 'required';
  if (requirementMode === 'required' && !enabled) throw new HttpError(400, 'A required placement assessment must be enabled.');
  const components = Array.isArray(body.components) ? body.components : [];
  if (enabled && components.length === 0) throw new HttpError(400, 'At least one assessment component is required when placement is enabled.');
  if (required && enabled && components.length > 0 && !components.some((c: any) => c?.required !== false)) throw new HttpError(400, 'A required placement profile must contain at least one required assessment section.');
  const { components: normalized, method, sections } = validatePolicyComponents(components, version.branch_id);
  const decisionRules = validateDecisionRules(body.decisionRules ?? null, normalized);
  const scoringModel = String(body.scoringModel || 'weighted_average');
  if (!['weighted_average', 'average'].includes(scoringModel)) throw new HttpError(400, 'Unsupported placement scoring model.');
  const maxScore = Number(body.maxScore ?? 100);
  const passScore = Number(body.passScore ?? 60);
  if (!Number.isFinite(maxScore) || maxScore <= 0 || !Number.isFinite(passScore) || passScore < 0 || passScore > maxScore) throw new HttpError(400, 'Invalid placement score thresholds.');
  const expiresMinutes = body.expiresMinutes == null || body.expiresMinutes === '' ? null : Number(body.expiresMinutes);
  if (expiresMinutes != null && (!Number.isFinite(expiresMinutes) || expiresMinutes <= 0)) throw new HttpError(400, 'Invalid expiresMinutes.');
  const firstLevelExempt = body.firstLevelExempt === true || body.firstLevelExempt === 1 ? 1 : 0;
  // Retake + billing policy (migration 070). Omitted fields keep the historical
  // behaviour: unlimited attempts, first sitting billed, retakes free.
  const maxAttempts = body.maxAttempts == null || body.maxAttempts === '' ? null : Number(body.maxAttempts);
  if (maxAttempts != null && (!Number.isInteger(maxAttempts) || maxAttempts < 1)) throw new HttpError(400, 'maxAttempts must be a positive whole number.');
  // This is not inert configuration: evaluateBilling reads it back on every
  // retake and the value is charged through recordIncome inside the completion
  // transaction. `!Number.isFinite(x) || x < 0` is weaker than that charge
  // boundary, so a fee this endpoint accepted could not actually be paid.
  // Reproduced live: 0.001 stored fine, then the retake completion threw
  // "payment amount must have at most two decimal places" (HTTP 500) and rolled
  // back, leaving the attempt stranded in_progress with no payment — and every
  // retry failed identically, so the candidate could never finish. 1e15 and
  // 1e20 stranded it the same way via "exceeds supported monetary precision".
  // assertMoney is the canonical boundary already used by the level default fee
  // and level branch fee override in this same file.
  const retakeFeeAmount = body.retakeFeeAmount == null || body.retakeFeeAmount === ''
    ? null
    : assertMoney(body.retakeFeeAmount, 'retakeFeeAmount');
  const firstAttemptBillable = body.firstAttemptBillable === false || body.firstAttemptBillable === 0 ? 0 : 1;
  const retakeBillable = body.retakeBillable === true || body.retakeBillable === 1 ? 1 : 0;

  const existing = db.prepare(`SELECT * FROM placement_assessment_profiles WHERE program_version_id=? AND branch_id=?`).get(req.params.id, version.branch_id) as any;
  const args=[existing?.id || id('pap'), req.params.id, version.branch_id, enabled?1:0, required?1:0, method, JSON.stringify(sections), JSON.stringify(normalized), scoringModel, body.allowRetake === false ? 0 : 1, maxScore, passScore, body.instructions ? String(body.instructions).trim() : null, requirementMode, firstLevelExempt, expiresMinutes, decisionRules.length ? JSON.stringify(decisionRules) : null, maxAttempts, firstAttemptBillable, retakeBillable, retakeFeeAmount];
  stmtUpsertPlacementProfile.run(...args);
  writeAudit(req, `Updated placement assessment configuration for ${version.program_name} ${version.version_label}`);
  const row=stmtGetPlacementProfiles.get(req.params.id, version.branch_id) as any;
  let parsedSections: unknown[]; let parsedComponents: unknown[];
  try { parsedSections=JSON.parse(row.sections_json||'[]'); } catch { parsedSections=[]; }
  try { parsedComponents=JSON.parse(row.components_json||'[]'); } catch { parsedComponents=[]; }
  res.json({ configured:true, programVersionId:req.params.id, programName:version.program_name, versionLabel:version.version_label, required:!!row.required, enabled:!!row.enabled, method:row.method, sections:parsedSections, components:parsedComponents, scoringModel:row.scoring_model || 'weighted_average', allowRetake:!!row.allow_retake, maxAttempts:row.max_attempts == null ? null : Number(row.max_attempts), firstAttemptBillable:row.first_attempt_billable == null ? true : !!row.first_attempt_billable, retakeBillable:!!row.retake_billable, retakeFeeAmount:row.retake_fee_amount == null ? null : Number(row.retake_fee_amount), maxScore:Number(row.max_score), passScore:Number(row.pass_score), instructions:row.instructions });
}));

// ── Time slots ─────────────────────────────────────────────────────────────

academicRouter.get(
  '/time-slots',
  ah(async (req, res) => {
    const { branchId, isAll } = resolveBranchScope(req);
    const rows = isAll ? stmtGetAllTimeSlots.all() : stmtGetTimeSlotsByBranch.all(branchId);
    res.json(rows.map(mapSlot));
  })
);

academicRouter.post(
  '/time-slots',
  requirePermission('AcademicSetup.Edit'),
  ah(async (req, res) => {
    const { code, label, startTime, endTime, branchId, sortOrder, isActive } = req.body ?? {};
    if (!code || !label || !startTime || !endTime) {
      throw new HttpError(400, 'code, label, startTime, and endTime are required.');
    }
    const resolvedBranch = branchId || req.user?.branchId;
    requireAcademicBranchAccess(req, resolvedBranch);
    const newId = id('ts');
    try {
      stmtInsertTimeSlot.run(
        newId,
        resolvedBranch,
        String(code).trim().toUpperCase(),
        String(label).trim(),
        startTime,
        endTime,
        isActive === false ? 0 : 1,
        Number(sortOrder) || 0
      );
    } catch {
      throw new HttpError(409, 'Time slot code must be unique within the branch.');
    }
    writeAudit(req, `Created time slot ${code} for branch ${resolvedBranch}`);
    res.status(201).json(mapSlot(stmtGetTimeSlotById.get(newId)));
  })
);

academicRouter.put(
  '/time-slots/:id',
  requirePermission('AcademicSetup.Edit'),
  ah(async (req, res) => {
    const existing = stmtGetTimeSlotById.get(req.params.id) as any;
    if (!existing) throw new HttpError(404, 'Time slot not found.');
    requireAcademicBranchAccess(req, existing.branch_id);
    const { code, label, startTime, endTime, sortOrder, isActive } = req.body ?? {};
    
    stmtUpdateTimeSlot.run(
      code ?? existing.code,
      label ?? existing.label,
      startTime ?? existing.start_time,
      endTime ?? existing.end_time,
      sortOrder ?? existing.sort_order,
      isActive === false ? 0 : isActive === true ? 1 : existing.is_active,
      req.params.id
    );
    writeAudit(req, `Updated time slot ${existing.code}`);
    res.json(mapSlot(stmtGetTimeSlotById.get(req.params.id)));
  })
);

academicRouter.delete(
  '/time-slots/:id',
  requirePermission('AcademicSetup.Edit'),
  ah(async (req, res) => {
    const existing = stmtGetTimeSlotById.get(req.params.id) as any;
    if (!existing) throw new HttpError(404, 'Time slot not found.');
    requireAcademicBranchAccess(req, existing.branch_id);
    stmtDeactivateTimeSlot.run(req.params.id);
    writeAudit(req, `Deactivated time slot ${existing.code}`);
    res.json({ ok: true, isActive: false });
  })
);

// ── Rooms ──────────────────────────────────────────────────────────────────

academicRouter.get(
  '/rooms',
  ah(async (req, res) => {
    const { branchId, isAll } = resolveBranchScope(req);
    const rows = isAll ? stmtGetAllRooms.all() : stmtGetRoomsByBranch.all(branchId);
    res.json(rows.map(mapRoom));
  })
);

academicRouter.post(
  '/rooms',
  requirePermission('AcademicSetup.Edit'),
  ah(async (req, res) => {
    const { code, name, capacity, branchId, notes, isActive } = req.body ?? {};
    if (!code || !name) throw new HttpError(400, 'Room code and name are required.');
    const resolvedBranch = branchId || req.user?.branchId;
    requireAcademicBranchAccess(req, resolvedBranch);
    const newId = id('rm');
    try {
      stmtInsertRoom.run(
        newId,
        resolvedBranch,
        String(code).trim().toUpperCase(),
        String(name).trim(),
        Number(capacity) || 0,
        isActive === false ? 0 : 1,
        notes || null
      );
    } catch {
      throw new HttpError(409, 'Room code must be unique within the branch.');
    }
    writeAudit(req, `Created room ${name}`);
    res.status(201).json(mapRoom(stmtGetRoomById.get(newId)));
  })
);

academicRouter.put(
  '/rooms/:id',
  requirePermission('AcademicSetup.Edit'),
  ah(async (req, res) => {
    const existing = stmtGetRoomById.get(req.params.id) as any;
    if (!existing) throw new HttpError(404, 'Room not found.');
    requireAcademicBranchAccess(req, existing.branch_id);
    const { code, name, capacity, notes, isActive } = req.body ?? {};
    
    stmtUpdateRoom.run(
      code ?? existing.code,
      name ?? existing.name,
      capacity ?? existing.capacity,
      notes !== undefined ? notes : existing.notes,
      isActive === false ? 0 : isActive === true ? 1 : existing.is_active,
      req.params.id
    );
    writeAudit(req, `Updated room ${existing.name}`);
    res.json(mapRoom(stmtGetRoomById.get(req.params.id)));
  })
);

academicRouter.delete(
  '/rooms/:id',
  requirePermission('AcademicSetup.Edit'),
  ah(async (req, res) => {
    const existing = stmtGetRoomById.get(req.params.id) as any;
    if (!existing) throw new HttpError(404, 'Room not found.');
    requireAcademicBranchAccess(req, existing.branch_id);
    stmtDeactivateRoom.run(req.params.id);
    writeAudit(req, `Deactivated room ${existing.name}`);
    res.json({ ok: true, isActive: false });
  })
);

// ── Academic terms ─────────────────────────────────────────────────────────

academicRouter.get(
  '/terms',
  ah(async (req, res) => {
    const { branchId, isAll } = resolveBranchScope(req);
    const rows = isAll ? stmtGetAllTerms.all() : stmtGetTermsByBranch.all(branchId);
    res.json(rows.map(mapTerm));
  })
);

academicRouter.post(
  '/terms',
  requirePermission('AcademicSetup.Edit'),
  ah(async (req, res) => {
    const { year, code, name, startDate, endDate, branchId, isActive } = req.body ?? {};
    if (!year || !code || !name) throw new HttpError(400, 'year, code, and name are required.');
    const resolvedBranch = branchId || req.user?.branchId;
    requireAcademicBranchAccess(req, resolvedBranch);
    // Dates bound automatic session generation, so a malformed or reversed
    // range must never reach storage.
    const start = assertOptionalIsoDate(startDate, 'startDate');
    const end = assertOptionalIsoDate(endDate, 'endDate');
    assertDateRange(start, end);
    const newId = id('term');

    stmtInsertTerm.run(
      newId,
      resolvedBranch,
      Number(year),
      String(code).trim().toUpperCase(),
      String(name).trim(),
      start,
      end,
      isActive === false ? 0 : 1
    );
    writeAudit(req, `Created academic term ${name}`);
    res.status(201).json(mapTerm(stmtGetTermById.get(newId)));
  })
);

academicRouter.put(
  '/terms/:id',
  requirePermission('AcademicSetup.Edit'),
  ah(async (req, res) => {
    const existing = stmtGetTermById.get(req.params.id) as any;
    if (!existing) throw new HttpError(404, 'Academic term not found.');
    requireAcademicBranchAccess(req, existing.branch_id);
    const { year, code, name, startDate, endDate, isActive } = req.body ?? {};

    // PATCH-style semantics: a field that is not supplied stays unchanged.
    //
    // Previously this used `startDate !== undefined ? startDate : existing`,
    // which looks safe but is not: the edit form always sends its whole state
    // object, and its date inputs hold `''` when the form was hydrated without
    // them. `'' !== undefined` is true, so the empty string won a real stored
    // date and editing only a term's NAME silently erased its calendar,
    // breaking session generation. Clearing a date is therefore expressed
    // explicitly as `null`, never by an empty string.
    const resolveDate = (incoming: unknown, current: string | null): string | null => {
      if (incoming === undefined || incoming === '') return current;
      if (incoming === null) return null;
      return incoming as string;
    };
    const nextStart = assertOptionalIsoDate(resolveDate(startDate, existing.start_date), 'startDate');
    const nextEnd = assertOptionalIsoDate(resolveDate(endDate, existing.end_date), 'endDate');
    assertDateRange(nextStart, nextEnd);

    stmtUpdateTerm.run(
      year ?? existing.year,
      code ?? existing.code,
      name ?? existing.name,
      nextStart,
      nextEnd,
      isActive === false ? 0 : isActive === true ? 1 : existing.is_active,
      req.params.id
    );
    writeAudit(req, `Updated academic term ${existing.name}`);
    res.json(mapTerm(stmtGetTermById.get(req.params.id)));
  })
);

/** Branch configuration snapshot for operational engines. */
academicRouter.get(
  '/branch-config',
  ah(async (req, res) => {
    const { branchId } = resolveBranchScope(req);
    const programs = stmtGetProgramsActive.all().map(mapProgram);
    const levels = stmtGetAllLevels.all().map(mapLevel);
    const fees = stmtGetFeesByBranch.all(branchId).map(mapFee);
    const timeSlots = stmtGetTimeSlotsByBranch.all(branchId).map(mapSlot);
    const rooms = stmtGetRoomsByBranch.all(branchId).map(mapRoom);
    const terms = stmtGetTermsByBranch.all(branchId).map(mapTerm);

    const levelsWithFee = levels.map((lvl: any) => {
      const override = fees.find((f: any) => f.levelId === lvl.id);
      return {
        ...lvl,
        effectiveFee: override ? override.fee : lvl.defaultFee,
        feeSource: override ? 'branch_override' : 'level_default',
      };
    });

    res.json({
      branchId,
      programs,
      levels: levelsWithFee,
      timeSlots,
      rooms,
      terms,
      fees,
    });
  })
);

export default academicRouter;
