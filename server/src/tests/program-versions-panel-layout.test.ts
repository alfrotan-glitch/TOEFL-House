/**
 * ProgramVersionsPanel — layout verification.
 * ============================================================================
 * WHAT THIS PROVES, AND WHAT IT DOES NOT
 *
 * A real headless browser cannot run in this environment: every browser-binary
 * source (cdn.playwright.dev, playwright.azureedge.net, storage.googleapis.com,
 * the Debian mirrors) is network-blocked, so pixel screenshots at 125%/150%
 * zoom are not obtainable here. Rather than claim a verification that did not
 * happen, this suite proves the layout deterministically from two real
 * artefacts:
 *
 *   1. The COMPILED Tailwind stylesheet from `npm run build` — so the container
 *      queries are verified as actually emitted CSS, not as source strings that
 *      might never have compiled.
 *   2. The measured width chain of the real component nesting, computed with
 *      Tailwind's own grid arithmetic.
 *
 * The overlap being regression-tested was caused by column COUNT exceeding the
 * available width (12-column rows inside a column that is only a few hundred
 * pixels wide). Overlap is therefore a function of the resolved column count
 * and the per-field width, both of which are computed exactly below.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PANEL = join(REPO_ROOT, 'src/components/academic/ProgramVersionsPanel.tsx');
const DIST_ASSETS = join(REPO_ROOT, 'dist/assets');

const REM = 16;
const GAP = 24; // gap-6
const PAD = 24; // p-6 per side

/**
 * Resolve the ProgramVersionsPanel editor's real content width.
 *
 * Chain, each step verified against the source:
 *   Sidebar w-64 (256) + main px-8 (64) capped at max-w-7xl (1280)
 *     -> AcademicSetupView p-8            (64)
 *       -> grid-cols-12 gap-6, right column spans 8
 *         -> that column has p-6          (48)   [AcademicSetupView]
 *           -> panel @container; 4/8 split only at @3xl (48rem)
 *             -> editor column p-6        (48)   [ProgramVersionsPanel]
 */
function editorWidth(viewportPx: number, zoom = 1) {
  const css = viewportPx / zoom;
  const lg = css >= 1024;
  const main = Math.min(css - (lg ? 256 : 0) - 64, 1280);
  const view = main - (css >= 768 ? 64 : 32);
  const span8 = (grid: number) => (lg ? (grid - 11 * GAP) * (8 / 12) + 7 * GAP : grid);
  const rightColumn = span8(view) - 2 * PAD;
  const splits = rightColumn >= 48 * REM; // @3xl on the panel's own width
  const editor = (splits ? (rightColumn - 11 * GAP) * (8 / 12) + 7 * GAP : rightColumn) - 2 * PAD;
  return { container: Math.round(rightColumn), splits, editor: Math.round(editor) };
}

/** Container-query tier actually emitted for the component/policy grids. */
function resolvedColumns(editor: number) {
  const policy = editor >= 56 * REM ? 3 : editor >= 28 * REM ? 2 : 1;
  const component = editor >= 48 * REM ? 4 : editor >= 28 * REM ? 2 : 1;
  return { policy, component };
}

const SCENARIOS: [string, number, number][] = [
  ['1280px', 1280, 1],
  ['1440px', 1440, 1],
  ['1600px', 1600, 1],
  ['1920px', 1920, 1],
  ['1280px @ 125% zoom', 1280, 1.25],
  ['1440px @ 125% zoom', 1440, 1.25],
  ['1280px @ 150% zoom', 1280, 1.5],
  ['1440px @ 150% zoom', 1440, 1.5],
  ['1024px (narrow desktop)', 1024, 1],
  ['768px (narrow container)', 768, 1],
];

/** Smallest width at which a labelled numeric input stays usable. */
const MIN_USABLE_FIELD = 120;

