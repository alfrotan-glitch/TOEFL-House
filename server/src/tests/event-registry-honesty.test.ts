/**
 * Event-registry honesty.
 * ============================================================================
 * The catalog in event-registry.ts is the shared vocabulary, and
 * EMITTED_EVENT_TYPES claims which of those types a runtime writer actually
 * publishes. Triggerable surfaces (automation creation, workflow-definition
 * creation) reject everything else, so a stale claim here would either lock
 * owners out of a working trigger or silently hand them a rule that can never
 * fire. These tests scan the real source tree and pin the claim to the actual
 * `.emit(` call sites — in both directions — so the list cannot drift.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import {
  DOMAIN_EVENT_CATALOG,
  EMITTED_EVENT_TYPES,
  DYNAMIC_EMIT_SITES,
  isEmittedEventType,
  isDomainEventType,
} from '../core/events/event-registry.js';
import automationsRouter from '../routes/automations.routes.js';
import { seedDefaultAutomations } from '../routes/automations.routes.js';
import workflowsRouter from '../routes/workflows.routes.js';
import { seedDefaultWorkflowDefinitions } from '../utils/workflowSeeds.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { seedUser, bearerFor } from './support/identity.js';

const SRC_ROOT = join(import.meta.dirname, '..');

/** All non-test source files under src/, relative paths. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === 'tests') continue;
        walk(full);
      } else if (name.endsWith('.ts')) {
        out.push(full);
      }
    }
  };
  walk(SRC_ROOT);
  return out;
}

const REGISTRY_FILE = join(SRC_ROOT, 'core', 'events', 'event-registry.ts').replace(/\\/g, '/');

/** Emit call sites: the literal event type named as the first argument. */
function literalEmitTypes(files: string[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of files) {
    if (file.replace(/\\/g, '/') === REGISTRY_FILE) continue; // declarations, not emitters
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\.emit\(/g)) {
      const start = match.index! + match[0].length;
      const firstArg = text.slice(start, start + 300).split(',')[0];
      for (const literal of firstArg.matchAll(/'([a-z]+\.[a-z_]+)'/g)) {
        const list = found.get(literal[1]) ?? [];
        list.push(file);
        found.set(literal[1], list);
      }
    }
  }
  return found;
}

let files: string[];
let emitted: Map<string, string[]>;

beforeAll(() => {
  files = sourceFiles();
  emitted = literalEmitTypes(files);
});

