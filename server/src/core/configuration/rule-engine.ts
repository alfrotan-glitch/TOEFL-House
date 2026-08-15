/**
 * TOEFL House ERP — Rule Engine & Configuration Center
 * Optimized with top-level Prepared Statements for maximum performance.
 */
import { db } from '../../db/connection.js';
import { id } from '../../utils/ids.js';
import { DEFAULT_RULE_CATALOG } from './policy-catalog.js';

export type RuleCategory = 'fee' | 'discount' | 'promotion' | 'attendance' | 'payroll' | 'scholarship' | 'workflow' | 'notification' | 'finance' | 'academic';
export type RuleOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'not_in' | 'contains' | 'between';

export interface RuleCondition {
  field: string;
  operator: RuleOperator;
  value: number | string | boolean | Array<number | string>;
  rangeValue?: [number, number];
}

export interface RuleAction {
  type: 'set_value' | 'add_discount' | 'block' | 'warn' | 'notify' | 'trigger_event' | 'calculate';
  targetKey: string;
  value?: number | string | boolean;
  formula?: string;
  message?: string;
  channel?: 'sms' | 'email' | 'whatsapp' | 'internal' | 'push';
  eventName?: string;
}

interface RuleDefinitionRow {
  id: string; name: string; description: string; category: string;
  conditions: string; actions: string; priority: number; is_active: number;
  scope_branch_id: string | null; version: number; last_modified_by: string;
  last_modified_at: string; created_at: string;
}

export interface RuleDefinition {
  id: string;
  name: string;
  description: string;
  category: RuleCategory;
  conditions: RuleCondition[];
  actions: RuleAction[];
  priority: number;
  isActive: boolean;
  scopeBranchId: string | null;
  version: number;
  lastModifiedBy: string;
  lastModifiedAt: string;
  createdAt: string;
}

export interface RuleContext {
  category: RuleCategory;
  branchId: string;
  data: Record<string, unknown>;
  dryRun?: boolean;
}

export interface RuleEngineResult {
  category: RuleCategory;
  branchId: string;
  finalOutputs: Record<string, number | string | boolean>;
  isBlocked: boolean;
  blockReason?: string;
  warnings: string[];
  totalExecutionTimeMs: number;
}

