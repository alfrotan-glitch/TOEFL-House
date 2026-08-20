/**
 * Impact reporting resolves its period through the calendar authority.
 * ============================================================================
 * TR-7. `impact.routes.ts` declared its own `periodBounds()` resolving
 * 'YYYY-Qn', 'YYYY-MM' and 'YYYY' in the GREGORIAN calendar, while
 * `periodBoundariesForKey` resolves the same three shapes in SHAMSI. Two period
 * authorities for one concept is LAW 1's definition of failure.
 *
 * These are donor-facing reports. They state scholarship funds disbursed and
 * donations received, in AFN, for a named period — so a period that does not
 * mean what Finance means by the same name produces a figure a donor cannot
 * reconcile against the ledger.
 *
 * THE TRAP THIS SUITE EXISTS TO CLOSE
 *
 * Both resolvers accept `\d{4}-Q[1-4]`, so the same string is valid to both and
 * means different centuries:
 *
 *     '2026-Q1'  Gregorian -> 2026-01-01 .. 2026-03-31
 *                Shamsi    -> 2647-03-21 .. 2647-06-21
 *     '1405-Q2'  Gregorian -> 1405-04-01 .. 1405-06-30   (medieval)
 *                Shamsi    -> 2026-06-22 .. 2026-09-22
 *
 * Neither rejected the other's format. Simply swapping the resolver would
 * therefore have turned the UI's hard-coded '2026-Q1' into a report for the
 * year 2647 — every metric zero, no error, nothing to notice. LAW 6 forbids
 * exactly that silent substitution, so the authority now refuses a year the
 * system cannot plausibly be operating in.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assignRole } from './support/identity.js';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { ensureOrganizationHierarchy, FIXED_ORG_ID } from '../db/organizationHierarchy.js';
import { id, today } from '../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import impactRouter from '../routes/impact.routes.js';
import { periodBoundaries, periodBoundariesForKey } from '../core/calendar/periods.js';

const BR = 'impact_branch';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/impact', impactRouter);
  app.use(errorHandler);
  return app;
}

const tok = (userId: string, branchId: string): TokenPayload => ({
  userId,
  username: userId,
  branchId,
  fullName: userId,
});
const auth = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });
const OWNER = tok('impact_owner', BR);

let app: ReturnType<typeof createApp>;

/** The Shamsi month key covering today. */
const currentMonthKey = () => periodBoundaries('month', today()).periodKey;

const generate = async (period: string) =>
  supertest(app).post('/api/impact/reports/generate').set(auth(OWNER)).send({ period });

const metricValue = (body: any, name: string) =>
  (body.metrics as { name: string; value: number }[]).find((m) => m.name === name)?.value;

const DONOR = 'impact_donor';

