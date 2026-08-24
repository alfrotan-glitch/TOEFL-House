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

type ComponentKey = 'grammar' | 'reading' | 'listening' | 'writing' | 'speaking';

type BlueprintBucket = {
  count: number;
  cefrLevel: 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'ANY';
  difficulty: 'easy' | 'medium' | 'hard' | 'ANY';
  qtypes: string[];
};

type CanonicalComponent = {
  key: ComponentKey;
  type: ComponentKey;
  label: string;
  required: true;
  weight: number;
  maxScore: number;
  scoringMethod: 'auto' | 'manual';
  durationMinutes: number;
  timeLimitSeconds: number;
  instructions: string | null;
  bankIds: string[];
  blueprintBuckets: BlueprintBucket[];
};

type DecisionRule = {
  cefrLevel: 'A1' | 'A2' | 'B1' | 'B2' | 'C1';
  recommendedLevelId: string;
  minimumScores: Record<ComponentKey, number>;
  label?: string;
};

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
  assets: {
    grammarBankId: string;
    readingBankId: string;
    listeningBankId: string;
    writingBankId: string;
    speakingBankId: string;
    writingRubricId: string;
    speakingRubricId: string;
  };
}

export type PlacementProfileOverrides = {
  version?: number | null;
  requirementMode?: 'required' | 'optional' | 'not_required';
  components?: CanonicalComponent[];
  componentOverrides?: Partial<Record<ComponentKey, Partial<CanonicalComponent>>>;
  decisionRules?: DecisionRule[];
  scoringModel?: 'canonical';
  allowRetake?: boolean;
  maxAttempts?: number | null;
  firstAttemptBillable?: boolean;
  retakeBillable?: boolean;
  retakeFeeAmount?: number | null;
  passScore?: number;
  firstLevelExempt?: boolean;
  expiresMinutes?: number | null;
  instructions?: string | null;
};

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

function optionSet() {
  return JSON.stringify([{ key: 'A', text: 'A' }, { key: 'B', text: 'B' }]);
}

function insertRubric(context: Wp04Context | Omit<Wp04Context, 'assets'>, id: string, title: string, kind: 'writing' | 'speaking', criterionKey: string) {
  db.prepare(`
    INSERT INTO placement_rubrics (id,title,kind,criteria_json,branch_id,created_by)
    VALUES (?,?,?,?,?,?)
  `).run(
    id,
    title,
    kind,
    JSON.stringify([{ key: criterionKey, label: title, weight: 100, maxScore: 5 }]),
    context.branchA,
    context.managerAId,
  );
}

function insertBank(
  context: Wp04Context | Omit<Wp04Context, 'assets'>,
  args: {
    id: string;
    title: string;
    testType: ComponentKey;
    questionCount: number;
    rubricId?: string | null;
    branchId?: string | null;
    durationSeconds?: number | null;
    questions?: Array<Record<string, unknown>>;
  },
) {
  db.prepare(`
    INSERT INTO placement_tests
      (id,title,test_type,instructions,status,branch_id,created_by,duration_seconds,rubric_id)
    VALUES (?,?,?,?, 'active', ?,?,?,?)
  `).run(
    args.id,
    args.title,
    args.testType,
    `${args.title} instructions`,
    args.branchId ?? context.branchA,
    context.managerAId,
    args.durationSeconds ?? null,
    args.rubricId ?? null,
  );

  const questions = args.questions ?? Array.from({ length: args.questionCount }, (_, index) => {
    if (args.testType === 'writing') {
      return { key: `essay_${index + 1}`, qtype: 'essay', prompt: 'Write an essay', points: 25 };
    }
    if (args.testType === 'speaking') {
      return { key: `speak_${index + 1}`, qtype: 'speaking', prompt: 'Speak about your day', points: 25 };
    }
    return {
      key: `q${index + 1}`,
      qtype: 'mcq',
      prompt: `Choose A ${index + 1}`,
      options: optionSet(),
      answerKey: 'A',
      points: 1,
      difficulty: 'easy',
      cefrLevel: 'A1',
    };
  });

  const insertQuestion = db.prepare(`
    INSERT INTO placement_test_questions
      (id,test_id,question_key,qtype,prompt,options_json,answer_key,points,order_index,
       difficulty,section_key,cefr_level,topic,subskill,lifecycle_status,version,created_by,approved_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'active', 1, ?, datetime('now'))
  `);

  questions.forEach((question, index) => {
    insertQuestion.run(
      `${args.id}_q_${index + 1}`,
      args.id,
      String(question.key ?? `q${index + 1}`),
      String(question.qtype ?? 'mcq'),
      String(question.prompt ?? `Question ${index + 1}`),
      question.options == null
        ? null
        : typeof question.options === 'string'
          ? question.options
          : JSON.stringify(question.options),
      question.answerKey == null ? null : String(question.answerKey),
      Number(question.points ?? 1),
      index,
      question.difficulty == null ? null : String(question.difficulty),
      question.sectionKey == null ? null : String(question.sectionKey),
      question.cefrLevel == null ? null : String(question.cefrLevel),
      question.topic == null ? null : String(question.topic),
      question.subskill == null ? null : String(question.subskill),
      context.managerAId,
    );
  });
}

