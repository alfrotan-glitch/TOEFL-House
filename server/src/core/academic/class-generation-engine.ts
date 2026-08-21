/**
 * TOEFL House ERP — Class Generation Engine
 * Auto-generates classes based on levels, time slots, rooms, and gender policies.
 */
import type Database from 'better-sqlite3';
import { id as makeId } from '../../utils/ids.js';
import { deriveCoarseClassStatus } from './lifecycle-engine.js';
import { ACADEMIC_DEFAULTS } from '../configuration/policy-catalog.js';
import { assertMoney, assertSeatCount } from '../../utils/money.js';

export interface GenerationParams {
  branchId: string;
  academicTermId?: string | null;
  programVersionId: string;
  offeringId?: string | null;
  levelIds?: string[];
  timeSlotIds?: string[];
  defaultCapacity?: number;
  createdBy?: string | null;
  genderPolicy?: 'female' | 'male' | 'mixed';
  splitByGender?: boolean;
}

export class ClassGenerationEngine {
  // Pre-compiled statements for maximum performance
  private stmtGetRun: Database.Statement;
  private stmtInsertRun: Database.Statement;
  private stmtGetPendingItems: Database.Statement;
  private stmtInsertItem: Database.Statement;
  private stmtUpdateItemSuccess: Database.Statement;
  private stmtUpdateItemError: Database.Statement;
  private stmtUpdateRunStatus: Database.Statement;
  private stmtGetVersion: Database.Statement;
  private stmtGetOffering: Database.Statement;
  private stmtUpdateOfferingCapacity: Database.Statement;
  private stmtGetTerm: Database.Statement;
  private stmtInsertClass: Database.Statement;