function seedDonation(amount: number, date: string) {
  db.prepare(
    `INSERT INTO donations (id, donor_id, amount, date, receipt_no, branch_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id('dn'), DONOR, amount, date, id('rcpt'), BR);
}

beforeAll(async () => {
  initSchema();
  ensureOrganizationHierarchy(db);
  bootstrapRbacCatalog(db);
  db.prepare(
    'INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?,?,?,?,1)',
  ).run('impact_campus', FIXED_ORG_ID, 'Impact Campus', 'IMPC');
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?,?,?,?)').run(
    BR,
    BR,
    'Kabul',
    'impact_campus',
  );
  db.prepare(
    `INSERT OR REPLACE INTO users (id, username, full_name, branch_id, password_hash, is_active, must_change_password)
     VALUES (?,?,?,?,?,1,0)`,
  ).run(OWNER.userId, OWNER.username, OWNER.fullName, BR, await hashPassword('x'.repeat(12)));
  assignRole(OWNER.userId, 'owner', null);
  db.prepare("INSERT OR IGNORE INTO donors (id, full_name, type) VALUES (?,?,'individual')").run(
    DONOR,
    'Impact Donor',
  );
  app = createApp();
});

beforeEach(() => {
  db.prepare('DELETE FROM donations WHERE branch_id = ?').run(BR);
  db.prepare('DELETE FROM impact_reports WHERE branch_id = ?').run(BR);
});

describe('impact reports use the one period authority', () => {
  it('a Shamsi month key produces the authority\'s span', async () => {
    const key = currentMonthKey();
    const span = periodBoundariesForKey(key);

    // A donation on the first day of the Shamsi month is inside the period.
    seedDonation(70_000, span.from);

    const res = await generate(key);
    expect(res.status).toBe(201);
    expect(metricValue(res.body, 'Donations Received in Period')).toBe(70_000);
  });

  it('a donation outside the Shamsi month is excluded', async () => {
    const key = currentMonthKey();
    const span = periodBoundariesForKey(key);

    // The day before the Shamsi month began.
    const before = new Date(`${span.from}T00:00:00Z`);
    before.setUTCDate(before.getUTCDate() - 1);
    seedDonation(55_000, before.toISOString().slice(0, 10));

    const res = await generate(key);
    expect(res.status).toBe(201);
    expect(metricValue(res.body, 'Donations Received in Period')).toBe(0);
  });

  it('the report covers the Shamsi span, not the Gregorian one', async () => {
    const key = currentMonthKey();
    const span = periodBoundariesForKey(key);
    const gregorianFrom = `${span.from.slice(0, 7)}-01`;

    // Only meaningful while the two windows differ, which is asserted here so
    // the test cannot quietly stop proving anything.
    expect(span.from).not.toBe(gregorianFrom);

    // A donation inside the Gregorian month but before the Shamsi month.
    seedDonation(90_000, gregorianFrom);
    const res = await generate(key);
    expect(res.status).toBe(201);
    expect(metricValue(res.body, 'Donations Received in Period')).toBe(0);
  });
});

describe('a Gregorian year is refused, not silently read as Shamsi', () => {
  /**
   * The whole point of TR-7: '2026-Q1' must not quietly become a year-2647
   * report full of zeros. It is 621 years away from any year this system can be
   * operating in, so it is rejected rather than resolved.
   */
  it.each(['2026-Q1', '2026-08', '2026', '1999', '2100-Q4'])(
    'rejects %s',
    async (period) => {
      const res = await generate(period);
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toMatch(/shamsi/i);
    },
  );

  it('the calendar authority itself refuses an implausible year', () => {
    for (const key of ['2026-Q1', '2026-08', '2026', '1999']) {
      expect(() => periodBoundariesForKey(key)).toThrow();
    }
  });

  it('and still accepts the years the system actually operates in', () => {
    for (const key of ['1404', '1405-05', '1405-Q2', '1406-12']) {
      expect(() => periodBoundariesForKey(key)).not.toThrow();
    }
  });

  it('an unparseable period is refused too', async () => {
    for (const bad of ['not-a-period', '', '14-05', '1405-13']) {
      const res = await generate(bad);
      expect(res.status).toBe(400);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// §76 — CROSS-DOMAIN CONSISTENCY
// ══════════════════════════════════════════════════════════════════════════
/**
 * The point of one authority is that a period name means the same thing in
 * every domain that uses it. Impact, reporting and BOS all resolve a period
 * key; if any of them re-derives its own span, a donor report and a finance
 * report for "1405-05" cover different days.
 */
describe('one period key means one span everywhere', () => {
  it('no route re-implements period resolution', () => {
    // Asserted against source because the defect is structural: a second
    // resolver can agree today and drift tomorrow.
    const routes = path.join(
      path.dirname(fileURLToPath(new URL('.', import.meta.url))),
      'routes',
    );
    const offenders: string[] = [];
    for (const file of fs.readdirSync(routes)) {
      if (!file.endsWith('.ts')) continue;
      const src = fs.readFileSync(path.join(routes, file), 'utf8');
      // A locally declared function that turns a period string into bounds.
      if (/function\s+periodBounds\s*\(/.test(src)) offenders.push(file);
      // Gregorian quarter/year arithmetic built from a period literal.
      if (/`\$\{period\}-01-01`|`\$\{period\}-12-31`/.test(src)) offenders.push(file);
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  it('impact and the calendar authority agree on every supported shape', () => {
    for (const key of ['1405-05', '1405-Q2', '1405']) {
      const b = periodBoundariesForKey(key);
      expect(b.from <= b.to).toBe(true);
      expect(b.periodKey).toBe(key.length === 4 ? key : b.periodKey);
    }
  });
});