function bucket(count: number, qtypes: string[]): BlueprintBucket {
  return { count, cefrLevel: 'ANY', difficulty: 'ANY', qtypes };
}

export function canonicalDecisionRules(context: Wp04Context): DecisionRule[] {
  return [
    {
      cefrLevel: 'A1',
      recommendedLevelId: context.levelA1,
      minimumScores: { grammar: 5, reading: 3, listening: 3, writing: 8, speaking: 8 },
      label: 'A1 threshold',
    },
    {
      cefrLevel: 'A2',
      recommendedLevelId: context.levelA2,
      minimumScores: { grammar: 12, reading: 8, listening: 8, writing: 12, speaking: 12 },
      label: 'A2 threshold',
    },
    {
      cefrLevel: 'B1',
      recommendedLevelId: context.levelA2,
      minimumScores: { grammar: 18, reading: 12, listening: 12, writing: 15, speaking: 15 },
      label: 'B1 threshold',
    },
    {
      cefrLevel: 'B2',
      recommendedLevelId: context.levelA2,
      minimumScores: { grammar: 24, reading: 16, listening: 16, writing: 18, speaking: 18 },
      label: 'B2 threshold',
    },
    {
      cefrLevel: 'C1',
      recommendedLevelId: context.levelA2,
      minimumScores: { grammar: 28, reading: 18, listening: 18, writing: 22, speaking: 22 },
      label: 'C1 threshold',
    },
  ];
}

