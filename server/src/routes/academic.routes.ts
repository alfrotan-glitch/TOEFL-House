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
import {
  normalizeRequirementMode,
  validateDecisionRules,
  validateMoney,
  validatePolicyComponents,
  validatePositiveInteger,
  validateScoringModel,
} from '../core/placement/policy-engine.js';

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
const stmtInsertPlacementProfile = db.prepare(`
  INSERT INTO placement_assessment_profiles
    (id, program_version_id, branch_id, components_json, scoring_model,
     allow_retake, pass_score, instructions, requirement_mode,
     first_level_exempt, expires_minutes, decision_rules_json, max_attempts,
     first_attempt_billable, retake_billable, retake_fee_amount, version, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
`);
const stmtUpdatePlacementProfile = db.prepare(`
  UPDATE placement_assessment_profiles
  SET components_json=?, scoring_model=?, allow_retake=?, pass_score=?,
      instructions=?, requirement_mode=?, first_level_exempt=?, expires_minutes=?,
      decision_rules_json=?, max_attempts=?, first_attempt_billable=?,
      retake_billable=?, retake_fee_amount=?, version=version+1,
      updated_at=datetime('now')
  WHERE id=? AND version=?
`);

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
    version: null,
    required: false,
    enabled: false,
    requirementMode: 'not_required',
    firstLevelExempt: false,
    expiresMinutes: null,
    decisionRules: [],
    method: PLACEMENT_DEFAULTS.method,
    sections: [...PLACEMENT_DEFAULTS.sections],
    components: [...PLACEMENT_DEFAULTS.components],
    scoringModel: PLACEMENT_DEFAULTS.scoringModel,
    allowRetake: PLACEMENT_DEFAULTS.allowRetake,
    maxAttempts: null,
    firstAttemptBillable: true,
    retakeBillable: false,
    retakeFeeAmount: null,
    passScore: PLACEMENT_DEFAULTS.passScore,
    instructions: null,
  };
  if (!profile) return res.json(defaults);
  const components = (() => {
    try { return JSON.parse(profile.components_json || '[]'); } catch { throw new HttpError(500, 'Stored placement components are invalid.'); }
  })();
  const decisionRules = (() => {
    try { return JSON.parse(profile.decision_rules_json || '[]'); } catch { throw new HttpError(500, 'Stored placement decision rules are invalid.'); }
  })();
  const types = new Set(components.map((component: any) => component.type));
  const method = components.length === 0 ? PLACEMENT_DEFAULTS.method : types.size > 1 ? 'hybrid' : components[0].type;
  const sections = Array.from(new Set(components.flatMap((component: any) => component.skills ?? [])));
  res.json({
    configured: true,
    version: Number(profile.version),
    programVersionId: version.id,
    programName: version.program_name,
    versionLabel: version.version_label,
    required: profile.requirement_mode === 'required',
    enabled: profile.requirement_mode !== 'not_required',
    requirementMode: profile.requirement_mode,
    firstLevelExempt: Boolean(profile.first_level_exempt),
    expiresMinutes: profile.expires_minutes == null ? null : Number(profile.expires_minutes),
    decisionRules,
    method,
    sections,
    components,
    scoringModel: profile.scoring_model || 'weighted_average',
    allowRetake: Boolean(profile.allow_retake),
    maxAttempts: profile.max_attempts == null ? null : Number(profile.max_attempts),
    firstAttemptBillable: profile.first_attempt_billable == null ? true : Boolean(profile.first_attempt_billable),
    retakeBillable: Boolean(profile.retake_billable),
    retakeFeeAmount: profile.retake_fee_amount == null ? null : Number(profile.retake_fee_amount),
    passScore: Number(profile.pass_score),
    instructions: profile.instructions,
  });
}));

function placementBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new HttpError(400, `${field} must be boolean.`);
  return value;
}

