import { HttpError } from '../../middleware/errorHandler.js';
import {
  type BlueprintBucket,
  type PlacementComponentType,
  type PlacementDeliveryMode,
  CANONICAL_COMPONENT_SPECS,
  componentSpec,
} from './v1.js';

interface QuestionRow {
  id: string;
  question_key: string;
  qtype: string;
  prompt: string;
  options_json: string | null;
  answer_key: string | null;
  points: number;
  order_index: number;
  difficulty: string | null;
  section_key: string | null;
  cefr_level: string | null;
  topic: string | null;
  subskill: string | null;
  lifecycle_status: string;
  version: number;
}

interface SectionRow {
  id: string;
  section_key: string;
  title: string | null;
  kind: string;
  audio_url: string | null;
  transcript: string | null;
  body: string | null;
  duration_seconds: number | null;
  order_index: number;
}

interface BankRow {
  id: string;
  title: string;
  test_type: string;
  instructions: string | null;
  audio_url: string | null;
  transcript: string | null;
  passage: string | null;
  status: string;
  branch_id: string | null;
  difficulty: string | null;
  duration_seconds: number | null;
  version: number;
  rubric_id: string | null;
  word_target: number | null;
  sections: SectionRow[];
  questions: QuestionRow[];
  rubric: { id: string; title: string; kind: string; version: number; criteria: unknown[] } | null;
}

export interface BlueprintComponent {
  key: string;
  type: PlacementComponentType;
  label: string;
  required: boolean;
  weight: number;
  maxScore: number;
  durationMinutes?: number;
  timeLimitSeconds?: number | null;
  instructions?: string | null;
  bankIds: string[];
  blueprintBuckets: BlueprintBucket[];
  testId?: string;
}

export interface SnapshotTest {
  id: string;
  component_key: string;
  source_bank_ids: string[];
  title: string;
  test_type: PlacementComponentType;
  instructions: string | null;
  version: number;
  duration_seconds: number | null;
  rubric: BankRow['rubric'];
  sections: Array<{
    id: string;
    source_test_id: string;
    key: string;
    title: string | null;
    kind: string;
    audio_url: string | null;
    transcript: string | null;
    body: string | null;
    duration_seconds: number | null;
    order_index: number;
  }>;
  questions: Array<{
    id: string;
    source_test_id: string;
    source_question_id: string;
    question_key: string;
    qtype: string;
    prompt: string;
    options_json: string | null;
    answer_key: string | null;
    points: number;
    order_index: number;
    difficulty: string | null;
    section_key: string | null;
    cefr_level: string | null;
    topic: string | null;
    subskill: string | null;
    version: number;
  }>;
}

function hash32(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function shuffleWithSeed<T>(rows: T[], seed: string): T[] {
  const items = [...rows];
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = hash32(`${seed}:${index}`) % (index + 1);
    const current = items[index];
    items[index] = items[swapIndex];
    items[swapIndex] = current;
  }
  return items;
}

function matchesBucket(question: QuestionRow, bucket: BlueprintBucket): boolean {
  if (question.lifecycle_status !== 'active') return false;
  if (bucket.cefrLevel !== 'ANY' && String(question.cefr_level || '') !== bucket.cefrLevel) return false;
  if (bucket.difficulty !== 'ANY' && String(question.difficulty || '') !== bucket.difficulty) return false;
  if (bucket.qtypes.length > 0 && !bucket.qtypes.includes(question.qtype)) return false;
  return true;
}

function normalizeObjectivePoint(question: QuestionRow, component: BlueprintComponent): number {
  if (component.type === 'grammar' || component.type === 'reading' || component.type === 'listening') {
    if (Number(question.points) !== 1) {
      throw new HttpError(409, `Active ${component.label} bank question "${question.question_key}" must be worth exactly 1 point.`);
    }
  }
  return Number(question.points || 0);
}

function buildSyntheticTitle(component: BlueprintComponent, banks: BankRow[], deliveryMode: PlacementDeliveryMode): string {
  const names = banks.map((bank) => bank.title).slice(0, 2).join(', ');
  return `${component.label} (${deliveryMode})${names ? ` — ${names}` : ''}`;
}