describe('registry ↔ source-tree honesty', () => {
  it('every type claimed emitted has a literal emit call site in non-test source', () => {
    for (const type of EMITTED_EVENT_TYPES) {
      expect(emitted.has(type), `${type} is claimed emitted but no route/core writer emits it`).toBe(true);
    }
  });

  it('dynamically-emitted types really occur next to an emit call in their registered file', () => {
    for (const [type, relFile] of Object.entries(DYNAMIC_EMIT_SITES)) {
      const file = join(SRC_ROOT, '..', relFile);
      const text = readFileSync(file, 'utf8');
      expect(text, `${relFile} must exist`).toContain(`'${type}'`);
      expect(text, `${relFile} must contain the emit call`).toMatch(/\.emit\(/);
      expect(emitted.has(type), `${type} must not also be claimed as a literal emit elsewhere`).toBe(false);
      void file;
    }
  });

  it('every literal emit type in the source tree is claimed emitted (no ungoverned events)', () => {
    const claimed = new Set<string>(EMITTED_EVENT_TYPES);
    for (const type of emitted.keys()) {
      expect(claimed.has(type), `${type} is emitted in source but missing from EMITTED_EVENT_TYPES`).toBe(true);
    }
  });

  it('reserved vocabulary appears nowhere outside the registry — no dead emitters or consumers', () => {
    const reserved = DOMAIN_EVENT_CATALOG.map((e) => e.type).filter((t) => !isEmittedEventType(t));
    expect(reserved.length).toBeGreaterThan(0); // the guard is meaningless if everything is "emitted"
    for (const type of reserved) {
      for (const file of files) {
        const rel = file.replace(/\\/g, '/');
        if (rel === REGISTRY_FILE) continue;
        const text = readFileSync(file, 'utf8');
        expect(text.includes(`'${type}'`), `${type} is reserved but referenced in ${rel}`).toBe(false);
      }
    }
  });

  it('emitted types are a subset of the catalog vocabulary', () => {
    for (const type of EMITTED_EVENT_TYPES) expect(isDomainEventType(type)).toBe(true);
    for (const type of Object.keys(DYNAMIC_EMIT_SITES)) expect(isDomainEventType(type)).toBe(true);
  });
});

describe('seeded triggers are live', () => {
  beforeAll(() => {
    initSchema();
    bootstrapRbacCatalog(db);
    seedDefaultAutomations();
    seedDefaultWorkflowDefinitions();
  });

  it('every seeded automation listens for an emitted type', () => {
    const rows = db.prepare('SELECT name, trigger FROM automations').all() as { name: string; trigger: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const row of rows) {
      expect(isEmittedEventType(row.trigger), `automation "${row.name}" triggers on reserved type '${row.trigger}'`).toBe(true);
    }
  });

  it('every seeded event-triggered workflow definition starts on an emitted type', () => {
    const rows = db.prepare('SELECT name, trigger FROM workflow_definitions').all() as { name: string; trigger: string }[];
    expect(rows.length).toBeGreaterThan(0);
    const eventTriggered = rows.filter((r) => r.trigger !== 'manual');
    expect(eventTriggered.length).toBeGreaterThan(0);
    for (const row of eventTriggered) {
      expect(isEmittedEventType(row.trigger), `workflow "${row.name}" starts on reserved type '${row.trigger}'`).toBe(true);
    }
  });
});

describe('triggerable surfaces reject reserved vocabulary', () => {
  const BRANCH = 'reghon_branch';
  const OWNER = 'u_reghon_owner';
  let app: express.Express;

  beforeAll(() => {
    initSchema();
    bootstrapRbacCatalog(db);
    db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'Registry Honesty Branch', 'Kabul');
    seedUser({ id: OWNER, role: 'owner', branchId: BRANCH, fullName: 'Registry Honesty Owner' });
    app = express();
    app.use(express.json());
    app.use('/api/automations', automationsRouter);
    app.use('/api/workflows', workflowsRouter);
    app.use(errorHandler);
  });

  it('POST /api/automations refuses a trigger with no emitter instead of promising a dead rule', async () => {
    const denied = await supertest(app)
      .post('/api/automations')
      .set(bearerFor(OWNER))
      .send({
        name: 'Dead rule',
        trigger: 'invoice.paid',
        conditions: [],
        actions: [{ type: 'notify', config: { title: 'Never', message: 'This must not be created.', severity: 'warning' } }],
      });
    expect(denied.status).toBe(400);
    expect(denied.body.error).toContain('would never fire');

    const created = await supertest(app)
      .post('/api/automations')
      .set(bearerFor(OWNER))
      .send({
        name: 'Live rule',
        trigger: 'book.sold',
        conditions: [],
        actions: [{ type: 'notify', config: { title: 'Stock', message: 'A book was sold.', severity: 'info' } }],
      });
    expect(created.status).toBe(201);
  });

  it('POST /api/workflows refuses an event trigger with no emitter; manual stays valid', async () => {
    const denied = await supertest(app)
      .post('/api/workflows/definitions')
      .set(bearerFor(OWNER))
      .send({ name: 'Dead workflow', trigger: 'student.graduated', steps: [{ name: 'Wait', action: 'notify', config: {} }] });
    expect(denied.status).toBe(400);
    expect(denied.body.error).toContain('would never start');

    // Shape of a valid definition is owned by wp12; here only the trigger
    // gate matters, so a bad-steps payload with a manual trigger must fail
    // for step reasons, NOT for the trigger.
    const manualBadSteps = await supertest(app)
      .post('/api/workflows/definitions')
      .set(bearerFor(OWNER))
      .send({ name: 'Manual', trigger: 'manual', steps: [{ name: 's', action: 'notify', config: {} }] });
    expect(manualBadSteps.body.error ?? '').not.toContain('would never start');
  });
});