  constructor(private db: Database.Database) {
    this.stmtGetRun = db.prepare('SELECT * FROM class_generation_runs WHERE id = ?');
    this.stmtInsertRun = db.prepare(
      `INSERT INTO class_generation_runs (id, branch_id, academic_term_id, program_version_id, status, params_json, result_json, created_by, created_at)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, datetime('now'))`
    );
    this.stmtGetPendingItems = db.prepare("SELECT * FROM class_generation_items WHERE run_id = ? AND status = 'pending'");
    this.stmtInsertItem = db.prepare(
      `INSERT INTO class_generation_items (id, run_id, level_id, level_name, time_slot_id, room_id, teacher_id, capacity, min_viable_size, fee, proposed_name, status, gender_policy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    );
    this.stmtUpdateItemSuccess = db.prepare("UPDATE class_generation_items SET status = 'created', class_id = ? WHERE id = ?");
    this.stmtUpdateItemError = db.prepare("UPDATE class_generation_items SET status = 'error', error_message = ? WHERE id = ?");
    this.stmtUpdateRunStatus = db.prepare("UPDATE class_generation_runs SET status = 'published', published_at = datetime('now') WHERE id = ?");
    this.stmtGetVersion = db.prepare(
      `SELECT pv.*, p.branch_id AS program_branch_id
       FROM program_versions pv
       JOIN programs p ON p.id = pv.program_id
       WHERE pv.id = ?`
    );
    this.stmtGetOffering = db.prepare('SELECT * FROM course_offerings WHERE id = ?');
    this.stmtUpdateOfferingCapacity = db.prepare('UPDATE course_offerings SET capacity_total = (SELECT COALESCE(SUM(capacity),0) FROM classes WHERE offering_id = ?) WHERE id = ?');
    this.stmtGetTerm = db.prepare('SELECT branch_id, start_date, end_date, is_active FROM academic_terms WHERE id = ?');
    this.stmtInsertClass = db.prepare(
      `INSERT INTO classes (id, name, teacher_id, program_id, level_id, level, capacity, min_viable_size, schedule_time, start_date, end_date, status, lifecycle_stage, fee, branch_id, room_id, time_slot_id, academic_term_id, gender_policy, offering_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
  }

  preview(params: GenerationParams) {
    if (typeof params.branchId !== 'string' || !params.branchId) throw new Error('A branch is required.');
    const defaultCapacity = params.defaultCapacity === undefined
      ? 20
      : assertSeatCount(params.defaultCapacity, 'Default class capacity');
    if (params.genderPolicy !== undefined && !['female', 'male', 'mixed'].includes(params.genderPolicy)) {
      throw new Error('Generation gender policy must be female, male, or mixed.');
    }
    if (params.splitByGender !== undefined && typeof params.splitByGender !== 'boolean') {
      throw new Error('Generation splitByGender must be a boolean.');
    }
    if (params.academicTermId !== undefined && params.academicTermId !== null && typeof params.academicTermId !== 'string') {
      throw new Error('Generation academic term must be an id.');
    }
    if (params.offeringId !== undefined && params.offeringId !== null && typeof params.offeringId !== 'string') {
      throw new Error('Generation offering must be an id.');
    }
    for (const [field, values] of [['levelIds', params.levelIds], ['timeSlotIds', params.timeSlotIds]] as const) {
      if (values !== undefined && (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !value))) {
        throw new Error(`Generation ${field} must be an array of ids.`);
      }
    }
    const offering = params.offeringId ? this.stmtGetOffering.get(params.offeringId) as any : null;
    if (params.offeringId && !offering) throw new Error('Course offering not found.');
    if (offering) {
      if (String(offering.branch_id) !== String(params.branchId)) throw new Error('Course offering belongs to another branch.');
      if (!offering.level_id) throw new Error('Course offering has no curriculum level.');
      params = { ...params, programVersionId: offering.program_version_id, academicTermId: offering.academic_term_id ?? null, levelIds: [String(offering.level_id)] };
    }
    if (typeof params.programVersionId !== 'string' || !params.programVersionId) throw new Error('A program version is required.');
    const version = this.stmtGetVersion.get(params.programVersionId) as { program_branch_id: string } | undefined;
    if (!version) throw new Error('Program version not found.');
    if (String(version.program_branch_id) !== String(params.branchId)) {
      throw new Error('Program version belongs to another branch.');
    }
    if (params.academicTermId) {
      const term = this.stmtGetTerm.get(params.academicTermId) as { branch_id: string; is_active: number } | undefined;
      if (!term) throw new Error('Academic term not found.');
      if (String(term.branch_id) !== String(params.branchId)) throw new Error('Academic term belongs to another branch.');
      if (!term.is_active) throw new Error('Academic term is inactive.');
    }
    const levels = this.resolveLevels(params);
    if (levels.length === 0) throw new Error('No active levels belong to the selected program version.');
    const slots = this.resolveSlots(params.branchId, params.timeSlotIds);
    const rooms = this.db
      .prepare('SELECT * FROM rooms WHERE branch_id = ? AND is_active = 1 ORDER BY capacity DESC, name ASC')
      .all(params.branchId) as any[];
    if (offering && rooms.length === 0) throw new Error('No active physical rooms are configured for this branch. Complete Phase 1 before generating classes.');
    if (offering && slots.length === 0) throw new Error('No active time slots are configured for this branch. Complete Phase 1 before generating classes.');

    const items: any[] = [];
    const gendersPerSlot = splitGenderCount(params);
    if (offering && rooms.length < levels.length * gendersPerSlot) {
      throw new Error(`Not enough active rooms for the selected time slots. Each simultaneous class section needs a distinct room; ${levels.length * gendersPerSlot} room(s) are required per slot.`);
    }

    const genderModes: Array<'female' | 'male' | 'mixed'> = params.splitByGender
      ? ['female', 'male']
      : [params.genderPolicy === 'female' || params.genderPolicy === 'male' || params.genderPolicy === 'mixed' ? params.genderPolicy : 'mixed'];

    for (const slot of slots.length ? slots : [null]) {
      let roomIdx = 0;
      for (const level of levels) {
        for (const gender of genderModes) {
          const room = rooms[roomIdx++];
          const fee = assertMoney(
            offering ? offering.fee_snapshot ?? 0 : this.resolveFee(level, params.branchId),
            'Generated class fee',
          );
          const capacity = assertSeatCount(room?.capacity ?? defaultCapacity, 'Generated class capacity');
          if (offering && (!room || capacity <= 0)) throw new Error('Every generated class must use a physical room with a positive capacity.');
          const minViableSize = assertSeatCount(
            level.min_viable_size || ACADEMIC_DEFAULTS.levelMinViableSize,
            'Generated class minimum viable size',
          );
          if (capacity > 0 && minViableSize > capacity) {
            throw new Error('Generated class minimum viable size cannot exceed its capacity.');
          }
          const name = this.proposeName(level, slot, params, gender);
          items.push({
            levelId: level.id, levelName: level.name, timeSlotId: slot?.id ?? null, timeSlotLabel: slot?.label ?? slot?.code ?? null,
            roomId: room?.id ?? null, roomName: room?.name ?? room?.code ?? null, roomCapacity: room?.capacity ?? null, teacherId: null, capacity,
            minViableSize, fee, proposedName: name, genderPolicy: gender,
          });
        }
      }
    }

    return { items, levelCount: levels.length, slotCount: slots.length || 1 };
  }

  createDraft(params: GenerationParams) {
    if (params.offeringId) {
      const offering = this.stmtGetOffering.get(params.offeringId) as any;
      if (!offering) throw new Error('Course offering not found.');
      if (String(offering.branch_id) !== String(params.branchId)) throw new Error('Course offering belongs to another branch.');
      params = { ...params, programVersionId: offering.program_version_id, academicTermId: offering.academic_term_id ?? null, levelIds: [String(offering.level_id)] };
    }
    const preview = this.preview(params);
    const runId = makeId('cgr');

    this.db.transaction(() => {
      this.stmtInsertRun.run(
        runId, params.branchId, params.academicTermId ?? null, params.programVersionId,
        JSON.stringify(params), JSON.stringify(preview), params.createdBy ?? null
      );

      for (const item of preview.items) {
        this.stmtInsertItem.run(
          makeId('cgi'), runId, item.levelId, item.levelName, item.timeSlotId, item.roomId,
          item.teacherId, item.capacity, item.minViableSize, item.fee, item.proposedName,
          item.genderPolicy || 'mixed'
        );
      }
    })();

    return this.getRun(runId);
  }

  publish(runId: string, _actor?: string | null) {
    const run = this.stmtGetRun.get(runId) as any;
    if (!run) throw new Error('Generation run not found');
    if (run.status === 'published') throw new Error('Already published');
    if (run.status !== 'draft') throw new Error(`Cannot publish a ${run.status} generation run.`);

    const items = this.stmtGetPendingItems.all(runId) as any[];
    if (items.length === 0) return { runId, createdClassIds: [], run: this.getRun(runId) };
    for (const item of items) {
      const capacity = assertSeatCount(item.capacity, 'Generation item capacity');
      const minViableSize = assertSeatCount(item.min_viable_size, 'Generation item minimum viable size');
      if (capacity > 0 && minViableSize > capacity) {
        throw new Error('Generation item minimum viable size cannot exceed its capacity.');
      }
      assertMoney(item.fee, 'Generation item fee');
      if (!['female', 'male', 'mixed'].includes(item.gender_policy || 'mixed')) {
        throw new Error('Generation item gender policy is invalid.');
      }
      if (typeof item.proposed_name !== 'string' || !item.proposed_name.trim()) {
        throw new Error('Generation item proposed name is required.');
      }
    }
    const levelIds = [...new Set(items.map(i => i.level_id).filter(Boolean).map(String))];
    const slotIds = [...new Set(items.map(i => i.time_slot_id).filter(Boolean).map(String))];
    const roomIds = [...new Set(items.map(i => i.room_id).filter(Boolean).map(String))];
    if (items.some((item) => !item.level_id)) throw new Error('Every generation item must retain its curriculum level.');

    const version = this.stmtGetVersion.get(run.program_version_id) as any;
    if (!version) throw new Error('Generation program version is missing.');
    if (String(version.program_branch_id) !== String(run.branch_id)) {
      throw new Error('Generation program version is inconsistent with the run branch.');
    }

    const levelsMap = new Map<string, any>();
    if (levelIds.length > 0) {
      const placeholders = levelIds.map(() => '?').join(',');
      const levelRows = this.db.prepare(`SELECT * FROM levels WHERE id IN (${placeholders}) AND program_version_id = ? AND COALESCE(is_active, 1) = 1`).all(...levelIds, run.program_version_id) as any[];
      levelRows.forEach(l => levelsMap.set(l.id, l));
      if (levelsMap.size !== levelIds.length) throw new Error('Generation levels are inconsistent with the program version.');
    }

    const slotsMap = new Map<string, any>();
    if (slotIds.length > 0) {
      const placeholders = slotIds.map(() => '?').join(',');
      const slotRows = this.db.prepare(`SELECT * FROM time_slots WHERE id IN (${placeholders}) AND branch_id = ? AND is_active = 1`).all(...slotIds, run.branch_id) as any[];
      slotRows.forEach(s => slotsMap.set(s.id, s));
      if (slotsMap.size !== slotIds.length) throw new Error('Generation time slots are inconsistent with the run branch.');
    }
    const roomsMap = new Map<string, { id: string; capacity: number }>();
    if (roomIds.length > 0) {
      const placeholders = roomIds.map(() => '?').join(',');
      const rooms = this.db.prepare(`SELECT id, capacity FROM rooms WHERE id IN (${placeholders}) AND branch_id = ? AND is_active = 1`).all(...roomIds, run.branch_id) as Array<{ id: string; capacity: number }>;
      rooms.forEach(room => roomsMap.set(room.id, room));
      if (roomsMap.size !== roomIds.length) throw new Error('Generation rooms are inconsistent with the run branch.');
      for (const item of items) {
        if (!item.room_id) continue;
        const roomCapacity = assertSeatCount(roomsMap.get(item.room_id)?.capacity, 'Generation room capacity');
        if (roomCapacity > 0 && Number(item.capacity) > roomCapacity) {
          throw new Error('Generation item capacity cannot exceed its room capacity.');
        }
      }
    }
    if (run.academic_term_id) {
      const term = this.stmtGetTerm.get(run.academic_term_id) as { branch_id: string; is_active: number } | undefined;
      if (!term || String(term.branch_id) !== String(run.branch_id)) {
        throw new Error('Generation academic term is inconsistent with the run branch.');
      }
      if (!term.is_active) throw new Error('Generation academic term is inactive.');
    }

    const runParams: Record<string, unknown> = (() => {
      try {
        const parsed = run.params_json ? JSON.parse(run.params_json) : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('not an object');
        }
        return parsed as Record<string, unknown>;
      } catch (error) {
        throw new Error('Generation parameters are malformed.', { cause: error });
      }
    })();
    const offeringId = runParams.offeringId ? String(runParams.offeringId) : null;
    if (offeringId) {
      const offering = this.stmtGetOffering.get(offeringId) as any;
      const offeringLevelId = offering?.level_id ? String(offering.level_id) : null;
      const offeringTermId = offering?.academic_term_id ? String(offering.academic_term_id) : null;
      const runTermId = run.academic_term_id ? String(run.academic_term_id) : null;
      if (!offering || String(offering.branch_id) !== String(run.branch_id) ||
          String(offering.program_version_id) !== String(run.program_version_id) ||
          !offeringLevelId || levelIds.length !== 1 || levelIds[0] !== offeringLevelId ||
          offeringTermId !== runTermId) {
        throw new Error('Generation offering is missing or inconsistent with the run.');
      }
      if (items.some(item => !item.room_id || !item.time_slot_id)) {
        throw new Error('Every offering generation item must retain its room and time slot.');
      }
      if (items.some(item => Number(roomsMap.get(item.room_id)?.capacity ?? 0) <= 0)) {
        throw new Error('Every offering generation item must retain a room with positive capacity.');
      }
    }
    
    // Resolve start and end dates from Academic Term if available
    let startDate = new Date().toISOString().slice(0, 10);
    let endDate = new Date();
    endDate.setMonth(endDate.getMonth() + 3); // Default 3 months
    if (run.academic_term_id) {
      const term = this.stmtGetTerm.get(run.academic_term_id) as any;
      if (term?.start_date) startDate = term.start_date;
      if (term?.end_date) endDate = new Date(term.end_date);
    }
    const endDateStr = endDate.toISOString().slice(0, 10);

    const created: string[] = [];
    
    const tx = this.db.transaction(() => {
      for (const item of items) {
        try {
          const classId = makeId('cls');
          const level = levelsMap.get(item.level_id);
          const slot = slotsMap.get(item.time_slot_id);

          this.stmtInsertClass.run(
            classId,
            item.proposed_name,
            item.teacher_id || null, // Use null instead of empty string for better data integrity
            version?.program_id ?? level?.program_id ?? null,
            item.level_id,
            level?.name || item.level_name || 'Unknown',
            item.capacity,
            item.min_viable_size,
            slot ? `${slot.start_time}-${slot.end_time}` : null,
            startDate,
            endDateStr,
            deriveCoarseClassStatus('scheduled'),
            'scheduled',
            item.fee,
            run.branch_id,
            item.room_id,
            item.time_slot_id,
            run.academic_term_id,
            item.gender_policy || 'mixed',
            offeringId
          );

          this.stmtUpdateItemSuccess.run(classId, item.id);
          created.push(classId);
        } catch (e: any) {
          this.stmtUpdateItemError.run(String(e?.message || e), item.id);
        }
      }
      if (offeringId) this.stmtUpdateOfferingCapacity.run(offeringId, offeringId);
      this.stmtUpdateRunStatus.run(runId);
    });
    tx();

    return { runId, createdClassIds: created, run: this.getRun(runId) };
  }

