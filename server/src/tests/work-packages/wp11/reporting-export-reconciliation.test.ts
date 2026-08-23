/**
 * §77 — the database, the API, and the export state the same numbers.
 * ============================================================================
 * A report is executed ONCE and rendered many times. This suite holds that
 * property mechanically, for every report in the catalog and every period each
 * one declares.
 *
 * The failure this prevents is specific and quiet. An export that re-queried,
 * or that the browser assembled from the rendered table, can differ from what
 * the operator was looking at — and unlike a wrong screen, a wrong spreadsheet
 * leaves the building. It gets emailed to a donor or a partner and is never
 * reconciled against anything again.
 *
 * So the export takes the engine's `ReportResult` and serializes it. There is
 * one execution and two renderings, which makes disagreement unrepresentable
 * rather than merely unlikely. These tests prove that is actually what happens,
 * by comparing all three surfaces value for value.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assignRole } from '../../support/identity.js';
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../../../db/connection.js';
import { ensureOrganizationHierarchy, FIXED_ORG_ID } from '../../../db/organizationHierarchy.js';
import { id, today } from '../../../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../../../utils/auth.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { reportsRouter } from '../../../routes/reports.routes.js';
import { REPORT_CATALOG } from '../../../core/reporting/report-catalog.js';
import { runReport } from '../../../core/reporting/report-engine.js';
import { reportToCsv } from '../../../core/reporting/report-export.js';
import { csvEscape, toCsv } from '../../../utils/csv.js';
import type { ReportingPeriod } from '../../../core/calendar/periods.js';

const repoRootForReports = path.resolve(fileURLToPath(new URL('../../../../../', import.meta.url)));

const BR = 'rep_branch';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/reports', reportsRouter);
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
const OWNER = tok('rep_owner', BR);
const TEACHER = tok('rep_teacher', BR);

let app: ReturnType<typeof createApp>;

/** Parses the metric table out of an exported CSV. */
function parseExportedMetrics(csv: string): Map<string, number> {
  const lines = csv.split('\r\n');
  const headerIndex = lines.findIndex((l) => l.startsWith('Metric,Label,Value,Unit,'));
  expect(headerIndex, 'the export has no metric table').toBeGreaterThan(-1);
  const out = new Map<string, number>();
  for (const line of lines.slice(headerIndex + 1)) {
    if (!line.trim()) continue;
    const metricId = line.slice(0, line.indexOf(','));
    // Value is the third column; labels and notes may be quoted, so walk the
    // row rather than splitting naively.
    const cells = parseCsvRow(line);
    out.set(metricId, Number(cells[2]));
  }
  return out;
}

/** Minimal RFC 4180 row reader, sufficient for the rows this export writes. */
function parseCsvRow(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { cells.push(cur); cur = ''; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
}

beforeAll(async () => {
  initSchema();
  ensureOrganizationHierarchy(db);
  bootstrapRbacCatalog(db);
  db.prepare(
    'INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?,?,?,?,1)',
  ).run('rep_campus', FIXED_ORG_ID, 'Reporting Campus', 'REPC');
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?,?,?,?)').run(
    BR, BR, 'Kabul', 'rep_campus',
  );
  for (const u of [OWNER, TEACHER]) {
    db.prepare(
      `INSERT OR REPLACE INTO users (id, username, full_name, branch_id, password_hash, is_active, must_change_password)
       VALUES (?,?,?,?,?,1,0)`,
    ).run(u.userId, u.username, u.fullName, BR, await hashPassword('x'.repeat(12)));
  }
  assignRole(OWNER.userId, 'owner', null);
  assignRole(TEACHER.userId, 'teacher', BR);

  // Real activity, so the comparisons are not three zeroes agreeing with each
  // other. A reconciliation suite over an empty database proves nothing.
  const d = today();
  db.prepare(
    "INSERT INTO financial_transactions (id,type,category,amount,date,description,branch_id) VALUES (?,'income','fee',125000,?,'seed',?)",
  ).run(id('tx'), d, BR);
  db.prepare(
    "INSERT INTO financial_transactions (id,type,category,amount,date,description,branch_id) VALUES (?,'expense','rent',40000,?,'seed',?)",
  ).run(id('tx'), d, BR);
  for (let i = 0; i < 3; i++) {
    db.prepare(
      `INSERT INTO students (id, student_code, full_name, gender, branch_id, registration_date, status)
       VALUES (?,?,?,'female',?,?,'active')`,
    ).run(id('st'), `RS-${i}`, `Reporting Student ${i}`, BR, d);
  }

  app = createApp();
});

