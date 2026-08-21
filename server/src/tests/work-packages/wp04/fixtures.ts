import { randomUUID } from 'node:crypto';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../../../db/connection.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { authenticate } from '../../../middleware/auth.js';
import placementRouter from '../../../routes/placement.routes.js';
import { academicRouter } from '../../../routes/academic.routes.js';
import { catalogRouter } from '../../../routes/catalog.routes.js';
import { visitorsRouter } from '../../../routes/visitors.routes.js';
import { studentsRouter } from '../../../routes/students.routes.js';
import { bearerFor, seedUser } from '../../support/identity.js';

export interface Wp04Context {
  key: string;
  branchA: string;
  branchB: string;
  ownerId: string;
  managerAId: string;
  managerBId: string;
  receptionistAId: string;
  financeAId: string;
  programA: string;
  versionA: string;
  levelA1: string;
  levelA2: string;
  programB: string;
  versionB: string;
  levelB1: string;
  visitorId: string;
  app: express.Express;
  owner: { Authorization: string };
  managerA: { Authorization: string };
  managerB: { Authorization: string };
  receptionistA: { Authorization: string };
  financeA: { Authorization: string };
}

let sequence = 0;
function nextKey() {
  sequence += 1;
  return `w4_${process.pid}_${sequence}_${randomUUID().slice(0, 6)}`;
}

export function makeApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/placement', placementRouter);
  app.use('/api/academic', authenticate, academicRouter);
  app.use('/api/catalog', authenticate, catalogRouter);
  app.use('/api/visitors', authenticate, visitorsRouter);
  app.use('/api/students', authenticate, studentsRouter);
  app.use(errorHandler);
  return app;
}

export function seedContext(): Wp04Context {
  initSchema();
  const key = nextKey();
  const branchA = `${key}_ba`;
  const branchB = `${key}_bb`;
  db.prepare("INSERT INTO branches (id,name,location) VALUES (?,?, 'A')").run(branchA, `${key} A`);
  db.prepare("INSERT INTO branches (id,name,location) VALUES (?,?, 'B')").run(branchB, `${key} B`);

  const ownerId = `${key}_owner`;
  const managerAId = `${key}_ma`;
  const managerBId = `${key}_mb`;
  const receptionistAId = `${key}_ra`;
  const financeAId = `${key}_fa`;
  seedUser({ id: ownerId, role: 'owner', branchId: branchA, username: ownerId });
  seedUser({ id: managerAId, role: 'general_manager', branchId: branchA, username: managerAId });
  seedUser({ id: managerBId, role: 'general_manager', branchId: branchB, username: managerBId });
  seedUser({ id: receptionistAId, role: 'receptionist', branchId: branchA, username: receptionistAId });
  seedUser({ id: financeAId, role: 'finance_manager', branchId: branchA, username: financeAId });

  const programA = `${key}_pa`;
  const versionA = `${key}_pva`;
  const levelA1 = `${key}_a1`;
  const levelA2 = `${key}_a2`;
  const programB = `${key}_pb`;
  const versionB = `${key}_pvb`;
  const levelB1 = `${key}_b1`;
  db.prepare("INSERT INTO programs (id,name,branch_id) VALUES (?,?,?)").run(programA, `${key} Program A`, branchA);
  db.prepare("INSERT INTO program_versions (id,program_id,version_label,status) VALUES (?,?,?,'published')").run(versionA, programA, 'v1');
  db.prepare('INSERT INTO levels (id,program_id,program_version_id,name,code,"order",is_active) VALUES (?,?,?,?,?,1,1)').run(levelA1, programA, versionA, 'A1', 'A1');
  db.prepare('INSERT INTO levels (id,program_id,program_version_id,name,code,"order",is_active) VALUES (?,?,?,?,?,2,1)').run(levelA2, programA, versionA, 'A2', 'A2');
  db.prepare("INSERT INTO programs (id,name,branch_id) VALUES (?,?,?)").run(programB, `${key} Program B`, branchB);
  db.prepare("INSERT INTO program_versions (id,program_id,version_label,status) VALUES (?,?,?,'published')").run(versionB, programB, 'v1');
  db.prepare('INSERT INTO levels (id,program_id,program_version_id,name,code,"order",is_active) VALUES (?,?,?,?,?,1,1)').run(levelB1, programB, versionB, 'B1', 'B1');
  db.prepare('INSERT INTO branch_academic_profiles (branch_id,placement_test_fee) VALUES (?,100)').run(branchA);
  db.prepare('INSERT INTO branch_academic_profiles (branch_id,placement_test_fee) VALUES (?,200)').run(branchB);

  const visitorId = `${key}_visitor`;
  db.prepare(`
    INSERT INTO visitors
      (id,serial_no,full_name,phone,gender,source,status,stage,branch_id,visit_date,program_version_id,placement_status)
    VALUES (?,?,?,?, 'male','walk_in','visited','placement_booking',?,date('now'),?,'not_started')
  `).run(visitorId, `${key}-SER`, `${key} Candidate`, `07${String(sequence).padStart(8, '0')}`, branchA, versionA);

  return {
    key, branchA, branchB, ownerId, managerAId, managerBId, receptionistAId, financeAId,
    programA, versionA, levelA1, levelA2, programB, versionB, levelB1, visitorId,
    app: makeApp(),
    owner: bearerFor(ownerId),
    managerA: bearerFor(managerAId),
    managerB: bearerFor(managerBId),
    receptionistA: bearerFor(receptionistAId),
    financeA: bearerFor(financeAId),
  };
}

