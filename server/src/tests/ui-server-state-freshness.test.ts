/**
 * UI server-state freshness — architectural guard.
 * ============================================================================
 * A global defect was proven by audit: `apiStore` implements the correct
 * pessimistic "mutate → reload server truth → invalidate dependent datasets"
 * model, but 11 components mutated the server directly and never told the store.
 * Nothing then refetched, so a successful mutation in one view left every other
 * view showing stale server truth until the operator pressed F5 — which was
 * effectively the application's only global invalidation mechanism.
 *
 * These tests are structural. They cannot prove pixels, but they CAN prove the
 * architectural invariants that the defect violated, and they fail loudly the
 * moment a new mutation is added outside the canonical mechanism. That is the
 * property that keeps the fix from silently eroding.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SRC = join(REPO_ROOT, 'src');
const STORE = join(SRC, 'apiStore.ts');
const FRESHNESS = join(SRC, 'state/serverStateFreshness.ts');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

/** Strip comments so a mention inside prose is never mistaken for real code. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const MUTATION_RE = /\bapi\.(post|put|patch|delete)\b/;
const ALL_FILES = walk(SRC);

/**
 * Files allowed to mutate without participating in dataset invalidation, each
 * with the reason it is genuinely exempt. Anything not listed here must invalidate.
 */
const EXEMPT: Record<string, string> = {
  'components/auth/LoginView.tsx':
    'Authentication, not a data mutation. It runs before the store exists and a ' +
    'successful sign-in triggers reloadAll(), which rebuilds every dataset anyway.',
  'contexts/AuthProvider.tsx':
    'Session lifecycle (login / change-password), not domain data. Establishing a ' +
    'session rebuilds all datasets through reloadAll(); no dataset is mutated here.',
  'apiStore.ts':
    'The store IS the canonical mechanism; it calls invalidate() internally.',
  'App.tsx':
    'Only mutation is /notifications/read-all, which immediately awaits ' +
    'store.reloadNotifications() to re-read server truth. Notifications are not a ' +
    'shared dataset that other views derive from, so no dependency edge applies.',
};

describe('canonical freshness mechanism exists and is single', () => {
  it('the store exposes exactly one invalidation authority and one version map', () => {
    const src = code(STORE);
    expect(src).toMatch(/const invalidate = useCallback\(/);
    expect(src).toMatch(/const \[datasetVersion, setDatasetVersion\] = useState/);
    // Both must be published on the store's public surface.
    expect(src).toMatch(/invalidate,\s*datasetVersion,/);
  });

  it('a dataset dependency graph is declared centrally, not per component', () => {
    const src = code(STORE);
    expect(src).toMatch(/const DATASET_DEPENDENTS/);
    // The audit's canonical example: academic configuration drives what the
    // class/session/attendance views render.
    expect(src).toMatch(/academic:\s*\[[^\]]*'classes'[^\]]*\]/);
    expect(src).toMatch(/academic:\s*\[[^\]]*'sessions'[^\]]*\]/);
  });

  it('invalidation bumps dataset versions so MOUNTED consumers refetch', () => {
    const src = code(STORE);
    const body = src.slice(src.indexOf('const invalidate = useCallback('));
    // Evicting loadedTabs alone only helps components that are about to mount.
    expect(body).toMatch(/setLoadedTabs/);
    expect(body).toMatch(/setDatasetVersion/);
  });

  it('a branch switch bumps every dataset so no view keeps the previous branch', () => {
    const src = code(STORE);
    const reloadAll = src.slice(src.indexOf('const reloadAll = useCallback('));
    expect(reloadAll.slice(0, 1200)).toMatch(/setDatasetVersion/);
  });

  it('the freshness context does not instantiate a second store', () => {
    const src = code(FRESHNESS);
    expect(src).toMatch(/createContext/);
    // Calling useApiStore() from a leaf would build an independent store.
    expect(src).not.toMatch(/useApiStore/);
  });

  it('the shared fetch helper carries out-of-order protection', () => {
    const src = code(FRESHNESS);
    expect(src).toMatch(/export function useVersionedFetch/);
    // A newer request must be able to retire an older in-flight one.
    expect(src).toMatch(/seqRef/);
    expect(src).toMatch(/isCurrent/);
  });
});

describe('no component mutates the server outside the canonical mechanism', () => {
  const offenders = ALL_FILES.filter((f) => MUTATION_RE.test(code(f))).map((f) =>
    f.slice(SRC.length + 1).replace(/\\/g, '/')
  );

  it('every mutating file either invalidates or is an explicit, documented exemption', () => {
    const failures: string[] = [];
    for (const rel of offenders) {
      if (rel in EXEMPT) continue;
      const src = code(join(SRC, rel));
      if (!/\binvalidate\s*\(/.test(src)) failures.push(rel);
    }
    expect(failures, `these mutate the server but never invalidate a dataset:\n${failures.join('\n')}`).toEqual([]);
  });

  it('exemptions are documented and still real', () => {
    for (const [rel, reason] of Object.entries(EXEMPT)) {
      expect(reason.length, `${rel} needs a real justification`).toBeGreaterThan(40);
      // A stale exemption (file deleted/renamed) must not silently pass.
      expect(() => statSync(join(SRC, rel))).not.toThrow();
    }
  });

  it('the ad-hoc window-event notification channel is gone', () => {
    // These events were dispatched but had NO listener anywhere, so they only
    // looked like invalidation while nothing actually refreshed.
    for (const f of ALL_FILES) {
      expect(code(f)).not.toMatch(/erp-students-refresh|erp-teachers-refresh/);
    }
  });

  it('freshness is never "solved" by reloading the page or polling', () => {
    for (const f of ALL_FILES) {
      const rel = f.slice(SRC.length + 1).replace(/\\/g, '/');
      // ErrorBoundary legitimately offers the user a reload after a crash.
      if (rel === 'components/ErrorBoundary.tsx') continue;
      const src = code(f);
      expect(src, `${rel} must not force a page reload`).not.toMatch(/location\.reload\(/);
      // Polling means periodically REFETCHING server state. A local clock tick
      // driving a countdown display is not polling, so the check targets timers
      // that actually issue requests or invalidate.
      for (const m of src.matchAll(/setInterval\(([\s\S]{0,220}?)\)\s*[;,]/g)) {
        expect(m[1], `${rel} must not poll the server for freshness`).not.toMatch(
          /\bapi\.|invalidate\(|reload[A-Z]/
        );
      }
    }
  });
});

describe('consumers of shared datasets subscribe to the freshness signal', () => {
  // ClassesView renders academic configuration (levels, rooms, slots, fees) that
  // Academic Setup owns. It was the audit's proof case: its fetch effect only
  // depended on branchId, so an academic change elsewhere stayed invisible.
  it('ClassesView refetches academic configuration when that dataset changes', () => {
    const src = code(join(SRC, 'components/classes/ClassesView.tsx'));
    expect(src).toMatch(/useDatasetVersion\('academic'\)/);
    expect(src).toMatch(/\[loadAcademicConfig,\s*academicVersion\]/);
  });

  it('every component subscribing to a dataset uses the shared hook', () => {
    for (const f of ALL_FILES) {
      const src = code(f);
      if (!/useDatasetVersion|useInvalidate|useVersionedFetch/.test(src)) continue;
      if (f === FRESHNESS) continue;
      expect(src, `${f} must import the canonical hooks`).toMatch(
        /from '.*state\/serverStateFreshness'/
      );
    }
  });
});