export function canonicalComponents(
  context: Wp04Context,
  overrides: Partial<Record<ComponentKey, Partial<CanonicalComponent>>> = {},
): CanonicalComponent[] {
  const base: Record<ComponentKey, CanonicalComponent> = {
    grammar: {
      key: 'grammar',
      type: 'grammar',
      label: 'Grammar',
      required: true,
      weight: 25,
      maxScore: 30,
      scoringMethod: 'auto',
      durationMinutes: 30,
      timeLimitSeconds: 1800,
      instructions: 'Grammar placement section',
      bankIds: [context.assets.grammarBankId],
      blueprintBuckets: [bucket(30, ['mcq'])],
    },
    reading: {
      key: 'reading',
      type: 'reading',
      label: 'Reading',
      required: true,
      weight: 16.67,
      maxScore: 20,
      scoringMethod: 'auto',
      durationMinutes: 25,
      timeLimitSeconds: 1500,
      instructions: 'Reading placement section',
      bankIds: [context.assets.readingBankId],
      blueprintBuckets: [bucket(20, ['mcq'])],
    },
    listening: {
      key: 'listening',
      type: 'listening',
      label: 'Listening',
      required: true,
      weight: 16.67,
      maxScore: 20,
      scoringMethod: 'auto',
      durationMinutes: 25,
      timeLimitSeconds: 1500,
      instructions: 'Listening placement section',
      bankIds: [context.assets.listeningBankId],
      blueprintBuckets: [bucket(20, ['mcq'])],
    },
    writing: {
      key: 'writing',
      type: 'writing',
      label: 'Writing',
      required: true,
      weight: 20.83,
      maxScore: 25,
      scoringMethod: 'manual',
      durationMinutes: 30,
      timeLimitSeconds: 1800,
      instructions: 'Writing placement section',
      bankIds: [context.assets.writingBankId],
      blueprintBuckets: [bucket(1, ['essay'])],
    },
    speaking: {
      key: 'speaking',
      type: 'speaking',
      label: 'Speaking',
      required: true,
      weight: 20.83,
      maxScore: 25,
      scoringMethod: 'manual',
      durationMinutes: 15,
      timeLimitSeconds: 900,
      instructions: 'Speaking placement section',
      bankIds: [context.assets.speakingBankId],
      blueprintBuckets: [bucket(1, ['speaking'])],
    },
  };
  return (['grammar', 'reading', 'listening', 'writing', 'speaking'] as ComponentKey[]).map((key) => ({
    ...base[key],
    ...(overrides[key] ?? {}),
  }));
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
  db.prepare(`
    INSERT INTO fee_rules (id, branch_id, fee_type, name, amount, version, is_active)
    VALUES (?, ?, 'placement', 'Placement fee', 100, 1, 1)
  `).run(`${key}_fee_place_a`, branchA);
  db.prepare(`
    INSERT INTO fee_rules (id, branch_id, fee_type, name, amount, version, is_active)
    VALUES (?, ?, 'placement', 'Placement fee', 200, 1, 1)
  `).run(`${key}_fee_place_b`, branchB);

  const visitorId = `${key}_visitor`;
  db.prepare(`
    INSERT INTO visitors
      (id,serial_no,full_name,phone,gender,source,status,stage,branch_id,visit_date,program_version_id,placement_status)
    VALUES (?,?,?,?, 'male','walk_in','visited','placement_booking',?,date('now'),?,'not_started')
  `).run(visitorId, `${key}-SER`, `${key} Candidate`, `07${String(sequence).padStart(8, '0')}`, branchA, versionA);

  const baseContext = {
    key,
    branchA,
    branchB,
    ownerId,
    managerAId,
    managerBId,
    receptionistAId,
    financeAId,
    programA,
    versionA,
    levelA1,
    levelA2,
    programB,
    versionB,
    levelB1,
    visitorId,
    app: makeApp(),
    owner: bearerFor(ownerId),
    managerA: bearerFor(managerAId),
    managerB: bearerFor(managerBId),
    receptionistA: bearerFor(receptionistAId),
    financeA: bearerFor(financeAId),
  };

  const writingRubricId = `${key}_writing_rubric`;
  const speakingRubricId = `${key}_speaking_rubric`;
  insertRubric(baseContext, writingRubricId, 'Writing rubric', 'writing', 'content');
  insertRubric(baseContext, speakingRubricId, 'Speaking rubric', 'speaking', 'delivery');

  const assets = {
    grammarBankId: `${key}_grammar_bank`,
    readingBankId: `${key}_reading_bank`,
    listeningBankId: `${key}_listening_bank`,
    writingBankId: `${key}_writing_bank`,
    speakingBankId: `${key}_speaking_bank`,
    writingRubricId,
    speakingRubricId,
  };

  insertBank(baseContext, { id: assets.grammarBankId, title: `${key} Grammar bank`, testType: 'grammar', questionCount: 30 });
  insertBank(baseContext, { id: assets.readingBankId, title: `${key} Reading bank`, testType: 'reading', questionCount: 20 });
  insertBank(baseContext, { id: assets.listeningBankId, title: `${key} Listening bank`, testType: 'listening', questionCount: 20 });
  insertBank(baseContext, { id: assets.writingBankId, title: `${key} Writing bank`, testType: 'writing', questionCount: 1, rubricId: writingRubricId });
  insertBank(baseContext, { id: assets.speakingBankId, title: `${key} Speaking bank`, testType: 'speaking', questionCount: 1, rubricId: speakingRubricId });

  return { ...baseContext, assets };
}

