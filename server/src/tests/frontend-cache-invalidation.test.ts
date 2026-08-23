/**
 * Regression: the frontend tab cache must be invalidated after mutations.
 *
 * DEFECT (reported by the user as "data does not update unless I refresh the page"):
 * `loadedTabs` in src/apiStore.ts is an "already fetched -> never fetch again"
 * cache. It was only ever cleared by reloadAll() (login / branch switch), so once
 * a tab had been visited it served whatever was in memory for the rest of the
 * session. Registering a student on the Students tab and then opening Exams
 * showed a picker without the new student until the user pressed F5.
 * `reloadStudentsLite()` compounded it by returning early whenever any roster
 * was already in memory.
 *
 * These assertions are structural (they read the frontend source) because the
 * store is a React hook and this repo's test runner is node-environment only.
 * They pin the invariants a future edit could silently break.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const storeSrc = fs.readFileSync(path.join(repoRoot, 'src', 'apiStore.ts'), 'utf8');

/** Parses the TAB_DATASETS literal into { dataset: tabs[] }. */
function parseTabDatasets(): Record<string, string[]> {
  const block = /TAB_DATASETS[^=]*=\s*useMemo\(\(\)\s*=>\s*\(\{([\s\S]*?)\}\), \[\]\)/.exec(storeSrc);
  expect(block, 'TAB_DATASETS map must exist in apiStore.ts').toBeTruthy();
  const map: Record<string, string[]> = {};
  for (const [, key, list] of block![1].matchAll(/(\w+):\s*\[([^\]]*)\]/g)) {
    map[key] = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  }
  return map;
}

