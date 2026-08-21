import { ACADEMIC_DEFAULTS } from '../configuration/policy-catalog.js';
import type Database from 'better-sqlite3';
import { id as makeId } from '../../utils/ids.js';
import { assertMoney } from '../../utils/money.js';

export interface CreateVersionInput {
  programId: string;
  versionLabel: string;
  versionNumber?: number;
  durationMonths?: number;
  description?: string;
  copyFromVersionId?: string | null;
  createdBy?: string | null;
}

export class AcademicCatalogService {
  // Pre-compiled statements for maximum performance
  private stmtListAll: Database.Statement;
  private stmtListByProgram: Database.Statement;
  private stmtGetVersion: Database.Statement;
  private stmtGetLevelsByVersion: Database.Statement;
  private stmtGetSubjectsByVersion: Database.Statement;
  private stmtGetModulesBySubjects: Database.Statement;
  private stmtGetPromotionRules: Database.Statement;
  private stmtGetPlacementRules: Database.Statement;
  private stmtGetFeeRules: Database.Statement;
  
  private stmtGetProgram: Database.Statement;
  private stmtGetMaxVersionNumber: Database.Statement;
  private stmtInsertVersion: Database.Statement;
  private stmtGetUnversionedLevels: Database.Statement;
  private stmtUpdateLevelVersion: Database.Statement;

  // Copy statements
  private stmtGetLevelsForCopy: Database.Statement;
  private stmtInsertLevelForCopy: Database.Statement;
  private stmtGetSubjectsForCopy: Database.Statement;
  private stmtInsertSubjectForCopy: Database.Statement;
  private stmtGetModulesForCopy: Database.Statement;
  private stmtInsertModuleForCopy: Database.Statement;
  private stmtGetPromosForCopy: Database.Statement;
  private stmtInsertPromoForCopy: Database.Statement;
  private stmtGetPlacementsForCopy: Database.Statement;
  private stmtInsertPlacementForCopy: Database.Statement;
  private stmtGetFeesForCopy: Database.Statement;
  private stmtInsertFeeForCopy: Database.Statement;

  // Publish statements
  private stmtGetVersionForPublish: Database.Statement;
  private stmtArchiveOtherVersions: Database.Statement;
  private stmtPublishVersion: Database.Statement;
  private stmtUnsetDefaultVersions: Database.Statement;

  // Evaluation & Fee statements
  private stmtGetPlacementRulesForRecommend: Database.Statement;
  private stmtGetLevelById: Database.Statement;
  private stmtGetPromoRuleForEval: Database.Statement;
  private stmtGetFeeRuleByType: Database.Statement;
  private stmtGetBranchFee: Database.Statement;
  private stmtGetLevelDefaultFee: Database.Statement;
  private stmtGetBranchProfile: Database.Statement;