export async function putProfile(
  context: Wp04Context,
  overrides: PlacementProfileOverrides = {},
  auth = context.managerA,
) {
  const current = await supertest(context.app)
    .get(`/api/academic/program-versions/${context.versionA}/placement-profile`)
    .set(auth);
  const requirementMode = overrides.requirementMode ?? 'required';
  const body = {
    version: overrides.version ?? current.body.version ?? null,
    requirementMode,
    components: requirementMode === 'not_required'
      ? []
      : (overrides.components ?? canonicalComponents(context, overrides.componentOverrides)),
    scoringModel: overrides.scoringModel ?? 'canonical',
    allowRetake: overrides.allowRetake ?? true,
    maxAttempts: overrides.maxAttempts ?? null,
    firstAttemptBillable: overrides.firstAttemptBillable ?? true,
    retakeBillable: overrides.retakeBillable ?? false,
    retakeFeeAmount: overrides.retakeFeeAmount ?? null,
    passScore: overrides.passScore ?? 60,
    firstLevelExempt: overrides.firstLevelExempt ?? false,
    expiresMinutes: overrides.expiresMinutes ?? null,
    decisionRules: overrides.decisionRules ?? canonicalDecisionRules(context),
    instructions: overrides.instructions ?? 'Canonical placement fixture',
  };
  return supertest(context.app)
    .put(`/api/academic/program-versions/${context.versionA}/placement-profile`)
    .set(auth)
    .send(body);
}

export async function putFixedFeeRule(
  context: Wp04Context,
  body: {
    feeType: 'placement' | 'registration' | 'card' | 'diploma' | 'exam' | 'book' | 'other' | 'semester' | 'retake';
    amount: number;
    programVersionId?: string | null;
    levelId?: string | null;
    isActive?: boolean;
    effectiveFrom?: string | null;
    effectiveTo?: string | null;
    name?: string;
  },
  auth = context.owner,
) {
  const existing = db.prepare(
    `SELECT id FROM fee_rules WHERE branch_id = ? AND fee_type = ? AND COALESCE(program_version_id, '') = COALESCE(?, '') AND COALESCE(level_id, '') = COALESCE(?, '') ORDER BY version DESC LIMIT 1`
  ).get(context.branchA, body.feeType, body.programVersionId ?? null, body.levelId ?? null) as { id?: string } | undefined;
  const payload = {
    branchId: context.branchA,
    feeType: body.feeType,
    amount: body.amount,
    programVersionId: body.programVersionId ?? null,
    levelId: body.levelId ?? null,
    isActive: body.isActive ?? true,
    effectiveFrom: body.effectiveFrom ?? null,
    effectiveTo: body.effectiveTo ?? null,
    name: body.name ?? `${body.feeType} fee`,
  };
  return existing?.id
    ? supertest(context.app).put(`/api/catalog/fee-rules/${existing.id}`).set(auth).send(payload)
    : supertest(context.app).post('/api/catalog/fee-rules').set(auth).send(payload);
}

export async function createActiveTest(
  context: Wp04Context,
  opts: {
    branchId?: string;
    testType?: ComponentKey;
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
      title: `${context.key} test ${randomUUID().slice(0, 4)}`,
      testType: opts.testType ?? 'listening',
      branchId: opts.branchId,
      rubricId: opts.rubricId ?? null,
      durationSeconds: opts.durationSeconds ?? null,
      sections: [],
      questions: (opts.questions ?? [
        {
          key: 'q1',
          qtype: 'mcq',
          prompt: 'Choose A',
          options: [{ key: 'A', text: 'A' }, { key: 'B', text: 'B' }],
          answerKey: 'A',
          points: 1,
          difficulty: 'easy',
          cefrLevel: 'A1',
        },
      ]).map((question) => ({
        lifecycleStatus: 'active',
        ...question,
      })),
    });
  if (created.status !== 201) throw new Error(`Unable to create test fixture: ${created.status} ${JSON.stringify(created.body)}`);
  const activated = await supertest(context.app)
    .post(`/api/placement/test-bank/${created.body.id}/activate`)
    .set(auth)
    .send({ version: created.body.version });
  if (activated.status !== 200) throw new Error(`Unable to activate test fixture: ${activated.status} ${JSON.stringify(activated.body)}`);
  return { id: created.body.id as string, version: activated.body.version as number };
}

