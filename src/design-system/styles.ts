/**
 * The component layer of the design system.
 * ============================================================================
 * Design TOKENS already existed (`@theme` in src/index.css). What was missing
 * was anything built on them, so every screen re-spelled the same patterns.
 * A form label existed in four variants across the codebase:
 *
 *     block text-slate-600 mb-1 font-medium      (39 uses)
 *     block text-slate-600 font-medium           (30 uses)
 *     block text-slate-600 font-medium mb-1      (22 uses)
 *     block text-slate-600 font-semibold mb-1    (17 uses)
 *
 * Four spellings of one concept is not a styling preference; it is the same
 * duplicate-authority problem as anywhere else, and it is why labels drift out
 * of alignment between screens.
 *
 * DIRECTION. Every recipe here uses LOGICAL properties (`ms-`/`me-`,
 * `ps-`/`pe-`, `text-start`/`text-end`, `start-`/`end-`, `border-s`/`border-e`)
 * so the interface mirrors in Persian/Dari without a single override. The
 * design-system audit fails the build if a physical direction utility appears
 * in application code.
 */

/** Joins class names, dropping falsy entries so callers can pass conditionals. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

// ── Typography ──────────────────────────────────────────────────────────────

export const text = {
  /** A field label above an input. */
  label: 'block text-slate-600 font-medium mb-1',
  /** Supporting text under a field or metric. */
  hint: 'text-xs text-slate-500 mt-1',
  /** The smallest supporting text — timestamps, counts, provenance. */
  meta: 'text-[10px] text-slate-400',
  /** A metric or emphasised value. */
  value: 'text-sm font-extrabold text-slate-900',
  /** A section heading inside a panel. */
  sectionTitle: 'text-sm font-bold text-slate-800',
  /** Validation failure text attached to a field. */
  error: 'text-xs text-rose-600 mt-1',
} as const;

// ── Layout ──────────────────────────────────────────────────────────────────

export const layout = {
  /** Icon beside text, or any tight inline pairing. */
  inline: 'flex items-center gap-2',
  /** A looser inline grouping. */
  inlineWide: 'flex items-center gap-3',
  /** Label on one side, value on the other — mirrors correctly by itself. */
  spread: 'flex justify-between',
  /** Vertical rhythm inside a panel. */
  stack: 'space-y-4',
} as const;

// ── Surfaces ────────────────────────────────────────────────────────────────

export const surface = {
  card: 'bg-white border border-slate-200 rounded-xl p-4',
  panel: 'bg-white border border-slate-200 rounded-2xl shadow-sm',
  subtle: 'bg-slate-50 border border-slate-200 rounded-lg',
} as const;

// ── Controls ────────────────────────────────────────────────────────────────

export const control = {
  /** The standard text/number/date input. */
  input:
    'w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-start ' +
    'focus:outline-none focus:ring-2 focus:ring-brand-400 focus:border-transparent ' +
    'disabled:opacity-60 disabled:cursor-not-allowed',
  /** A compact input used inside dense tables. */
  inputCompact: 'border border-slate-200 rounded-lg px-2 py-1.5 text-start',
  select:
    'w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-start ' +
    'focus:outline-none focus:ring-2 focus:ring-brand-400',
} as const;

export const button = {
  primary:
    'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 font-semibold ' +
    'bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-60 disabled:cursor-not-allowed ' +
    'focus:outline-none focus:ring-2 focus:ring-brand-400 focus:ring-offset-2',
  secondary:
    'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 font-semibold ' +
    'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 ' +
    'disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-brand-400',
  /** Destructive actions are visually distinct so they cannot be hit by habit. */
  danger:
    'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 font-semibold ' +
    'bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-60 disabled:cursor-not-allowed ' +
    'focus:outline-none focus:ring-2 focus:ring-rose-400 focus:ring-offset-2',
  ghost:
    'inline-flex items-center justify-center gap-2 rounded-lg px-3 py-1.5 ' +
    'text-slate-600 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-400',
} as const;

// ── Status ──────────────────────────────────────────────────────────────────

export const badge = {
  neutral: 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold bg-slate-100 text-slate-700',
  success: 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold bg-emerald-100 text-emerald-700',
  warning: 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold bg-amber-100 text-amber-700',
  danger: 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold bg-rose-100 text-rose-700',
} as const;

// ── Table ───────────────────────────────────────────────────────────────────

export const table = {
  /**
   * Header cells align to the start of the line, so a Persian table is
   * end-aligned without a second stylesheet.
   */
  headCell: 'text-start text-[11px] font-semibold uppercase tracking-wide text-slate-500 px-3 py-2',
  cell: 'px-3 py-2 text-start align-middle',
  /** Numeric columns align to the end in both directions. */
  numericCell: 'px-3 py-2 text-end align-middle tabular-nums',
} as const;