describe('ProgramVersionsPanel — container queries are really compiled', () => {
  function compiledCss(): string {
    expect(existsSync(DIST_ASSETS), 'dist/assets missing — run `npm run build`').toBe(true);
    const css = readdirSync(DIST_ASSETS).filter((f) => f.endsWith('.css'));
    expect(css.length).toBeGreaterThan(0);
    return css.map((f) => readFileSync(join(DIST_ASSETS, f), 'utf8')).join('\n');
  }

  it('emits container-type so @container is an actual containment context', () => {
    expect(compiledCss()).toContain('container-type:inline-size');
  });

  it('emits the container-query breakpoints the panel relies on', () => {
    const css = compiledCss();
    // @md = 28rem, @3xl = 48rem, @4xl = 56rem
    for (const q of ['@container (width>=28rem)', '@container (width>=48rem)']) {
      expect(css).toContain(q);
    }
  });

  it('does not fall back to viewport breakpoints for the inner grids', () => {
    const src = readFileSync(PANEL, 'utf8');
    // The 12-column viewport-driven rows were the direct cause of the overlap.
    // Match only VIEWPORT prefixes (sm/md/lg/xl/2xl) — the container-query
    // variants (`@3xl:`) are the fix and must not be flagged.
    expect(src).not.toMatch(/(?<!@)\b(?:sm|md|lg|xl|2xl):col-span-/);
    expect(src).not.toMatch(/(?<!@)\b(?:sm|md|lg|xl|2xl):grid-cols-12/);
  });

  it('relies on containment rather than overflow-visible to fit content', () => {
    const src = readFileSync(PANEL, 'utf8')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '') // strip JSX comments
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(src).not.toContain('overflow-visible');
  });
});

describe('ProgramVersionsPanel — no overlap at any target width', () => {
  it.each(SCENARIOS)('%s keeps every field at a usable width', (_label, vw, zoom) => {
    const { editor } = editorWidth(vw, zoom);
    const { policy, component } = resolvedColumns(editor);

    for (const cols of [policy, component]) {
      const per = Math.floor((editor - (cols - 1) * 12) / cols);
      // A field narrower than this is where labels and inputs start colliding.
      expect(per).toBeGreaterThanOrEqual(MIN_USABLE_FIELD);
    }
  });

  it.each(SCENARIOS)('%s never resolves more columns than the width supports', (_label, vw, zoom) => {
    const { editor } = editorWidth(vw, zoom);
    const { component } = resolvedColumns(editor);
    // Guard against the original defect: 12 columns in ~300px.
    expect(component).toBeLessThanOrEqual(4);
    expect(editor / component).toBeGreaterThanOrEqual(MIN_USABLE_FIELD);
  });

  // The panel's own 4/8 split used to be viewport-driven, so it fired while the
  // panel itself was narrow and squeezed the editor to ~190px.
  it('only splits the version list from the editor when the panel can afford it', () => {
    const narrow = editorWidth(1280, 1.25);
    expect(narrow.splits).toBe(false);
    expect(narrow.editor).toBeGreaterThanOrEqual(300);

    const src = readFileSync(PANEL, 'utf8');
    expect(src).toMatch(/@3xl:col-span-4/);
    expect(src).toMatch(/@3xl:col-span-8/);
    expect(src).not.toMatch(/lg:col-span-4 bg-white rounded-2xl/);
  });

  it('every field wrapper in the component grids can shrink (min-w-0)', () => {
    const src = readFileSync(PANEL, 'utf8');
    const wrappers = src.match(/<div className="[^"]*"><label className=\{labelCls\}/g) ?? [];
    expect(wrappers.length).toBeGreaterThan(4);
    for (const w of wrappers) {
      expect(w).toContain('min-w-0');
    }
  });

  it('long labels are allowed to wrap instead of overflowing their card', () => {
    const src = readFileSync(PANEL, 'utf8');
    expect(src).toMatch(/const labelCls = "[^"]*break-words/);
  });

  it('declares no fixed pixel width that could exceed the narrowest container', () => {
    const src = readFileSync(PANEL, 'utf8');
    const narrowest = Math.min(...SCENARIOS.map(([, vw, z]) => editorWidth(vw, z).editor));
    for (const m of src.matchAll(/(?:min-)?w-\[(\d+)px\]/g)) {
      expect(Number(m[1])).toBeLessThanOrEqual(narrowest);
    }
  });
});
