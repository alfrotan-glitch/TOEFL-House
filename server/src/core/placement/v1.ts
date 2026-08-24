export const DELIVERY_MODES = ['DIGITAL', 'PHYSICAL'] as const;
export type PlacementDeliveryMode = (typeof DELIVERY_MODES)[number];

export const CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1'] as const;
export type CefrLevel = (typeof CEFR_LEVELS)[number];

export const CANONICAL_COMPONENT_KEYS = ['grammar', 'reading', 'listening', 'writing', 'speaking'] as const;
export type PlacementComponentType = (typeof CANONICAL_COMPONENT_KEYS)[number];

export interface BlueprintBucket {
  count: number;
  cefrLevel: CefrLevel | 'ANY';
  difficulty: 'easy' | 'medium' | 'hard' | 'ANY';
  qtypes: string[];
}

export interface CanonicalComponentSpec {
  key: PlacementComponentType;
  label: string;
  maxScore: number;
  selectionCount: number;
  defaultDurationMinutes: number;
  bankType: PlacementComponentType;
  allowedQtypes: readonly string[];
  scoringMode: 'objective' | 'writing' | 'speaking';
}

export const CANONICAL_COMPONENT_SPECS: Record<PlacementComponentType, CanonicalComponentSpec> = {
  grammar: {
    key: 'grammar',
    label: 'Grammar',
    maxScore: 30,
    selectionCount: 30,
    defaultDurationMinutes: 30,
    bankType: 'grammar',
    allowedQtypes: ['mcq', 'fill_blank', 'sentence_completion', 'error_identification', 'short_answer'],
    scoringMode: 'objective',
  },
  reading: {
    key: 'reading',
    label: 'Reading',
    maxScore: 20,
    selectionCount: 20,
    defaultDurationMinutes: 25,
    bankType: 'reading',
    allowedQtypes: ['mcq', 'short_answer'],
    scoringMode: 'objective',
  },
  listening: {
    key: 'listening',
    label: 'Listening',
    maxScore: 20,
    selectionCount: 20,
    defaultDurationMinutes: 25,
    bankType: 'listening',
    allowedQtypes: ['mcq', 'short_answer'],
    scoringMode: 'objective',
  },
  writing: {
    key: 'writing',
    label: 'Writing',
    maxScore: 25,
    selectionCount: 1,
    defaultDurationMinutes: 30,
    bankType: 'writing',
    allowedQtypes: ['essay'],
    scoringMode: 'writing',
  },
  speaking: {
    key: 'speaking',
    label: 'Speaking',
    maxScore: 25,
    selectionCount: 1,
    defaultDurationMinutes: 15,
    bankType: 'speaking',
    allowedQtypes: ['speaking'],
    scoringMode: 'speaking',
  },
};

export const CANONICAL_COMPONENT_WEIGHTS: Record<PlacementComponentType, number> = {
  grammar: 25,
  reading: 16.67,
  listening: 16.67,
  writing: 20.83,
  speaking: 20.83,
};

export interface PlacementDecisionRule {
  cefrLevel: CefrLevel;
  recommendedLevelId: string;
  minimumScores: Record<PlacementComponentType, number>;
  label?: string;
}

export function cefrRank(level: CefrLevel): number {
  return CEFR_LEVELS.indexOf(level);
}

export function compareCefr(left: CefrLevel, right: CefrLevel): number {
  return cefrRank(left) - cefrRank(right);
}

export function isCefrLevel(value: unknown): value is CefrLevel {
  return typeof value === 'string' && (CEFR_LEVELS as readonly string[]).includes(value);
}

export function isCanonicalComponentType(value: unknown): value is PlacementComponentType {
  return typeof value === 'string' && (CANONICAL_COMPONENT_KEYS as readonly string[]).includes(value);
}

export function isDeliveryMode(value: unknown): value is PlacementDeliveryMode {
  return typeof value === 'string' && (DELIVERY_MODES as readonly string[]).includes(value);
}

export function normalizeCefrLevel(value: unknown, field: string): CefrLevel {
  if (!isCefrLevel(value)) throw new Error(`${field} must be one of ${CEFR_LEVELS.join(', ')}.`);
  return value;
}

export function componentSpec(type: PlacementComponentType): CanonicalComponentSpec {
  return CANONICAL_COMPONENT_SPECS[type];
}

export function placementPercentageFromResults(results: Array<{ component_key: string; score: number | null; max_score: number }>): number | null {
  const scored = results.filter((result) => result.score != null);
  if (scored.length === 0) return null;
  const earned = scored.reduce((sum, result) => sum + Number(result.score || 0), 0);
  const max = scored.reduce((sum, result) => sum + Number(result.max_score || 0), 0);
  if (max <= 0) return null;
  return Math.round((earned / max) * 10000) / 100;
}