  constructor(private db: Database.Database) {
    this.stmtListAll = db.prepare(`SELECT pv.*, p.name AS program_name, p.branch_id FROM program_versions pv JOIN programs p ON p.id = pv.program_id ORDER BY p.name, pv.version_number DESC`);
    this.stmtListByProgram = db.prepare(`SELECT pv.*, p.name AS program_name, p.branch_id FROM program_versions pv JOIN programs p ON p.id = pv.program_id WHERE pv.program_id = ? ORDER BY pv.version_number DESC`);
    // created_by stores a user id. Surfacing the raw UUID in the Versions &
    // Rules pane told the operator nothing, so resolve it to a name here —
    // LEFT JOIN because the author may since have been deleted, and losing the
    // version record over a missing user would be far worse.
    this.stmtGetVersion = db.prepare(
      `SELECT pv.*, p.name AS program_name, p.branch_id, u.full_name AS created_by_name
         FROM program_versions pv
         JOIN programs p ON p.id = pv.program_id
         LEFT JOIN users u ON u.id = pv.created_by
        WHERE pv.id = ?`
    );
    this.stmtGetLevelsByVersion = db.prepare(`SELECT * FROM levels WHERE program_version_id = ? OR (program_id = (SELECT program_id FROM program_versions WHERE id = ?) AND program_version_id IS NULL) ORDER BY "order" ASC`);
    this.stmtGetSubjectsByVersion = db.prepare(`SELECT * FROM subjects WHERE program_version_id = ? ORDER BY sort_order, code`);
    this.stmtGetModulesBySubjects = db.prepare(`SELECT * FROM modules WHERE subject_id IN (SELECT value FROM json_each(?)) ORDER BY sort_order`);
    this.stmtGetPromotionRules = db.prepare(`SELECT * FROM promotion_rules WHERE program_version_id = ? AND is_active = 1`);
    this.stmtGetPlacementRules = db.prepare(`SELECT * FROM placement_rules WHERE program_version_id = ? AND is_active = 1 ORDER BY sort_order, min_score`);
    this.stmtGetFeeRules = db.prepare(`SELECT * FROM fee_rules WHERE program_version_id = ? AND is_active = 1`);

    this.stmtGetProgram = db.prepare('SELECT * FROM programs WHERE id = ?');
    this.stmtGetMaxVersionNumber = db.prepare('SELECT MAX(version_number) AS m FROM program_versions WHERE program_id = ?');
    this.stmtInsertVersion = db.prepare(
      `INSERT INTO program_versions (id, program_id, version_label, version_number, status, duration_months, description, created_by, created_at)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, datetime('now'))`
    );
    this.stmtGetUnversionedLevels = db.prepare('SELECT id FROM levels WHERE program_id = ? AND program_version_id IS NULL');
    this.stmtUpdateLevelVersion = db.prepare('UPDATE levels SET program_version_id = ? WHERE id = ?');

    this.stmtGetLevelsForCopy = db.prepare('SELECT * FROM levels WHERE program_version_id = ?');
    this.stmtInsertLevelForCopy = db.prepare(
      `INSERT INTO levels (id, program_id, name, "order", prerequisites, program_version_id, code, duration_months, default_fee, pass_mark, is_active, min_viable_size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    );
    this.stmtGetSubjectsForCopy = db.prepare('SELECT * FROM subjects WHERE program_version_id = ?');
    this.stmtInsertSubjectForCopy = db.prepare(
      `INSERT INTO subjects (id, program_version_id, level_id, code, name, description, hours, sort_order, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))`
    );
    this.stmtGetModulesForCopy = db.prepare('SELECT * FROM modules WHERE subject_id = ?');
    this.stmtInsertModuleForCopy = db.prepare(
      `INSERT INTO modules (id, subject_id, code, name, description, hours, sort_order, assessment_type, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))`
    );
    this.stmtGetPromosForCopy = db.prepare('SELECT * FROM promotion_rules WHERE program_version_id = ?');
    this.stmtInsertPromoForCopy = db.prepare(
      `INSERT INTO promotion_rules (id, program_version_id, from_level_id, to_level_id, name, min_score, min_attendance_pct, require_all_subjects, auto_promote, branch_id, is_active, version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, datetime('now'))`
    );
    this.stmtGetPlacementsForCopy = db.prepare('SELECT * FROM placement_rules WHERE program_version_id = ?');
    this.stmtInsertPlacementForCopy = db.prepare(
      `INSERT INTO placement_rules (id, program_version_id, name, min_score, max_score, recommended_level_id, recommended_level_code, branch_id, sort_order, is_active, version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, datetime('now'))`
    );
    this.stmtGetFeesForCopy = db.prepare('SELECT * FROM fee_rules WHERE program_version_id = ?');
    this.stmtInsertFeeForCopy = db.prepare(
      `INSERT INTO fee_rules (id, program_version_id, level_id, branch_id, fee_type, name, amount, currency, is_optional, effective_from, effective_to, version, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, datetime('now'))`
    );

    this.stmtGetVersionForPublish = db.prepare('SELECT * FROM program_versions WHERE id = ?');
    this.stmtArchiveOtherVersions = db.prepare(`UPDATE program_versions SET status = 'archived', effective_to = date('now') WHERE program_id = ? AND status = 'published' AND id != ?`);
    this.stmtPublishVersion = db.prepare(`UPDATE program_versions SET status = 'published', is_default = 1, published_at = datetime('now'), effective_from = COALESCE(effective_from, date('now')) WHERE id = ?`);
    this.stmtUnsetDefaultVersions = db.prepare(`UPDATE program_versions SET is_default = 0 WHERE program_id = ? AND id != ?`);

    this.stmtGetPlacementRulesForRecommend = db.prepare(
      `SELECT * FROM placement_rules WHERE program_version_id = ? AND is_active = 1 AND (branch_id IS NULL OR branch_id = ?) ORDER BY branch_id DESC, sort_order, min_score`
    );
    this.stmtGetLevelById = db.prepare('SELECT * FROM levels WHERE id = ?');
    this.stmtGetPromoRuleForEval = db.prepare(
      `SELECT * FROM promotion_rules WHERE program_version_id = ? AND is_active = 1 AND (from_level_id IS NULL OR from_level_id = ?) AND (branch_id IS NULL OR branch_id = ?) ORDER BY branch_id DESC LIMIT 1`
    );
    this.stmtGetFeeRuleByType = db.prepare(
      `SELECT * FROM fee_rules WHERE fee_type = ? AND is_active = 1 AND (branch_id IS NULL OR branch_id = ?) AND (program_version_id IS NULL OR program_version_id = ?) AND (level_id IS NULL OR level_id = ?) AND (effective_from IS NULL OR effective_from <= date('now')) AND (effective_to IS NULL OR effective_to >= date('now')) ORDER BY branch_id DESC, level_id DESC, version DESC LIMIT 1`
    );
    this.stmtGetBranchFee = db.prepare('SELECT fee FROM level_branch_fees WHERE level_id = ? AND branch_id = ?');
    this.stmtGetLevelDefaultFee = db.prepare('SELECT name, default_fee FROM levels WHERE id = ?');
    this.stmtGetBranchProfile = db.prepare('SELECT * FROM branch_academic_profiles WHERE branch_id = ?');
  }

  listProgramVersions(programId?: string) {
    return programId ? this.stmtListByProgram.all(programId) : this.stmtListAll.all();
  }

  getVersionTree(versionId: string) {
    const version = this.stmtGetVersion.get(versionId) as any;
    if (!version) return null;

    const levels = this.stmtGetLevelsByVersion.all(versionId, versionId) as any[];
    const subjects = this.stmtGetSubjectsByVersion.all(versionId) as any[];
    
    let modules: any[] = [];
    if (subjects.length > 0) {
      modules = this.stmtGetModulesBySubjects.all(JSON.stringify(subjects.map(s => s.id))) as any[];
    }

    return {
      version,
      levels,
      subjects: subjects.map(s => ({
        ...s,
        modules: modules.filter(m => m.subject_id === s.id),
      })),
      promotionRules: this.stmtGetPromotionRules.all(versionId),
      placementRules: this.stmtGetPlacementRules.all(versionId),
    };
  }

  createVersion(input: CreateVersionInput) {
    const program = this.stmtGetProgram.get(input.programId) as any;
    if (!program) throw new Error('Program not found');
    if (typeof input.versionLabel !== 'string' || !input.versionLabel.trim()) {
      throw new Error('Version label is required.');
    }
    if (input.copyFromVersionId) {
      const source = this.stmtGetVersion.get(input.copyFromVersionId) as { id: string; program_id: string } | undefined;
      if (!source) throw new Error('Source program version not found.');
      if (source.program_id !== input.programId) {
        throw new Error('A program version can only copy another version of the same program.');
      }
    }
    if (input.description !== undefined && input.description !== null && typeof input.description !== 'string') {
      throw new Error('Version description must be text.');
    }

    let versionNumber = input.versionNumber;
    if (versionNumber !== undefined && (!Number.isInteger(versionNumber) || versionNumber < 1)) {
      throw new Error('Version number must be a positive integer.');
    }
    if (!versionNumber) {
      const max = this.stmtGetMaxVersionNumber.get(input.programId) as { m: number | null };
      versionNumber = (max.m || 0) + 1;
    }
    const durationMonths = input.durationMonths ?? program.duration_months ?? 0;
    if (!Number.isInteger(durationMonths) || durationMonths < 0) {
      throw new Error('Duration months must be a non-negative integer.');
    }

    const newId = makeId('pv');
    
    // Transaction ensures atomicity: if copying fails, no partial version is created.
    const tx = this.db.transaction(() => {
      this.stmtInsertVersion.run(
        newId, input.programId, input.versionLabel.trim(), versionNumber,
        durationMonths,
        input.description ?? program.description ?? null,
        input.createdBy ?? null
      );

      if (input.copyFromVersionId) {
        this.copyVersionContents(input.copyFromVersionId, newId);
      } else {
        const unversioned = this.stmtGetUnversionedLevels.all(input.programId) as { id: string }[];
        for (const l of unversioned) {
          this.stmtUpdateLevelVersion.run(newId, l.id);
        }
      }
    });
    tx();

    return this.getVersionTree(newId);
  }

  private copyVersionContents(fromId: string, toId: string) {
    const levels = this.stmtGetLevelsForCopy.all(fromId) as any[];
    const levelMap = new Map<string, string>();
    // Allocate every target id first, then topologically order the source
    // levels. The database rejects dangling JSON edges, so a dependent cannot
    // be inserted before the copied prerequisite it will reference.
    for (const l of levels) levelMap.set(l.id, makeId('lvl'));
    const prerequisiteMap = new Map<string, string[]>();
    for (const l of levels) {
      const parsed: unknown = JSON.parse(l.prerequisites || '[]');
      if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
        throw new Error(`Invalid prerequisite graph for level ${l.id}.`);
      }
      prerequisiteMap.set(l.id, parsed);
    }
    const pendingLevels = [...levels];
    const orderedLevels: any[] = [];
    const insertedSourceIds = new Set<string>();
    while (pendingLevels.length > 0) {
      const nextIndex = pendingLevels.findIndex((level) =>
        prerequisiteMap.get(level.id)!.every((prerequisiteId) =>
          !levelMap.has(prerequisiteId) || insertedSourceIds.has(prerequisiteId),
        ),
      );
      if (nextIndex < 0) throw new Error('Program version contains a cyclic prerequisite graph.');
      const [nextLevel] = pendingLevels.splice(nextIndex, 1);
      orderedLevels.push(nextLevel);
      insertedSourceIds.add(nextLevel.id);
    }

    for (const l of orderedLevels) {
      const rawPrerequisites = prerequisiteMap.get(l.id)!;
      const remappedPrerequisites = rawPrerequisites.map((prerequisiteId) => {
        const copiedId = levelMap.get(prerequisiteId);
        if (copiedId) return copiedId;
        const sharedLevel = this.stmtGetLevelById.get(prerequisiteId) as
          | { program_id: string; program_version_id: string | null }
          | undefined;
        if (sharedLevel && sharedLevel.program_id === l.program_id && sharedLevel.program_version_id === null) {
          return prerequisiteId;
        }
        throw new Error(`Prerequisite ${prerequisiteId} is outside the copied program version.`);
      });
      const newLvlId = levelMap.get(l.id)!;
      this.stmtInsertLevelForCopy.run(
        newLvlId, l.program_id, l.name, l.order, JSON.stringify(remappedPrerequisites), toId, l.code,
        l.duration_months, l.default_fee, l.pass_mark, l.is_active, l.min_viable_size
      );
    }

    const subjects = this.stmtGetSubjectsForCopy.all(fromId) as any[];
    const subjectMap = new Map<string, string>();
    for (const s of subjects) {
      const newSubId = makeId('subj');
      subjectMap.set(s.id, newSubId);
      this.stmtInsertSubjectForCopy.run(
        newSubId, toId, s.level_id ? levelMap.get(s.level_id) ?? null : null,
        s.code, s.name, s.description, s.hours, s.sort_order
      );
    }

    for (const s of subjects) {
      const modules = this.stmtGetModulesForCopy.all(s.id) as any[];
      const newSubId = subjectMap.get(s.id)!;
      for (const m of modules) {
        this.stmtInsertModuleForCopy.run(
          makeId('mod'), newSubId, m.code, m.name, m.description, m.hours, m.sort_order, m.assessment_type
        );
      }
    }

    const promos = this.stmtGetPromosForCopy.all(fromId) as any[];
    for (const r of promos) {
      this.stmtInsertPromoForCopy.run(
        makeId('promo'), toId, r.from_level_id ? levelMap.get(r.from_level_id) ?? null : null,
        r.to_level_id ? levelMap.get(r.to_level_id) ?? null : null, r.name, r.min_score,
        r.min_attendance_pct, r.require_all_subjects, r.auto_promote, r.branch_id
      );
    }

    const placements = this.stmtGetPlacementsForCopy.all(fromId) as any[];
    for (const r of placements) {
      this.stmtInsertPlacementForCopy.run(
        makeId('place'), toId, r.name, r.min_score, r.max_score,
        r.recommended_level_id ? levelMap.get(r.recommended_level_id) ?? null : null,
        r.recommended_level_code, r.branch_id, r.sort_order
      );
    }

    const fees = this.stmtGetFeesForCopy.all(fromId) as any[];
    for (const f of fees) {
      this.stmtInsertFeeForCopy.run(
        makeId('fee'), toId, f.level_id ? levelMap.get(f.level_id) ?? null : null,
        f.branch_id, f.fee_type, f.name, f.amount, f.currency, f.is_optional,
        f.effective_from, f.effective_to
      );
    }
  }

  publishVersion(versionId: string) {
    const v = this.stmtGetVersionForPublish.get(versionId) as any;
    if (!v) throw new Error('Version not found');
    if (v.status === 'archived') throw new Error('Cannot publish archived version');

    const tx = this.db.transaction(() => {
      this.stmtArchiveOtherVersions.run(v.program_id, versionId);
      this.stmtPublishVersion.run(versionId);
      this.stmtUnsetDefaultVersions.run(v.program_id, versionId);
    });
    tx();

    return this.getVersionTree(versionId);
  }

  recommendLevel(programVersionId: string, totalScore: number, branchId?: string | null) {
    const rules = this.stmtGetPlacementRulesForRecommend.all(programVersionId, branchId ?? null) as any[];
    const match = rules.find(r => totalScore >= r.min_score && totalScore <= r.max_score);
    if (!match) return null;
    
    const level = match.recommended_level_id ? this.stmtGetLevelById.get(match.recommended_level_id) : null;
    return { rule: match, level };
  }

  evaluatePromotion(params: { programVersionId: string; fromLevelId: string; score: number; attendancePct: number; branchId?: string | null; }) {
    const rule = this.stmtGetPromoRuleForEval.get(params.programVersionId, params.fromLevelId, params.branchId ?? null) as any;

    if (!rule) {
      return { eligible: params.score >= ACADEMIC_DEFAULTS.levelPassMark && params.attendancePct >= ACADEMIC_DEFAULTS.defaultMinAttendance, rule: null, reasons: [`No explicit promotion rule; using defaults (${ACADEMIC_DEFAULTS.levelPassMark}/${ACADEMIC_DEFAULTS.defaultMinAttendance}).`] };
    }

    const reasons: string[] = [];
    const scoreOk = params.score >= rule.min_score;
    const attOk = params.attendancePct >= rule.min_attendance_pct;
    if (!scoreOk) reasons.push(`Score ${params.score} < required ${rule.min_score}`);
    if (!attOk) reasons.push(`Attendance ${params.attendancePct}% < required ${rule.min_attendance_pct}%`);

    return { eligible: scoreOk && attOk, rule, toLevelId: rule.to_level_id, autoPromote: !!rule.auto_promote, reasons };
  }

  buildFeeSnapshot(params: { programVersionId?: string | null; levelId?: string | null; branchId: string; enrollmentType?: string; }) {
    const fees: { feeType: string; name: string; amount: number }[] = [];

    const addFromRules = (feeType: string) => {
      const row = this.stmtGetFeeRuleByType.get(
        feeType, params.branchId, params.programVersionId ?? null, params.levelId ?? null
      ) as any;
      if (row) {
        fees.push({
          feeType: row.fee_type,
          name: row.name,
          amount: assertMoney(row.amount, `Stored ${row.fee_type} fee`),
        });
      }
    };

    addFromRules('registration');
    addFromRules('semester');
    if (params.enrollmentType === 'repeat' || params.enrollmentType === 'partial_repeat') {
      addFromRules('retake');
    }

    if (!fees.some(f => f.feeType === 'semester') && params.levelId) {
      const branchFee = this.stmtGetBranchFee.get(params.levelId, params.branchId) as { fee: number } | undefined;
      const level = this.stmtGetLevelDefaultFee.get(params.levelId) as { name: string; default_fee: number } | undefined;
      const amount = assertMoney(branchFee?.fee ?? level?.default_fee ?? 0, 'Stored tuition fee');
      if (amount > 0) {
        fees.push({ feeType: 'semester', name: `Tuition — ${level?.name || 'Level'}`, amount });
      }
    }

    const profile = this.stmtGetBranchProfile.get(params.branchId) as any;
    if (profile) {
      const registrationFee = assertMoney(profile.registration_fee ?? 0, 'Stored registration fee');
      if (registrationFee > 0 && !fees.some(f => f.feeType === 'registration')) {
        fees.push({ feeType: 'registration', name: 'Registration fee', amount: registrationFee });
      }
    }

    const total = assertMoney(fees.reduce((sum, fee) => sum + fee.amount, 0), 'Fee snapshot total');
    return { fees, total, currency: 'AFN', generatedAt: new Date().toISOString() };
  }
}

export function getCatalogService(db: Database.Database) {
  return new AcademicCatalogService(db);
}