const runViaApi = async (reportId: string, period: string) =>
  supertest(app).get(`/api/reports/run/${reportId}?period=${period}`).set(auth(OWNER));

const exportViaApi = async (reportId: string, period: string) =>
  supertest(app).get(`/api/reports/run/${reportId}/export?period=${period}`).set(auth(OWNER));

describe('the seeded period is not silently empty', () => {
  it('the financial summary reports real money, so the comparisons mean something', async () => {
    const res = await runViaApi('financial-summary', 'month');
    expect(res.status).toBe(200);
    const income = res.body.metrics.find((m: { id: string }) => m.id === 'finance.operating_income');
    expect(income.value).toBe(125000);
    expect(res.body.isEmpty).toBe(false);
  });

  it('the student intake report counts the seeded students', async () => {
    const res = await runViaApi('student-intake', 'month');
    const newStudents = res.body.metrics.find((m: { id: string }) => m.id === 'student.new_students');
    expect(newStudents.value).toBe(3);
  });
});

describe('every report reconciles across engine, API and export', () => {
  const cases = REPORT_CATALOG.flatMap((r) => r.periods.map((p) => [r.id, p] as const));

  it('the catalog actually produced cases to check', () => {
    expect(cases.length).toBeGreaterThan(10);
  });

  it.each(cases)('%s / %s agrees on every metric', async (reportId, period) => {
    const engine = runReport(db, reportId, period as ReportingPeriod, { branchId: null, isAll: true });
    const api = await runViaApi(reportId, period);
    expect(api.status).toBe(200);

    const exported = await exportViaApi(reportId, period);
    expect(exported.status).toBe(200);
    const fromCsv = parseExportedMetrics(exported.text);

    // Same metrics, same order, same values — all three.
    expect(api.body.metrics.map((m: { id: string }) => m.id)).toEqual(engine.metrics.map((m) => m.id));
    expect([...fromCsv.keys()]).toEqual(engine.metrics.map((m) => m.id));

    for (const metric of engine.metrics) {
      expect(api.body.metrics.find((m: { id: string }) => m.id === metric.id).value).toBe(metric.value);
      expect(fromCsv.get(metric.id)).toBe(metric.value);
    }
  });

  it('the export states the same period span the API resolved', async () => {
    const api = await runViaApi('financial-summary', 'month');
    const exported = await exportViaApi('financial-summary', 'month');
    expect(exported.text).toContain(`From,${api.body.boundaries.from}`);
    expect(exported.text).toContain(`To,${api.body.boundaries.to}`);
    expect(exported.text).toContain(`Period key,${api.body.boundaries.periodKey}`);
    expect(exported.headers['x-report-period-key']).toBe(api.body.boundaries.periodKey);
  });

  it('the export is a file, named for the report and the period it covers', async () => {
    const exported = await exportViaApi('financial-summary', 'month');
    expect(exported.headers['content-type']).toContain('text/csv');
    expect(exported.headers['content-disposition']).toMatch(
      /attachment; filename="financial-summary-\d{3,4}-\d{2}\.csv"/,
    );
  });

  it('the export records the branch scope, so a branch file cannot pass as organization-wide', async () => {
    const exported = await exportViaApi('financial-summary', 'month');
    expect(exported.text).toMatch(/Branch scope,(All branches|rep_branch)/);
  });
});

describe('an export is authorized exactly like reading the report', () => {
  it('a role without Report.View cannot export', async () => {
    const res = await supertest(app)
      .get('/api/reports/run/financial-summary/export?period=month')
      .set(auth(TEACHER));
    expect(res.status).toBe(403);
  });

  it('an unknown report is a 404, not an empty file', async () => {
    const res = await exportViaApi('no-such-report', 'month');
    expect(res.status).toBe(404);
  });

  it('an unsupported period is a 400, not a silent fallback', async () => {
    const res = await exportViaApi('financial-summary', 'fortnight');
    expect(res.status).toBe(400);
  });

  it('an unsupported format is refused rather than served as csv', async () => {
    const res = await supertest(app)
      .get('/api/reports/run/financial-summary/export?period=month&format=pdf')
      .set(auth(OWNER));
    expect(res.status).toBe(400);
  });
});