academicRouter.put('/program-versions/:id/placement-profile', requirePermission('Curriculum.PlacementPolicy'), ah(async (req, res) => {
  const version = db.prepare(`SELECT pv.id, pv.status, p.branch_id, p.name AS program_name, pv.version_label FROM program_versions pv JOIN programs p ON p.id = pv.program_id WHERE pv.id = ?`).get(req.params.id) as any;
  if (!version) throw new HttpError(404, 'Program version not found.');
  requireAcademicBranchAccess(req, version.branch_id);
  const body = req.body ?? {};
  const requirementMode = normalizeRequirementMode(body.requirementMode);
  const enabled = requirementMode !== 'not_required';
  const required = requirementMode === 'required';
  if (body.enabled !== undefined && placementBoolean(body.enabled, 'enabled', enabled) !== enabled) throw new HttpError(400, 'enabled contradicts requirementMode.');
  if (body.required !== undefined && placementBoolean(body.required, 'required', required) !== required) throw new HttpError(400, 'required contradicts requirementMode.');

  const normalized = validatePolicyComponents(body.components ?? [], requirementMode);
  if (required && !normalized.some((component) => component.required)) {
    throw new HttpError(400, 'A required placement policy needs at least one required component.');
  }
  for (const component of normalized) {
    if (component.type !== 'content_test' || !component.testId) continue;
    const test = db.prepare('SELECT id, status, branch_id FROM placement_tests WHERE id=?').get(component.testId) as any;
    if (!test) throw new HttpError(400, `Component ${component.key} references a missing placement test.`);
    if (test.status !== 'active') throw new HttpError(400, `Component ${component.key} references a test that is not active.`);
    if (test.branch_id != null && test.branch_id !== version.branch_id) throw new HttpError(400, `Component ${component.key} references a test from another branch.`);
    const questionTypes = (db.prepare('SELECT qtype FROM placement_test_questions WHERE test_id=?').all(test.id) as Array<{ qtype: string }>).map((question) => question.qtype);
    if (questionTypes.length === 0) throw new HttpError(400, `Component ${component.key} references a test with no questions.`);
    const hasAuto = questionTypes.some((type) => type === 'mcq' || type === 'short_answer');
    const hasManual = questionTypes.some((type) => type === 'essay' || type === 'speaking');
    const expectedScoring = hasAuto && hasManual ? 'hybrid' : hasManual ? 'manual' : 'auto';
    if (component.scoringMethod !== expectedScoring) {
      throw new HttpError(400, `Component ${component.key} scoringMethod must be ${expectedScoring} for the selected test content.`);
    }
  }
  const componentTypes = new Set(normalized.map((component) => component.type));
  const method = normalized.length === 0 ? PLACEMENT_DEFAULTS.method : componentTypes.size > 1 ? 'hybrid' : normalized[0].type;
  const sections = Array.from(new Set(normalized.flatMap((component) => component.skills ?? [])));
  const levelIds = new Set((db.prepare(`
    SELECT l.id FROM levels l
    JOIN program_versions pv ON pv.id=? AND pv.program_id=l.program_id
    WHERE l.is_active=1 AND (l.program_version_id=? OR l.program_version_id IS NULL)
  `).all(version.id, version.id) as any[]).map((level) => String(level.id)));
  const decisionRules = validateDecisionRules(body.decisionRules ?? [], normalized, levelIds);
  const scoringModel = validateScoringModel(body.scoringModel);
  if (body.maxScore !== undefined) throw new HttpError(400, 'Overall maxScore is derived as 100%; configure each component maxScore instead.');
  const passScore = body.passScore ?? 60;
  if (typeof passScore !== 'number' || !Number.isFinite(passScore) || passScore < 0 || passScore > 100) throw new HttpError(400, 'passScore must be between 0 and 100.');
  const expiresMinutes = body.expiresMinutes == null || body.expiresMinutes === ''
    ? null
    : validatePositiveInteger(body.expiresMinutes, 'expiresMinutes', false, 525600);
  const firstLevelExempt = placementBoolean(body.firstLevelExempt, 'firstLevelExempt', false) ? 1 : 0;
  if (firstLevelExempt && requirementMode !== 'required') throw new HttpError(400, 'firstLevelExempt applies only to a required placement policy.');
  const allowRetake = placementBoolean(body.allowRetake, 'allowRetake', true);
  const maxAttempts = validatePositiveInteger(body.maxAttempts, 'maxAttempts', true, 100);
  const firstAttemptBillable = placementBoolean(body.firstAttemptBillable, 'firstAttemptBillable', true) ? 1 : 0;
  const retakeBillable = placementBoolean(body.retakeBillable, 'retakeBillable', false) ? 1 : 0;
  const retakeFeeAmount = validateMoney(body.retakeFeeAmount, 'retakeFeeAmount');
  if (body.instructions !== undefined && body.instructions !== null && typeof body.instructions !== 'string') {
    throw new HttpError(400, 'instructions must be text.');
  }
  if (typeof body.instructions === 'string' && body.instructions.length > 4000) {
    throw new HttpError(400, 'instructions must be no longer than 4000 characters.');
  }
  const instructions = body.instructions == null || body.instructions.trim() === '' ? null : body.instructions.trim();

  const existing = db.prepare(`SELECT * FROM placement_assessment_profiles WHERE program_version_id=? AND branch_id=?`).get(req.params.id, version.branch_id) as any;
  if (existing) {
    if (body.version !== existing.version) throw new HttpError(409, 'Placement policy changed since it was loaded. Refresh and retry.');
    const updated = stmtUpdatePlacementProfile.run(
      JSON.stringify(normalized), scoringModel, allowRetake ? 1 : 0, passScore,
      instructions, requirementMode, firstLevelExempt, expiresMinutes,
      JSON.stringify(decisionRules), maxAttempts, firstAttemptBillable,
      retakeBillable, retakeFeeAmount, existing.id, existing.version,
    ) as any;
    if (updated.changes !== 1) throw new HttpError(409, 'Placement policy changed since it was loaded. Refresh and retry.');
  } else {
    if (body.version != null) throw new HttpError(409, 'Placement policy state changed. Refresh and retry.');
    stmtInsertPlacementProfile.run(
      id('pap'), req.params.id, version.branch_id, JSON.stringify(normalized),
      scoringModel, allowRetake ? 1 : 0, passScore, instructions, requirementMode,
      firstLevelExempt, expiresMinutes, JSON.stringify(decisionRules), maxAttempts,
      firstAttemptBillable, retakeBillable, retakeFeeAmount,
    );
  }
  const row = stmtGetPlacementProfiles.get(req.params.id, version.branch_id) as any;
  writeAudit(req, `Updated placement assessment configuration for ${version.program_name} ${version.version_label}`, {
    oldValue: existing ? JSON.stringify({ id: existing.id, version: existing.version, requirementMode: existing.requirement_mode }) : undefined,
    newValue: JSON.stringify({ id: row.id, version: row.version, requirementMode, components: normalized.map((component) => component.key) }),
  });
  res.json({
    configured: true,
    version: Number(row.version),
    programVersionId: req.params.id,
    programName: version.program_name,
    versionLabel: version.version_label,
    required,
    enabled,
    requirementMode,
    firstLevelExempt: Boolean(row.first_level_exempt),
    expiresMinutes: row.expires_minutes == null ? null : Number(row.expires_minutes),
    decisionRules,
    method,
    sections,
    components: normalized,
    scoringModel,
    allowRetake,
    maxAttempts,
    firstAttemptBillable: Boolean(row.first_attempt_billable),
    retakeBillable: Boolean(row.retake_billable),
    retakeFeeAmount: row.retake_fee_amount == null ? null : Number(row.retake_fee_amount),
    passScore,
    instructions,
  });
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
    // `startDate !== undefined ? startDate : existing` looks safe but is not:
    // the edit form always sends its whole state
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
    const { branchId, isAll } = resolveBranchScope(req);
    if (isAll || !branchId) {
      throw new HttpError(400, 'Select one branch for the branch configuration snapshot.');
    }
    const programRows = stmtGetProgramsActive.all() as any[];
    const visiblePrograms = programRows.filter((row) => row.branch_id === branchId);
    const visibleProgramIds = new Set(visiblePrograms.map((row) => row.id));
    const programs = visiblePrograms.map(mapProgram);
    const levels = (stmtGetAllLevels.all() as any[])
      .filter((row) => visibleProgramIds.has(row.program_id))
      .map(mapLevel);
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
