/**
 * Cross-view server-state freshness — behavioural proof.
 * ============================================================================
 * The structural guard (`ui-server-state-freshness.test.ts`) proves the wiring
 * exists. This suite proves it WORKS, by rendering the real hooks into a real
 * DOM and counting actual fetches.
 *
 * The defect being locked closed: a successful mutation in one view left every
 * other mounted view showing stale server truth, because nothing but a full
 * page reload could invalidate them. Each test below therefore keeps the
 * consumer MOUNTED (no remount, no branch change, no tab change) and asserts
 * that it refetched anyway.
 *
 *
 * Written with React.createElement rather than JSX: the server tsconfig does not
 * enable JSX, and the freshness contract under test is hook behaviour, not markup.
 *
 * The DOM is constructed explicitly with jsdom instead of switching the vitest
 * environment. The suite runs under the shared `node` environment (Vitest 4
 * removed per-glob environments, and the `@vitest-environment` docblock changed
 * the transform path so the imported frontend module arrived untransformed), so
 * the globals React needs are installed here and torn down afterwards.
 */
import React, { useCallback, useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  ServerStateFreshnessProvider,
  useDatasetVersion,
  useInvalidate,
  useVersionedFetch,
  type ServerStateFreshness,
} from '../../../../../src/state/serverStateFreshness';

// React 19 wants this flag set for act() to be recognised.
const g = globalThis as unknown as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = dom.window.document.createElement('div') as unknown as HTMLDivElement;
  dom.window.document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const el = React.createElement;

function render(node: React.ReactElement) {
  act(() => root.render(node));
}

/**
 * Minimal faithful re-implementation of the store's invalidation semantics:
 * a monotonic version per dataset, expanded through the dependency graph.
 * Mirrors `invalidate()` in apiStore so these tests exercise the same contract
 * the application uses.
 */
function makeHarness(dependents: Record<string, readonly string[]> = {}) {
  let setVersions: React.Dispatch<React.SetStateAction<Record<string, number>>> | null = null;

  function Harness({ children }: { children: React.ReactNode }) {
    const [datasetVersion, setDatasetVersion] = useState<Record<string, number>>({});
    setVersions = setDatasetVersion;
    const invalidate = useCallback((...datasets: string[]) => {
      setDatasetVersion((prev) => {
        const next = { ...prev };
        const affected = new Set<string>();
        for (const ds of datasets) {
          affected.add(ds);
          for (const dep of dependents[ds] ?? []) affected.add(dep);
        }
        for (const ds of affected) next[ds] = (next[ds] ?? 0) + 1;
        return next;
      });
    }, []);
    const value: ServerStateFreshness = { invalidate, datasetVersion };
    return React.createElement(ServerStateFreshnessProvider, { value, children });
  }

  return {
    Harness,
    /** Simulate a successful mutation elsewhere in the app. */
    invalidate(...datasets: string[]) {
      act(() => {
        setVersions?.((prev) => {
          const next = { ...prev };
          const affected = new Set<string>();
          for (const ds of datasets) {
            affected.add(ds);
            for (const dep of dependents[ds] ?? []) affected.add(dep);
          }
          for (const ds of affected) next[ds] = (next[ds] ?? 0) + 1;
          return next;
        });
      });
    },
  };
}