export function ensureLinkedStudent(context: Wp04Context): string {
  const existing = db.prepare('SELECT id FROM students WHERE lead_id = ? LIMIT 1').get(context.visitorId) as { id: string } | undefined;
  if (existing?.id) return existing.id;
  const studentId = `${context.key}_placement_student`;
  const unique = randomUUID().replace(/-/g, '').slice(0, 12);
  const numericSeed = BigInt(`0x${randomUUID().replace(/-/g, '')}`).toString();
  const phone = `07${numericSeed.padStart(8, '0').slice(-8)}`;
  db.prepare(`
    INSERT INTO students (id, student_code, full_name, phone, qr_code, status, registration_date, branch_id, discount_percent, lead_id, gender)
    VALUES (?, ?, ?, ?, ?, 'active', date('now'), ?, 0, ?, 'male')
  `).run(
    studentId,
    `PL-${unique}`,
    `${context.key} Placement Student`,
    phone,
    `${context.key}-placement-student`,
    context.branchA,
    context.visitorId,
  );
  return studentId;
}

export async function startAttempt(
  context: Wp04Context,
  auth = context.receptionistA,
  body: Record<string, unknown> = { deliveryMode: 'PHYSICAL' },
) {
  ensureLinkedStudent(context);
  return supertest(context.app)
    .post(`/api/placement/visitors/${context.visitorId}/placement/attempts`)
    .set(auth)
    .send(body);
}

export function attemptSnapshot(attemptId: string) {
  const row = db.prepare('SELECT snapshot_json FROM placement_assessment_attempts WHERE id=?').get(attemptId) as any;
  return JSON.parse(String(row.snapshot_json));
}

export function componentTest(attemptId: string, componentKey: ComponentKey) {
  const snapshot = attemptSnapshot(attemptId);
  return snapshot.tests.find((test: any) => test.component_key === componentKey);
}

export async function startTimer(context: Wp04Context, attemptId: string, componentKey: ComponentKey, auth = context.receptionistA) {
  return supertest(context.app)
    .put(`/api/placement/visitors/${context.visitorId}/placement/attempts/${attemptId}/tests/${componentKey}/start`)
    .set(auth)
    .send({});
}

export async function enterManualScore(
  context: Wp04Context,
  attemptId: string,
  componentKey: ComponentKey,
  body: Record<string, unknown>,
  auth = context.receptionistA,
) {
  return supertest(context.app)
    .put(`/api/placement/visitors/${context.visitorId}/placement/attempts/${attemptId}/components/${componentKey}`)
    .set(auth)
    .send(body);
}

export async function submitDigitalAnswers(
  context: Wp04Context,
  attemptId: string,
  componentKey: ComponentKey,
  answers: Array<{ questionKey: string; response: unknown }>,
  auth = context.receptionistA,
) {
  return supertest(context.app)
    .put(`/api/placement/visitors/${context.visitorId}/placement/attempts/${attemptId}/tests/${componentKey}/responses`)
    .set(auth)
    .send({ answers });
}

export async function scoreAndComplete(
  context: Wp04Context,
  attemptId: string,
  scores: number | Partial<Record<ComponentKey, number>>,
  auth = context.receptionistA,
) {
  const resolved: Record<ComponentKey, number> = {
    grammar: typeof scores === 'number' ? Math.min(scores, 30) : (scores.grammar ?? 30),
    reading: typeof scores === 'number' ? Math.min(scores, 20) : (scores.reading ?? 20),
    listening: typeof scores === 'number' ? Math.min(scores, 20) : (scores.listening ?? 20),
    writing: typeof scores === 'number' ? Math.min(scores, 25) : (scores.writing ?? 25),
    speaking: typeof scores === 'number' ? Math.min(scores, 25) : (scores.speaking ?? 25),
  };

  const scored: Record<ComponentKey, supertest.Response> = {} as Record<ComponentKey, supertest.Response>;
  for (const key of ['grammar', 'reading', 'listening', 'writing', 'speaking'] as ComponentKey[]) {
    await startTimer(context, attemptId, key, auth);
    scored[key] = await enterManualScore(context, attemptId, key, { score: resolved[key] }, auth);
  }
  const completed = await supertest(context.app)
    .post(`/api/placement/visitors/${context.visitorId}/placement/attempts/${attemptId}/complete`)
    .set(auth)
    .send({});
  return { scored, completed };
}