export function scoreComponent(overrides: Record<string, unknown> = {}) {
  return {
    key: 'main',
    type: 'custom_score',
    label: 'Placement score',
    required: true,
    weight: 100,
    maxScore: 100,
    scoringMethod: 'manual',
    ...overrides,
  };
}

export async function putProfile(
  context: Wp04Context,
  overrides: Record<string, unknown> = {},
  auth = context.managerA,
) {
  const current = await supertest(context.app)
    .get(`/api/academic/program-versions/${context.versionA}/placement-profile`)
    .set(auth);
  const requirementMode = String(overrides.requirementMode ?? 'required');
  const body = {
    version: current.body.version ?? null,
    requirementMode,
    components: requirementMode === 'not_required' ? [] : [scoreComponent()],
    scoringModel: 'weighted_average',
    allowRetake: true,
    maxAttempts: null,
    firstAttemptBillable: true,
    retakeBillable: false,
    retakeFeeAmount: null,
    passScore: 60,
    firstLevelExempt: false,
    expiresMinutes: null,
    decisionRules: [],
    instructions: 'Canonical placement fixture',
    ...overrides,
  };
  return supertest(context.app)
    .put(`/api/academic/program-versions/${context.versionA}/placement-profile`)
    .set(auth)
    .send(body);
}

export async function createActiveTest(
  context: Wp04Context,
  opts: {
    branchId?: string;
    testType?: 'listening' | 'reading' | 'writing' | 'speaking';
    questions?: any[];
    rubricId?: string | null;
    durationSeconds?: number | null;
  } = {},
  auth = context.managerA,
) {
  const created = await supertest(context.app)
    .post('/api/placement/test-bank')
    .set(auth)
    .send({
      title: `${context.key} test`,
      testType: opts.testType ?? 'listening',
      branchId: opts.branchId,
      rubricId: opts.rubricId ?? null,
      durationSeconds: opts.durationSeconds ?? null,
      sections: [],
      questions: opts.questions ?? [
        { key: 'q1', qtype: 'mcq', prompt: 'Choose A', options: [{ key: 'A', text: 'A' }, { key: 'B', text: 'B' }], answerKey: 'A', points: 10 },
      ],
    });
  if (created.status !== 201) throw new Error(`Unable to create test fixture: ${created.status} ${JSON.stringify(created.body)}`);
  const activated = await supertest(context.app)
    .post(`/api/placement/test-bank/${created.body.id}/activate`)
    .set(auth)
    .send({ version: created.body.version });
  if (activated.status !== 200) throw new Error(`Unable to activate test fixture: ${activated.status} ${JSON.stringify(activated.body)}`);
  return { id: created.body.id as string, version: activated.body.version as number };
}

export async function startAttempt(context: Wp04Context, auth = context.receptionistA) {
  return supertest(context.app)
    .post(`/api/placement/visitors/${context.visitorId}/placement/attempts`)
    .set(auth)
    .send({});
}

export async function scoreAndComplete(context: Wp04Context, attemptId: string, score: number, auth = context.receptionistA) {
  const scored = await supertest(context.app)
    .put(`/api/placement/visitors/${context.visitorId}/placement/attempts/${attemptId}/components/main`)
    .set(auth)
    .send({ score });
  const completed = await supertest(context.app)
    .post(`/api/placement/visitors/${context.visitorId}/placement/attempts/${attemptId}/complete`)
    .set(auth)
    .send({});
  return { scored, completed };
}