describe('a mounted consumer refetches when another view mutates its dataset', () => {
  it('refetches without remounting, without a branch change and without a tab change', () => {
    const fetchSpy = vi.fn();
    const { Harness, invalidate } = makeHarness();

    function Consumer() {
      const version = useDatasetVersion('academic');
      React.useEffect(() => { fetchSpy(); }, [version]);
      return React.createElement('div', null, 'consumer');
    }

    render(el(Harness, null, el(Consumer)));
    expect(fetchSpy).toHaveBeenCalledTimes(1); // initial load

    invalidate('academic');
    expect(fetchSpy).toHaveBeenCalledTimes(2); // no F5 required

    invalidate('academic');
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('does NOT refetch when an unrelated dataset changes', () => {
    const fetchSpy = vi.fn();
    const { Harness, invalidate } = makeHarness();

    function Consumer() {
      const version = useDatasetVersion('academic');
      React.useEffect(() => { fetchSpy(); }, [version]);
      return null;
    }

    render(el(Harness, null, el(Consumer)));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    invalidate('finance'); // unrelated — must not cost a request
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a failed mutation invalidates nothing, so the consumer does not refetch', () => {
    const fetchSpy = vi.fn();
    const { Harness } = makeHarness();

    function Writer() {
      const invalidate = useInvalidate();
      const onClick = async () => {
        try {
          throw new Error('403 Forbidden');
        } catch {
          return; // never reaches invalidate()
        }
        invalidate('academic');
      };
      return React.createElement('button', { onClick }, 'save');
    }
    function Consumer() {
      const version = useDatasetVersion('academic');
      React.useEffect(() => { fetchSpy(); }, [version]);
      return null;
    }

    render(el(Harness, null, el(Writer), el(Consumer)));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    act(() => { container.querySelector('button')!.click(); });
    expect(fetchSpy).toHaveBeenCalledTimes(1); // unchanged
  });

  it('a mutation performed by another component reaches the consumer', () => {
    const fetchSpy = vi.fn();
    const { Harness } = makeHarness();

    function Writer() {
      const invalidate = useInvalidate();
      return React.createElement('button', { onClick: () => invalidate('academic') }, 'mutate');
    }
    function Consumer() {
      const version = useDatasetVersion('academic');
      React.useEffect(() => { fetchSpy(); }, [version]);
      return null;
    }

    render(el(Harness, null, el(Writer), el(Consumer)));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    act(() => { container.querySelector('button')!.click(); });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('the dependency graph propagates to derived datasets', () => {
  const GRAPH = { academic: ['classes', 'sessions', 'attendance'] } as const;

  it('an academic change refetches the classes consumer', () => {
    const classesSpy = vi.fn();
    const { Harness, invalidate } = makeHarness(GRAPH);

    function ClassesConsumer() {
      const version = useDatasetVersion('classes');
      React.useEffect(() => { classesSpy(); }, [version]);
      return null;
    }

    render(el(Harness, null, el(ClassesConsumer)));
    expect(classesSpy).toHaveBeenCalledTimes(1);

    invalidate('academic'); // mutation happened in Academic Setup
    expect(classesSpy).toHaveBeenCalledTimes(2);
  });

  it('an unrelated dataset does not fan out through the graph', () => {
    const classesSpy = vi.fn();
    const { Harness, invalidate } = makeHarness(GRAPH);

    function ClassesConsumer() {
      const version = useDatasetVersion('classes');
      React.useEffect(() => { classesSpy(); }, [version]);
      return null;
    }

    render(el(Harness, null, el(ClassesConsumer)));
    invalidate('finance');
    expect(classesSpy).toHaveBeenCalledTimes(1);
  });
});

describe('out-of-order responses cannot overwrite newer server truth', () => {
  it('only the newest request may commit', async () => {
    const committed: string[] = [];
    const resolvers: Array<(value: string) => void> = [];
    const { Harness, invalidate } = makeHarness();

    function Consumer() {
      useVersionedFetch(
        async (isCurrent) => {
          const value = await new Promise<string>((resolve) => { resolvers.push(resolve); });
          if (!isCurrent()) return; // stale response is discarded
          committed.push(value);
        },
        ['academic']
      );
      return null;
    }

    render(el(Harness, null, el(Consumer)));
    invalidate('academic'); // second fetch starts before the first resolves

    expect(resolvers).toHaveLength(2);

    // Resolve NEWEST first, then the stale one — the classic race.
    await act(async () => { resolvers[1]('new-branch-data'); });
    await act(async () => { resolvers[0]('old-branch-data'); });

    expect(committed).toEqual(['new-branch-data']);
    expect(committed).not.toContain('old-branch-data');
  });

  it('a response that arrives after unmount never commits', async () => {
    const committed: string[] = [];
    let resolveFetch: ((v: string) => void) | null = null;
    const { Harness } = makeHarness();

    function Consumer() {
      useVersionedFetch(
        async (isCurrent) => {
          const value = await new Promise<string>((r) => { resolveFetch = r; });
          if (!isCurrent()) return;
          committed.push(value);
        },
        ['academic']
      );
      return null;
    }

    render(el(Harness, null, el(Consumer)));
    act(() => root.unmount());
    await act(async () => { resolveFetch?.('late'); });

    expect(committed).toEqual([]);
    // Re-establish a root so the shared afterEach cleanup stays valid.
    root = createRoot(container);
  });
});

describe('branch isolation', () => {
  it('a branch switch refetches every subscribed consumer', () => {
    const academicSpy = vi.fn();
    const financeSpy = vi.fn();
    const { Harness, invalidate } = makeHarness();

    function A() {
      const v = useDatasetVersion('academic');
      React.useEffect(() => { academicSpy(); }, [v]);
      return null;
    }
    function F() {
      const v = useDatasetVersion('finance');
      React.useEffect(() => { financeSpy(); }, [v]);
      return null;
    }

    render(el(Harness, null, el(A), el(F)));
    expect(academicSpy).toHaveBeenCalledTimes(1);
    expect(financeSpy).toHaveBeenCalledTimes(1);

    // reloadAll() bumps every dataset on a branch switch.
    invalidate('academic', 'finance');
    expect(academicSpy).toHaveBeenCalledTimes(2);
    expect(financeSpy).toHaveBeenCalledTimes(2);
  });

  it('rapid A→B→A switching leaves the consumer on the newest scope only', async () => {
    const committed: string[] = [];
    const resolvers: Array<(v: string) => void> = [];
    const { Harness, invalidate } = makeHarness();

    function Consumer() {
      useVersionedFetch(
        async (isCurrent) => {
          const value = await new Promise<string>((r) => { resolvers.push(r); });
          if (!isCurrent()) return;
          committed.push(value);
        },
        ['academic']
      );
      return null;
    }

    render(el(Harness, null, el(Consumer))); // branch A
    invalidate('academic');                  // → B
    invalidate('academic');                  // → A again, rapidly

    expect(resolvers).toHaveLength(3);
    // Everything lands out of order; only the last generation may win.
    await act(async () => { resolvers[1]('B'); });
    await act(async () => { resolvers[0]('A-first'); });
    await act(async () => { resolvers[2]('A-latest'); });

    expect(committed).toEqual(['A-latest']);
  });
});