  getRun(runId: string) {
    const run = this.stmtGetRun.get(runId);
    const items = this.db
      .prepare('SELECT * FROM class_generation_items WHERE run_id = ? ORDER BY level_name, proposed_name')
      .all(runId);
    return { run, items };
  }

  private resolveLevels(params: GenerationParams) {
    if (params.levelIds?.length) {
      const requestedIds = [...new Set(params.levelIds.map(String))];
      const rows = this.db
        .prepare(`SELECT * FROM levels WHERE program_version_id = ? AND id IN (SELECT value FROM json_each(?)) AND COALESCE(is_active,1)=1`)
        .all(params.programVersionId, JSON.stringify(requestedIds)) as any[];
      if (rows.length !== requestedIds.length) {
        throw new Error('Every selected level must be active and belong to the selected program version.');
      }
      return rows.sort((a, b) => (a.order || 0) - (b.order || 0));
    }
    return this.db
      .prepare(`SELECT * FROM levels WHERE program_version_id = ? AND COALESCE(is_active,1)=1 ORDER BY "order"`)
      .all(params.programVersionId) as any[];
  }

  private resolveSlots(branchId: string, slotIds?: string[]) {
    if (slotIds?.length) {
      const requestedIds = [...new Set(slotIds.map(String))];
      const rows = this.db
        .prepare(`SELECT * FROM time_slots WHERE branch_id = ? AND id IN (SELECT value FROM json_each(?)) AND is_active = 1`)
        .all(branchId, JSON.stringify(requestedIds)) as any[];
      if (rows.length !== requestedIds.length) {
        throw new Error('Every selected time slot must be active and belong to the selected branch.');
      }
      return rows.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    }
    return this.db
      .prepare(`SELECT * FROM time_slots WHERE branch_id = ? AND is_active = 1 ORDER BY sort_order, start_time`)
      .all(branchId) as any[];
  }

  private resolveFee(level: any, branchId: string): number {
    const bf = this.db
      .prepare('SELECT fee FROM level_branch_fees WHERE level_id = ? AND branch_id = ?')
      .get(level.id, branchId) as { fee: number } | undefined;
    return bf?.fee ?? level.default_fee ?? 0;
  }

  private proposeName(
    level: any,
    slot: any,
    params: GenerationParams,
    gender: 'female' | 'male' | 'mixed' = 'mixed'
  ): string {
    const slotLabel = slot?.label || slot?.code || '';
    const genderLabel = gender === 'female' ? 'Female' : gender === 'male' ? 'Male' : '';
    const parts = [level.name || level.code || 'Class', genderLabel, slotLabel].filter(Boolean);
    return parts.join(' — ');
  }
}

function splitGenderCount(params: GenerationParams): number {
  return params.splitByGender ? 2 : 1;
}

export function getClassGenerationEngine(db: Database.Database) {
  return new ClassGenerationEngine(db);
}