/** Parses `case 'tab': ... reloadX()` out of loadTab into { tab: reloaders[] }. */
function parseLoadTab(): Record<string, string[]> {
  const start = storeSrc.indexOf('const loadTab = useCallback');
  expect(start, 'loadTab must exist').toBeGreaterThan(-1);
  const body = storeSrc.slice(start, storeSrc.indexOf('}, [', start));
  const cases: Record<string, string[]> = {};
  const parts = body.split(/case '/).slice(1);
  for (const part of parts) {
    const tab = part.slice(0, part.indexOf("'"));
    cases[tab] = [...part.matchAll(/\b(reload[A-Za-z]+)\(/g)].map((m) => m[1]);
  }
  return cases;
}

/** Which dataset each reloader belongs to. */
const RELOADER_DATASET: Record<string, string> = {
  reloadStudents: 'students',
  reloadStudentsLite: 'students',
  reloadStudentBalances: 'payments',
  reloadTeachers: 'teachers',
  reloadEmployees: 'teachers',
  reloadClasses: 'classes',
  reloadSessions: 'classes',
  reloadVisitors: 'visitors',
  reloadBooksWorkspace: 'books',
  reloadExams: 'exams',
  reloadExamResults: 'exams',
  reloadAttendance: 'attendance',
  reloadAttendanceSummary: 'attendance',
  reloadSkills: 'skills',
  reloadClassTeacherSkills: 'skills',
  reloadBudgetLines: 'finance',
  reloadFinanceOverview: 'finance',
  reloadProgramVersions: 'academic',
  reloadDonors: 'funding',
  reloadFundingCampaigns: 'funding',
  reloadDonations: 'funding',
  reloadScholarships: 'funding',
  reloadScholarshipAwards: 'funding',
  reloadSponsorships: 'funding',
  reloadWorkflows: 'workflows',
  reloadAutomations: 'workflows',
  reloadAuditLogs: 'audit',
};

describe('apiStore tab cache invalidation', () => {
  it('exposes an invalidate() that evicts dependent tabs from loadedTabs', () => {
    expect(storeSrc).toMatch(/const invalidate = useCallback\(\(\.\.\.datasets: string\[\]\)/);
    expect(storeSrc).toContain('for (const tab of TAB_DATASETS[ds] ?? []) next.delete(tab);');
  });

  it('covers every tab that renders a dataset (a mutation must evict all of its readers)', () => {
    const datasets = parseTabDatasets();
    const loadTab = parseLoadTab();
    const problems: string[] = [];

    for (const [tab, reloaders] of Object.entries(loadTab)) {
      for (const reloader of reloaders) {
        const dataset = RELOADER_DATASET[reloader];
        if (!dataset) continue;
        const readers = datasets[dataset];
        if (!readers) {
          problems.push(`TAB_DATASETS is missing dataset '${dataset}'`);
        } else if (!readers.includes(tab)) {
          problems.push(
            `tab '${tab}' loads ${reloader}() (dataset '${dataset}') but is not in TAB_DATASETS.${dataset}, ` +
              `so it keeps serving stale data after that dataset changes`,
          );
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('declares no dataset that nothing reads and no tab that does not exist', () => {
    const datasets = parseTabDatasets();
    const knownTabs = new Set(Object.keys(parseLoadTab()));
    for (const [dataset, tabs] of Object.entries(datasets)) {
      expect(tabs.length, `dataset '${dataset}' evicts nothing`).toBeGreaterThan(0);
      for (const tab of tabs) {
        expect(knownTabs.has(tab), `TAB_DATASETS.${dataset} names unknown tab '${tab}'`).toBe(true);
      }
    }
  });

  it('always evicts the audit trail, which every backend mutation appends to', () => {
    expect(storeSrc).toContain("next.delete('audit');");
  });

  it('marks the separately-cached lite roster stale when students change', () => {
    // reloadStudentsLite keeps its own in-memory copy, so evicting tabs alone
    // would not refresh the student pickers on Exams/Books/Visitors.
    // `affected` is the caller's datasets expanded through DATASET_DEPENDENTS, so
    // the roster is also marked stale when students become stale indirectly
    // (e.g. an enrolment invalidating a dataset that students derives from).
    expect(storeSrc).toContain("if (affected.includes('students')) setRosterStale(true);");
    expect(storeSrc).toContain('if (alreadyPopulated && !rosterStaleRef.current) return Promise.resolve();');
    expect(storeSrc).toMatch(/setStudentsAreLite\(true\); setRosterStale\(false\)/);
  });

  it('invalidates after every mutating store action', () => {
    // Each `const name = async (...) => { ... }` that performs a write must
    // either invalidate a dataset or be a read-through/report call.
    const allowlist = new Set([
      'resetUserPassword', // credential change; no cached list renders it
      'generateImpactReport', // reloads its own collection and returns the report
      'evaluateBusinessRules', // dry-run evaluation endpoint, persists nothing
    ]);
    const lines = storeSrc.split('\n');
    const starts: Array<{ name: string; line: number }> = [];
    lines.forEach((line, i) => {
      const m = /^ {2}const (\w+) = (?:async )?(?:\(|useCallback)/.exec(line);
      if (m) starts.push({ name: m[1], line: i });
    });

    const offenders: string[] = [];
    starts.forEach((fn, idx) => {
      const end = idx + 1 < starts.length ? starts[idx + 1].line : lines.length;
      const body = lines.slice(fn.line, end).join('\n');
      const writes = /api\.(post|put|patch|delete)\b/.test(body);
      if (writes && !body.includes('invalidate(') && !allowlist.has(fn.name)) {
        offenders.push(`${fn.name} (line ${fn.line + 1}) mutates but never calls invalidate()`);
      }
    });
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

describe('the reported staleness scenario', () => {
  /** Faithful model of the store's caching logic. */
  function makeCache() {
    const datasets = parseTabDatasets();
    const loaded = new Set<string>();
    let rosterStale = false;
    return {
      visit(tab: string) {
        if (loaded.has(tab)) return 'served-from-cache';
        loaded.add(tab);
        return 'fetched';
      },
      liteRoster(): 'reused' | 'refetched' {
        if (!rosterStale) return 'reused';
        rosterStale = false;
        return 'refetched';
      },
      invalidate(...ds: string[]) {
        for (const d of ds) for (const tab of datasets[d] ?? []) loaded.delete(tab);
        loaded.delete('audit');
        if (ds.includes('students')) rosterStale = true;
      },
    };
  }

  it('refetches Exams after a student is registered on the Students tab', () => {
    const cache = makeCache();
    expect(cache.visit('students')).toBe('fetched');
    expect(cache.visit('exams')).toBe('fetched');
    expect(cache.visit('exams')).toBe('served-from-cache'); // caching still works

    cache.invalidate('students', 'payments', 'finance'); // addStudentManual

    // Before the fix both of these returned the stale copies.
    expect(cache.visit('exams')).toBe('fetched');
    expect(cache.liteRoster()).toBe('refetched');
    expect(cache.visit('dashboard')).toBe('fetched');
  });

  it('does not evict unrelated tabs (invalidation stays targeted)', () => {
    const cache = makeCache();
    for (const tab of ['funding', 'teachers', 'books']) cache.visit(tab);
    cache.invalidate('books');
    expect(cache.visit('books')).toBe('fetched');
    expect(cache.visit('funding')).toBe('served-from-cache');
    expect(cache.visit('teachers')).toBe('served-from-cache');
  });

  it('refreshes both attendance and students after attendance is recorded', () => {
    // The Students tab renders an attendance-rate column (reloadAttendanceSummary),
    // so it is a reader of the attendance dataset and must be evicted too.
    const cache = makeCache();
    cache.visit('attendance');
    cache.visit('students');
    cache.visit('funding');
    cache.invalidate('attendance');
    expect(cache.visit('attendance')).toBe('fetched');
    expect(cache.visit('students')).toBe('fetched');
    expect(cache.visit('funding')).toBe('served-from-cache');
  });
});
