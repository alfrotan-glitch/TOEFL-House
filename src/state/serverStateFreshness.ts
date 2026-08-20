/**
 * Canonical server-state freshness context.
 * ============================================================================
 * `useApiStore()` is a plain hook, instantiated exactly once in `App.tsx`, and
 * its value is prop-drilled to the views that need it. Calling the hook again
 * from a leaf component would build a SECOND, independent store — the very
 * duplication this module exists to remove — so the freshness surface is
 * published through a context instead.
 *
 * Deliberately narrow: this context carries only the invalidation authority and
 * the dataset version map, never the datasets themselves. Data keeps flowing
 * through the existing props, so nothing about ownership or authorization
 * changes; components merely gain the ability to (a) declare that a dataset
 * changed and (b) notice when someone else declared it.
 *
 * THE CONTRACT
 *
 *   Writer, after a mutation has SUCCEEDED:
 *       await api.post('/academic/rooms', body);
 *       invalidate('academic');
 *
 *   Reader, for data it fetches and holds itself:
 *       const version = useDatasetVersion('academic');
 *       useEffect(() => { void load(); }, [load, version]);
 *
 * A failed mutation must never call `invalidate` — nothing changed on the
 * server, so nothing should refetch. The version counters are monotonic, which
 * lets a reader's request-generation guard recognise a late response from a
 * superseded fetch (see `useVersionedFetch`).
 */
import React, { createContext, createElement, useContext, useEffect, useMemo, useRef } from 'react';

export interface ServerStateFreshness {
  /** Declare that one or more canonical datasets changed on the server. */
  invalidate: (...datasets: string[]) => void;
  /** Monotonic version per dataset. Absent key means "never invalidated". */
  datasetVersion: Record<string, number>;
}

/**
 * Default is inert rather than throwing: a component rendered outside the
 * provider (a unit test, a storybook harness) must still function, just without
 * cross-view invalidation. Throwing here would turn a freshness concern into a
 * crash.
 */
const FALLBACK: ServerStateFreshness = { invalidate: () => {}, datasetVersion: {} };

const FreshnessContext = createContext<ServerStateFreshness>(FALLBACK);

export function ServerStateFreshnessProvider({
  value,
  children,
}: {
  value: ServerStateFreshness;
  children: React.ReactNode;
}) {
  // `invalidate` is a stable useCallback in the store and `datasetVersion` only
  // changes when something is actually invalidated, so memoising on those two
  // keeps consumers from re-rendering on unrelated store updates.
  const memo = useMemo(
    () => ({ invalidate: value.invalidate, datasetVersion: value.datasetVersion }),
    [value.invalidate, value.datasetVersion]
  );
  // `createElement` rather than JSX so this module stays a plain .ts file and is
  // importable by the server-side test runner, which does not enable JSX.
  return createElement(FreshnessContext.Provider, { value: memo }, children);
}

/** The invalidation authority. Call only after a mutation succeeded. */
export function useInvalidate(): (...datasets: string[]) => void {
  return useContext(FreshnessContext).invalidate;
}

/**
 * Subscribe to one or more datasets. The returned number changes whenever any
 * of them is invalidated; put it in a fetch effect's dependency list.
 */
export function useDatasetVersion(...datasets: string[]): number {
  const { datasetVersion } = useContext(FreshnessContext);
  let total = 0;
  for (const ds of datasets) total += datasetVersion[ds] ?? 0;
  return total;
}

/**
 * Run `load` on mount, whenever `deps` change, and whenever any subscribed
 * dataset is invalidated — with out-of-order protection built in.
 *
 * `load` receives an `isCurrent()` predicate and must consult it before writing
 * state. Each run takes a monotonically increasing ticket; only the newest
 * ticket may commit. That is what stops a slow response for branch A from
 * landing after a fast response for branch B and repainting the old scope.
 *
 * Cancellation is expressed this way rather than with AbortController because
 * a request that is already in flight still has to be *ignored* even when it
 * cannot be aborted (e.g. it completed during the switch). Ignoring the result
 * is the property that actually matters for correctness.
 */
export function useVersionedFetch(
  load: (isCurrent: () => boolean) => void | Promise<void>,
  datasets: string[],
  deps: React.DependencyList = []
): void {
  const version = useDatasetVersion(...datasets);
  const seqRef = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const ticket = ++seqRef.current;
    const isCurrent = () => ticket === seqRef.current;
    void loadRef.current(isCurrent);
    return () => {
      // Bumping on cleanup retires the in-flight request: whatever it was doing
      // can no longer satisfy `isCurrent()` and therefore cannot commit.
      //
      // The lint rule warns that `seqRef.current` may have changed by cleanup
      // time. That is precisely the intent here: this ref is a request
      // generation counter, not a DOM handle, and the cleanup must act on the
      // CURRENT value so a newer run is never retired by an older cleanup.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      seqRef.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, ...deps]);
}