// ── Performance Optimization: Top-Level Prepared Statements ────────────────
const stmtGetActiveRules = db.prepare(
  `SELECT * FROM rule_definitions WHERE category = ? AND is_active = 1 AND (scope_branch_id IS NULL OR scope_branch_id = ?) ORDER BY priority DESC, created_at ASC`
);
const stmtGetAllRulesByCategory = db.prepare(
  `SELECT * FROM rule_definitions WHERE category = ? ORDER BY priority DESC, created_at ASC`
);
const stmtInsertRuleLog = db.prepare(
  `INSERT INTO rule_evaluation_logs (id, rule_id, category, branch_id, matched, context_json, result_json, dry_run) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
);
const stmtInsertRule = db.prepare(
  `INSERT INTO rule_definitions (id, name, description, category, conditions, actions, priority, is_active, scope_branch_id, version, last_modified_by, last_modified_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
);
const stmtUpdateRule = db.prepare(
  `UPDATE rule_definitions SET name = ?, description = ?, conditions = ?, actions = ?, priority = ?, is_active = ?, scope_branch_id = ?, version = ?, last_modified_by = ?, last_modified_at = ? WHERE id = ?`
);
const stmtGetRuleById = db.prepare('SELECT * FROM rule_definitions WHERE id = ?');
const stmtDeactivateRule = db.prepare('UPDATE rule_definitions SET is_active = 0, last_modified_by = ?, last_modified_at = ? WHERE id = ?');
const stmtDeleteRule = db.prepare('DELETE FROM rule_definitions WHERE id = ?');
const stmtGetRuleVersions = db.prepare('SELECT * FROM rule_versions WHERE rule_id = ? ORDER BY version DESC');
const stmtGetVersionByNum = db.prepare('SELECT * FROM rule_versions WHERE rule_id = ? AND version = ?');
const stmtInsertRuleVersion = db.prepare(
  `INSERT OR REPLACE INTO rule_versions (id, rule_id, version, conditions, actions, priority, is_active, modified_by, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
);
const stmtInsertSeedRule = db.prepare(
  `INSERT INTO rule_definitions (id, name, description, category, conditions, actions, priority, is_active, scope_branch_id, version, last_modified_by, last_modified_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, 1, 'system', datetime('now'), datetime('now'))`
);

// ── Safe Arithmetic Parser ─────────────────────────────────────────────────
interface ParseState { input: string; pos: number; vars: Record<string, number>; }
function skipWhitespace(s: ParseState): void { while (s.pos < s.input.length && /\s/.test(s.input[s.pos])) s.pos++; }
function parseAddSub(s: ParseState): number {
  let left = parseMulDiv(s); skipWhitespace(s);
  while (s.pos < s.input.length && (s.input[s.pos] === '+' || s.input[s.pos] === '-')) {
    const op = s.input[s.pos++]; const right = parseMulDiv(s);
    left = op === '+' ? left + right : left - right; skipWhitespace(s);
  } return left;
}
function parseMulDiv(s: ParseState): number {
  let left = parseUnary(s); skipWhitespace(s);
  while (s.pos < s.input.length && '*%/'.includes(s.input[s.pos])) {
    const op = s.input[s.pos++]; const right = parseUnary(s);
    if (op === '*') left *= right; else if (op === '/') left = right !== 0 ? left / right : 0; else left = right !== 0 ? left % right : 0;
    skipWhitespace(s);
  } return left;
}
function parseUnary(s: ParseState): number {
  skipWhitespace(s);
  if (s.pos < s.input.length && s.input[s.pos] === '-') { s.pos++; return -parseUnary(s); }
  if (s.pos < s.input.length && s.input[s.pos] === '+') { s.pos++; return parseUnary(s); }
  return parsePrimary(s);
}
function parsePrimary(s: ParseState): number {
  skipWhitespace(s); const ch = s.input[s.pos];
  if (ch === '(') { s.pos++; const result = parseAddSub(s); skipWhitespace(s); if (s.input[s.pos] !== ')') throw new Error('Expected )'); s.pos++; return result; }
  if (ch !== undefined && /[0-9.]/.test(ch)) { let numStr = ''; while (s.pos < s.input.length && /[0-9.]/.test(s.input[s.pos])) numStr += s.input[s.pos++]; const num = parseFloat(numStr); if (isNaN(num)) throw new Error(`Invalid number: ${numStr}`); return num; }
  if (ch !== undefined && /[a-zA-Z_]/.test(ch)) { let name = ''; while (s.pos < s.input.length && /[a-zA-Z0-9_]/.test(s.input[s.pos])) name += s.input[s.pos++]; if (!(name in s.vars)) throw new Error(`Unknown variable: ${name}`); return s.vars[name]; }
  throw new Error(`Unexpected character: ${ch ?? 'end of input'}`);
}
function evaluateFormula(formula: string, data: Record<string, unknown>): number {
  try {
    const vars: Record<string, number> = {};
    for (const [k, v] of Object.entries(data)) if (typeof v === 'number') vars[k] = v;
    const state: ParseState = { input: formula, pos: 0, vars };
    const result = parseAddSub(state); skipWhitespace(state);
    if (state.pos < state.input.length) throw new Error(`Unexpected character at position ${state.pos}`);
    return Number.isFinite(result) ? result : 0;
  } catch { return 0; }
}

// ── Core Evaluation Logic ──────────────────────────────────────────────────
function resolveFieldPath(path: string, data: Record<string, unknown>): unknown {
  const segments = path.split('.'); let current: unknown = data;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  } return current;
}

function evaluateCondition(condition: RuleCondition, data: Record<string, unknown>): boolean {
  const fieldValue = resolveFieldPath(condition.field, data);
  const { operator, value, rangeValue } = condition;
  
  switch (operator) {
    case 'eq': return fieldValue === value;
    case 'neq': return fieldValue !== value;
    case 'gt': return typeof fieldValue === 'number' && fieldValue > (value as number);
    case 'gte': return typeof fieldValue === 'number' && fieldValue >= (value as number);
    case 'lt': return typeof fieldValue === 'number' && fieldValue < (value as number);
    case 'lte': return typeof fieldValue === 'number' && fieldValue <= (value as number);
    case 'in': return Array.isArray(value) && value.includes(fieldValue as never);
    case 'not_in': return Array.isArray(value) && !value.includes(fieldValue as never);
    case 'contains': return typeof fieldValue === 'string' && typeof value === 'string' && fieldValue.includes(value);
    case 'between': {
      if (typeof fieldValue !== 'number' || !rangeValue) return false;
      const [min, max] = rangeValue;
      return fieldValue >= min && fieldValue <= max;
    }
    default: return false;
  }
}

export function evaluateRules(context: RuleContext): RuleEngineResult {
  const startTime = performance.now();
  const { category, branchId, dryRun = false } = context;
  const rows = stmtGetActiveRules.all(category, branchId) as RuleDefinitionRow[];

  const finalOutputs: Record<string, number | string | boolean> = {};
  const warnings: string[] = [];
  let isBlocked = false; 
  let blockReason: string | undefined;
  let blockingRuleId: string | undefined;
  
  const runningData: RuleContext['data'] = { ...context.data };

  for (const row of rows) {
    let conditions: RuleCondition[]; 
    let actions: RuleAction[];
    try { 
      conditions = JSON.parse(row.conditions); 
      actions = JSON.parse(row.actions); 
    } catch { 
      continue; // Skip malformed rules
    }

    const matched = conditions.length === 0 || conditions.every(c => evaluateCondition(c, runningData));

    if (matched) {
      let ruleCausedBlock = false;
      
      for (const action of actions) {
        const outputs: Record<string, number | string | boolean> = {};
        switch (action.type) {
          case 'set_value': 
            if (action.value !== undefined) outputs[action.targetKey] = action.value; 
            break;
          case 'add_discount': {
            const cur = (runningData['discountPercent'] as number) ?? 0; 
            const add = typeof action.value === 'number' ? action.value : 0; 
            outputs['discountPercent'] = Math.min(100, cur + add); 
            break;
          }
          case 'calculate': 
            if (action.formula) outputs[action.targetKey] = evaluateFormula(action.formula, runningData); 
            break;
          case 'block': 
            outputs['__blocked'] = true; 
            outputs['__blockReason'] = action.message ?? 'Operation blocked by business rule.'; 
            break;
          case 'warn': 
            outputs['__warning'] = action.message ?? 'System warning'; 
            break;
          case 'notify': 
            if (!dryRun) outputs[`__notify_${action.channel ?? 'internal'}`] = action.message ?? ''; 
            break;
          case 'trigger_event': 
            if (!dryRun && action.eventName) outputs[`__event_${action.eventName}`] = true; 
            break;
        }

        if (outputs['__blocked'] === true) { 
          isBlocked = true; 
          blockReason = outputs['__blockReason'] as string;
          blockingRuleId = row.id;
          ruleCausedBlock = true;
        }
        if (typeof outputs['__warning'] === 'string') warnings.push(outputs['__warning']);

        for (const [key, val] of Object.entries(outputs)) {
          if (!key.startsWith('__')) { 
            finalOutputs[key] = val; 
            runningData[key] = val; 
          }
        }
        if (ruleCausedBlock) break;
      }
    }
    if (matched && !dryRun) {
      try {
        stmtInsertRuleLog.run(
          id('rel'), row.id, category, branchId, 
          isBlocked && blockingRuleId === row.id ? 1 : 0, // Mark as blocked only if THIS rule caused it
          JSON.stringify(context.data), JSON.stringify(finalOutputs)
        );
      } catch { /* Logging failure must never halt the evaluation pipeline */ }
    }

    // Stop processing further rules if blocked
    if (isBlocked) break;
  }

  return { category, branchId, finalOutputs, isBlocked, blockReason, warnings, totalExecutionTimeMs: Math.round((performance.now() - startTime) * 100) / 100 };
}

// ── CRUD Operations ────────────────────────────────────────────────────────
export function createRule(rule: Omit<RuleDefinition, 'id' | 'version' | 'createdAt' | 'lastModifiedAt'>, operatorName: string): RuleDefinition {
  const ruleId = id('rule'); const now = new Date().toISOString();
  stmtInsertRule.run(ruleId, rule.name, rule.description, rule.category, JSON.stringify(rule.conditions), JSON.stringify(rule.actions), rule.priority, rule.isActive ? 1 : 0, rule.scopeBranchId, operatorName, now, now);
  saveRuleVersion(ruleId, 1, rule.conditions, rule.actions, rule.priority, rule.isActive, operatorName);
  return { ...rule, id: ruleId, version: 1, createdAt: now, lastModifiedAt: now, lastModifiedBy: operatorName };
}

export function updateRule(ruleId: string, updates: Partial<Pick<RuleDefinition, 'name' | 'description' | 'conditions' | 'actions' | 'priority' | 'isActive' | 'scopeBranchId'>>, operatorName: string): RuleDefinition {
  const existing = stmtGetRuleById.get(ruleId) as RuleDefinitionRow | undefined;
  if (!existing) throw new Error(`Rule not found.`);
  
  const newVersion = existing.version + 1; 
  const now = new Date().toISOString();
  const conditions = updates.conditions ?? JSON.parse(existing.conditions);
  const actions = updates.actions ?? JSON.parse(existing.actions);
  const priority = updates.priority ?? existing.priority;
  const isActive = updates.isActive !== undefined ? updates.isActive : !!existing.is_active;
  
  stmtUpdateRule.run(
    updates.name ?? existing.name, updates.description ?? existing.description, JSON.stringify(conditions), JSON.stringify(actions),
    priority, isActive ? 1 : 0, updates.scopeBranchId !== undefined ? updates.scopeBranchId : existing.scope_branch_id, newVersion, operatorName, now, ruleId
  );
  saveRuleVersion(ruleId, newVersion, conditions, actions, priority, isActive, operatorName);
  return mapRuleRow(stmtGetRuleById.get(ruleId) as RuleDefinitionRow);
}

export function deactivateRule(ruleId: string, operatorName: string): void {
  stmtDeactivateRule.run(operatorName, new Date().toISOString(), ruleId);
}

export function deleteRule(ruleId: string): void { stmtDeleteRule.run(ruleId); }

export function getRulesByCategory(category: RuleCategory, branchId?: string): RuleDefinition[] {
  if (branchId) {
    const rows = stmtGetActiveRules.all(category, branchId) as RuleDefinitionRow[];
    return rows.map(mapRuleRow);
  }
  const rows = stmtGetAllRulesByCategory.all(category) as RuleDefinitionRow[];
  return rows.map(mapRuleRow);
}

export function getRuleById(ruleId: string): RuleDefinition | null {
  const row = stmtGetRuleById.get(ruleId) as RuleDefinitionRow | undefined;
  return row ? mapRuleRow(row) : null;
}

export function getRuleVersions(ruleId: string) {
  return (stmtGetRuleVersions.all(ruleId) as Array<{ version: number; conditions: string; actions: string; priority: number; is_active: number; modified_by: string; modified_at: string }>).map(r => ({
    version: r.version, conditions: JSON.parse(r.conditions), actions: JSON.parse(r.actions), priority: r.priority, isActive: !!r.is_active, modifiedBy: r.modified_by, modifiedAt: r.modified_at
  }));
}

export function rollbackRule(ruleId: string, targetVersion: number, operatorName: string): RuleDefinition {
  const v = stmtGetVersionByNum.get(ruleId, targetVersion) as { conditions: string; actions: string; priority: number; is_active: number } | undefined;
  if (!v) throw new Error(`Version ${targetVersion} not found.`);
  return updateRule(ruleId, { conditions: JSON.parse(v.conditions), actions: JSON.parse(v.actions), priority: v.priority, isActive: !!v.is_active }, operatorName);
}

// ── Helpers & Seeds ────────────────────────────────────────────────────────
function saveRuleVersion(ruleId: string, version: number, conditions: RuleCondition[], actions: RuleAction[], priority: number, isActive: boolean, modifiedBy: string): void {
  stmtInsertRuleVersion.run(id('rv'), ruleId, version, JSON.stringify(conditions), JSON.stringify(actions), priority, isActive ? 1 : 0, modifiedBy);
}

function mapRuleRow(row: RuleDefinitionRow): RuleDefinition {
  return {
    id: row.id, 
    name: row.name, 
    description: row.description, 
    category: row.category as RuleCategory,
    conditions: JSON.parse(row.conditions), 
    actions: JSON.parse(row.actions), 
    priority: row.priority, 
    isActive: !!row.is_active,
    scopeBranchId: row.scope_branch_id, 
    version: row.version, 
    lastModifiedBy: row.last_modified_by, 
    lastModifiedAt: row.last_modified_at, 
    createdAt: row.created_at
  };
}

export function seedDefaultRules(): void {
  const ensure = db.transaction(() => {
    for (const rule of DEFAULT_RULE_CATALOG) {
      const existing = db.prepare('SELECT id FROM rule_definitions WHERE name = ? LIMIT 1').get(rule.name) as { id: string } | undefined;
      if (existing) continue;
      stmtInsertSeedRule.run(
        rule.id,
        rule.name,
        rule.description,
        rule.category,
        JSON.stringify(rule.conditions),
        JSON.stringify(rule.actions),
        rule.priority,
      );
      saveRuleVersion(rule.id, 1, rule.conditions, rule.actions, rule.priority, true, 'system');
    }
  });
  ensure();
}