export function assembleComponentSnapshot(opts: {
  attemptId: string;
  deliveryMode: PlacementDeliveryMode;
  component: BlueprintComponent;
  banks: BankRow[];
}): { component: BlueprintComponent; test: SnapshotTest } {
  const { attemptId, deliveryMode, component, banks } = opts;
  if (banks.length === 0) throw new HttpError(409, `${component.label} has no active banks configured.`);

  const spec = componentSpec(component.type);
  const allQuestions = banks.flatMap((bank) =>
    bank.questions.map((question) => ({ bank, question }))
  );
  const selected: Array<{ bank: BankRow; question: QuestionRow }> = [];
  const usedSourceQuestionIds = new Set<string>();

  for (const bucket of component.blueprintBuckets) {
    if (bucket.count < 1) continue;
    const candidates = shuffleWithSeed(
      allQuestions.filter(({ bank, question }) => {
        if (usedSourceQuestionIds.has(question.id)) return false;
        if (bank.status !== 'active' || bank.test_type !== component.type) return false;
        return matchesBucket(question, bucket);
      }),
      `${attemptId}:${component.key}:${bucket.cefrLevel}:${bucket.difficulty}:${bucket.qtypes.join(',')}`,
    );
    if (candidates.length < bucket.count) {
      throw new HttpError(409, `${component.label} blueprint bucket cannot be satisfied from approved active assets.`);
    }
    for (const candidate of candidates.slice(0, bucket.count)) {
      normalizeObjectivePoint(candidate.question, component);
      usedSourceQuestionIds.add(candidate.question.id);
      selected.push(candidate);
    }
  }

  const expectedCount = spec.selectionCount;
  if (selected.length !== expectedCount) {
    throw new HttpError(409, `${component.label} blueprint assembled ${selected.length} item(s); ${expectedCount} required.`);
  }

  const selectedQuestions = selected.map(({ bank, question }, index) => ({
    id: `${component.key}:${question.id}`,
    source_test_id: bank.id,
    source_question_id: question.id,
    question_key: `${component.key}_${index + 1}`,
    qtype: question.qtype,
    prompt: question.prompt,
    options_json: question.options_json,
    answer_key: question.answer_key,
    points: Number(question.points || 0),
    order_index: index,
    difficulty: question.difficulty,
    section_key: question.section_key,
    cefr_level: question.cefr_level,
    topic: question.topic,
    subskill: question.subskill,
    version: Number(question.version || 1),
  }));

  const selectedSectionKeys = new Set(selectedQuestions.map((question) => question.section_key).filter(Boolean));
  const sectionRows = banks.flatMap((bank) =>
    bank.sections
      .filter((section) => selectedSectionKeys.has(section.section_key))
      .map((section) => ({
        id: `${component.key}:${section.id}`,
        source_test_id: bank.id,
        key: section.section_key,
        title: section.title,
        kind: section.kind,
        audio_url: section.audio_url,
        transcript: section.transcript,
        body: section.body,
        duration_seconds: section.duration_seconds,
        order_index: section.order_index,
      }))
  );

  const rubric = component.type === 'writing' || component.type === 'speaking'
    ? selected[0]?.bank.rubric ?? null
    : null;

  const snapshotTestId = `snapshot:${attemptId}:${component.key}`;
  return {
    component: { ...component, testId: snapshotTestId },
    test: {
      id: snapshotTestId,
      component_key: component.key,
      source_bank_ids: banks.map((bank) => bank.id),
      title: buildSyntheticTitle(component, banks, deliveryMode),
      test_type: component.type,
      instructions: component.instructions ?? banks[0]?.instructions ?? null,
      version: 1,
      duration_seconds: component.timeLimitSeconds ?? (component.durationMinutes != null ? Math.round(component.durationMinutes * 60) : null),
      rubric,
      sections: sectionRows,
      questions: selectedQuestions,
    },
  };
}

export function assertBlueprintComponentShape(component: BlueprintComponent): void {
  const spec = CANONICAL_COMPONENT_SPECS[component.type];
  if (!spec) throw new HttpError(400, `Unsupported component type ${component.type}.`);
  if (!Array.isArray(component.bankIds) || component.bankIds.length === 0) {
    throw new HttpError(400, `${component.label} requires at least one active bank.`);
  }
  if (!Array.isArray(component.blueprintBuckets) || component.blueprintBuckets.length === 0) {
    throw new HttpError(400, `${component.label} requires blueprint buckets.`);
  }
  let total = 0;
  for (const bucket of component.blueprintBuckets) {
    if (!bucket || typeof bucket !== 'object') throw new HttpError(400, `${component.label} blueprint bucket is invalid.`);
    if (!Number.isSafeInteger(bucket.count) || bucket.count < 1) throw new HttpError(400, `${component.label} blueprint bucket count must be a positive integer.`);
    if (bucket.cefrLevel !== 'ANY' && !['A1', 'A2', 'B1', 'B2', 'C1'].includes(String(bucket.cefrLevel))) {
      throw new HttpError(400, `${component.label} blueprint bucket CEFR must be A1/A2/B1/B2/C1 or ANY.`);
    }
    if (bucket.difficulty !== 'ANY' && !['easy', 'medium', 'hard'].includes(String(bucket.difficulty))) {
      throw new HttpError(400, `${component.label} blueprint bucket difficulty must be easy/medium/hard or ANY.`);
    }
    if (!Array.isArray(bucket.qtypes) || bucket.qtypes.length === 0 || bucket.qtypes.some((qtype) => !spec.allowedQtypes.includes(qtype))) {
      throw new HttpError(400, `${component.label} blueprint bucket must declare valid question types.`);
    }
    total += bucket.count;
  }
  if (total !== spec.selectionCount) {
    throw new HttpError(400, `${component.label} blueprint buckets must total ${spec.selectionCount} item(s).`);
  }
}
