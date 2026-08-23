/**
 * Automation engine — the single authority for workflow/automation condition
 * parsing, dry-run evaluation and runtime execution.
 *
 * Stored automation configuration must be executable reality, not metadata.
 * This module validates automation definitions, evaluates payload conditions,
 * executes the declared notify action and records runtime results. Its action
 * scope is intentionally narrow: one automation consumes one domain event and
 * may emit internal notifications only.
 */
import { performance } from 'node:perf_hooks';
import { db } from '../../db/connection.js';
import { addNotification } from '../../utils/notifications.js';
import { id } from '../../utils/ids.js';
import type { DomainEvent } from './event-bus.js';

export const AUTOMATION_OPERATORS = ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'in', 'contains'] as const;
export type AutomationOperator = (typeof AUTOMATION_OPERATORS)[number];
export const AUTOMATION_ACTION_TYPES = ['notify'] as const;
export type AutomationActionType = (typeof AUTOMATION_ACTION_TYPES)[number];
export const AUTOMATION_NOTIFICATION_SEVERITIES = ['info', 'warning', 'critical', 'success'] as const;
export type AutomationNotificationSeverity = (typeof AUTOMATION_NOTIFICATION_SEVERITIES)[number];

export interface AutomationCondition {
  field: string;
  operator: AutomationOperator;
  value: unknown;
}

export interface AutomationAction {
  type: AutomationActionType;
  config: {
    title?: string;
    message: string;
    severity?: AutomationNotificationSeverity;
  };
}

interface AutomationRow {
  id: string;
  name: string;
  trigger: string;
  conditions: string;
  actions: string;
  is_active: number;
}

const stmtSelectMatchingAutomations = db.prepare(`
  SELECT a.*
    FROM event_subscriptions es
    JOIN automations a
      ON a.id = json_extract(es.config, '$.automationId')
   WHERE es.handler = 'automation'
     AND es.event_type = ?
     AND es.is_active = 1
     AND a.is_active = 1
   ORDER BY a.created_at ASC
`);

const stmtInsertAutomationLog = db.prepare(`
  INSERT INTO event_handler_log (id, event_id, handler, success, duration_ms, error)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(event_id, handler) DO UPDATE SET
    success = excluded.success,
    duration_ms = excluded.duration_ms,
    error = excluded.error,
    executed_at = datetime('now')
`);

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}

export function validateAutomationConditions(raw: unknown): AutomationCondition[] {
  if (!Array.isArray(raw)) throw new Error('Conditions must be an array of rule conditions.');
  return raw.map((entry, index) => {
    const cond = asObject(entry, `Condition ${index + 1}`);
    const field = asString(cond.field, `Condition ${index + 1} field`);
    const operator = asString(cond.operator, `Condition ${index + 1} operator`);
    if (!(AUTOMATION_OPERATORS as readonly string[]).includes(operator)) {
      throw new Error(`Condition ${index + 1} has invalid operator "${operator}".`);
    }
    return { field, operator: operator as AutomationOperator, value: cond.value };
  });
}

export function validateAutomationActions(raw: unknown): AutomationAction[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('At least one action is required.');
  return raw.map((entry, index) => {
    const action = asObject(entry, `Action ${index + 1}`);
    const type = asString(action.type, `Action ${index + 1} type`);
    if (type !== 'notify') {
      throw new Error(`Action ${index + 1} has unsupported type "${type}". Only "notify" is supported.`);
    }
    const config = asObject(action.config, `Action ${index + 1} config`);
    const message = asString(config.message, `Action ${index + 1} message`);
    const title = typeof config.title === 'string' && config.title.trim() ? config.title.trim() : undefined;
    const severity = config.severity === undefined ? undefined : asString(config.severity, `Action ${index + 1} severity`);
    if (severity && !(AUTOMATION_NOTIFICATION_SEVERITIES as readonly string[]).includes(severity)) {
      throw new Error(
        `Action ${index + 1} severity "${severity}" is invalid. Supported severities: ${AUTOMATION_NOTIFICATION_SEVERITIES.join(', ')}.`,
      );
    }
    return { type: 'notify', config: { title, message, severity: severity as AutomationNotificationSeverity | undefined } };
  });
}

function parseStoredConditions(serialized: string): AutomationCondition[] {
  try {
    return validateAutomationConditions(JSON.parse(serialized || '[]'));
  } catch {
    return [];
  }
}

function parseStoredActions(serialized: string): AutomationAction[] {
  try {
    return validateAutomationActions(JSON.parse(serialized || '[]'));
  } catch {
    return [];
  }
}

export function resolveFieldPath(path: string, data: Record<string, unknown>): unknown {
  const segments = path.split('.');
  let current: unknown = data;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function evaluateAutomationCondition(condition: AutomationCondition, fieldValue: unknown): boolean {
  switch (condition.operator) {
    case 'eq': return fieldValue === condition.value;
    case 'neq': return fieldValue !== condition.value;
    case 'gt': return Number(fieldValue) > Number(condition.value);
    case 'lt': return Number(fieldValue) < Number(condition.value);
    case 'gte': return Number(fieldValue) >= Number(condition.value);
    case 'lte': return Number(fieldValue) <= Number(condition.value);
    case 'in': return Array.isArray(condition.value) && condition.value.includes(fieldValue);
    case 'contains': return typeof fieldValue === 'string' && typeof condition.value === 'string' && fieldValue.includes(condition.value);
    default: return false;
  }
}

export function evaluateAutomation(conditions: readonly AutomationCondition[], payload: Record<string, unknown>) {
  const conditionResults = conditions.map((condition, index) => {
    const actualValue = resolveFieldPath(condition.field, payload);
    const matched = evaluateAutomationCondition(condition, actualValue);
    return {
      index: index + 1,
      field: condition.field,
      operator: condition.operator,
      expectedValue: condition.value,
      actualValue,
      matched,
    };
  });
  const allConditionsMet = conditionResults.every((result) => result.matched);
  return { allConditionsMet, conditionResults };
}

function executeAutomationActions(automationName: string, actions: readonly AutomationAction[], event: DomainEvent) {
  for (const action of actions) {
    if (action.type !== 'notify') {
      throw new Error(`Unsupported automation action "${action.type}".`);
    }
    addNotification(
      action.config.title ?? `Automation Triggered: ${automationName}`,
      action.config.message,
      action.config.severity ?? 'info',
      event.branchId,
    );
  }
}

function insertAutomationLog(eventId: string, automationId: string, success: boolean, durationMs: number, error?: string) {
  stmtInsertAutomationLog.run(
    id('ehl'),
    eventId,
    `automation:${automationId}`,
    success ? 1 : 0,
    Math.round(durationMs * 100) / 100,
    error ?? null,
  );
}

export function processAutomationsForEvent(event: DomainEvent) {
  const rows = stmtSelectMatchingAutomations.all(event.type) as AutomationRow[];
  if (rows.length === 0) return;

  const tx = db.transaction(() => {
    for (const row of rows) {
      const started = performance.now();
      try {
        const conditions = parseStoredConditions(row.conditions);
        const actions = parseStoredActions(row.actions);
        const verdict = evaluateAutomation(conditions, event.payload);
        if (verdict.allConditionsMet) {
          executeAutomationActions(row.name, actions, event);
        }
        insertAutomationLog(event.id, row.id, true, performance.now() - started);
      } catch (error) {
        insertAutomationLog(
          event.id,
          row.id,
          false,
          performance.now() - started,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  });
  tx();
}