describe('CSV serialization is correct, not merely plausible', () => {
  it('quotes a field containing a comma', () => {
    expect(csvEscape('Ahmadi, Sara')).toBe('"Ahmadi, Sara"');
  });

  it('doubles an embedded quote', () => {
    expect(csvEscape('He said "no"')).toBe('"He said ""no"""');
  });

  it('quotes a field containing a newline', () => {
    expect(csvEscape('line one\nline two')).toBe('"line one\nline two"');
  });

  it('leaves an ordinary field unquoted', () => {
    expect(csvEscape('1405-05')).toBe('1405-05');
  });

  it('renders null and undefined as empty, not as the words', () => {
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(undefined)).toBe('');
    expect(toCsv(['a'], [[null], [undefined]])).toBe('a\r\n\r\n');
  });

  it('a metric note containing a comma survives the round trip', () => {
    // Notes are prose and several genuinely contain commas; if the writer and
    // the reader disagree the Value column shifts and every number is wrong.
    const engine = runReport(db, 'financial-summary', 'month', { branchId: null, isAll: true });
    const withComma = {
      ...engine,
      metrics: engine.metrics.map((m) => ({ ...m, note: 'Excludes X, Y and "Z"' })),
    };
    const parsed = parseExportedMetrics(reportToCsv(withComma, { generatedAt: 'now' }));
    for (const m of engine.metrics) expect(parsed.get(m.id)).toBe(m.value);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// §18 — THE SCREEN IS A CONSUMER, NOT A SECOND DEFINITION
// ══════════════════════════════════════════════════════════════════════════
/**
 * "One metric, one definition, many consumers" survives only if the consumers
 * stay consumers. The cheapest way for a reporting screen to become a second
 * authority is innocuous: sum two metrics to show a total, divide two to show a
 * rate. Nothing reconciles that number against anything, and it is displayed
 * beside figures that ARE reconciled, so it inherits their credibility.
 *
 * These assertions are structural rather than behavioural, because a view that
 * computes correctly today can compute wrongly tomorrow and no value-based test
 * would notice — the wrong value would simply be the expected one.
 */
describe('the reporting view defines no metrics of its own', () => {
  const viewSource = () =>
    fs.readFileSync(
      path.join(repoRootForReports, 'src', 'components', 'reports', 'ReportsView.tsx'),
      'utf8',
    );

  it('contains no SQL', () => {
    // Case-SENSITIVE: SQL in this codebase is written in upper case, and a
    // case-insensitive /\bfrom\b/ matches the English word in every other
    // sentence of the file's own documentation.
    expect(viewSource()).not.toMatch(/\bSELECT\b[\s\S]{0,200}\bFROM\b|\bGROUP BY\b|\bCOALESCE\(/);
  });

  it('does not aggregate the metrics it was given', () => {
    const src = viewSource();
    // reduce/sum over the metric list is the exact shape of an invented total.
    expect(src).not.toMatch(/metrics[\s\S]{0,40}\.reduce\(/);
    expect(src).not.toMatch(/\.reduce\(\s*\(\s*\w+\s*,\s*\w+\s*\)\s*=>\s*\w+\s*\+/);
  });

  it('renders the value the server sent, choosing format by the server\'s unit', () => {
    const src = viewSource();
    expect(src).toContain('formatMetric(m.value, m.unit)');
    // No arithmetic applied to a metric value on its way to the screen.
    expect(src).not.toMatch(/m\.value\s*[+\-*/]\s*[^;)\n]/);
  });

  it('asks the server for the export instead of serializing its own table', () => {
    const src = viewSource();
    expect(src).toContain('/export?');
    // Building CSV in the browser would mean a join over the rendered rows.
    expect(src).not.toMatch(/join\(','\)/);
    expect(src).not.toContain('text/csv');
  });

  it('prints through the print authority', () => {
    const src = viewSource();
    expect(src).toContain('openPrintDocument');
    expect(src).not.toContain('window.open');
  });

  it('offers only the periods the report declares', () => {
    // A period the report does not support is a 400 the operator cannot act on.
    expect(viewSource()).toContain('availablePeriods');
  });

  it('has an empty state distinct from an error state', () => {
    const src = viewSource();
    expect(src).toContain('isEmpty');
    expect(src).toContain('runError');
  });
});

describe('every catalog report is reachable from the view', () => {
  it('the catalog endpoint exposes each declared report', async () => {
    const res = await supertest(app).get('/api/reports/catalog').set(auth(OWNER));
    expect(res.status).toBe(200);
    expect(res.body.reports.map((r: { id: string }) => r.id).sort()).toEqual(
      REPORT_CATALOG.map((r) => r.id).sort(),
    );
  });

  it('the required reporting categories are all present', () => {
    const categories = new Set(REPORT_CATALOG.map((r) => r.category));
    for (const required of ['financial', 'academic', 'student', 'visitor', 'enrollment',
                            'attendance', 'payroll', 'management', 'operational', 'audit']) {
      expect(categories).toContain(required);
    }
  });
});
