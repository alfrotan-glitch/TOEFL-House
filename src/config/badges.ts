import type { NavBadgeTone } from '../types/navigation';

/**
 * Badge tone classes optimized for premium dark themes (Midnight Glass).
 * Uses translucent backgrounds and subtle rings for a modern, enterprise look.
 */
export const BADGE_TONE_CLASS: Record<NavBadgeTone, string> = {
  emerald: 'bg-emerald-500/15 text-emerald-400 ring-1 ring-inset ring-emerald-500/20',
  sky: 'bg-sky-500/15 text-sky-400 ring-1 ring-inset ring-sky-500/20',
  violet: 'bg-violet-500/15 text-violet-400 ring-1 ring-inset ring-violet-500/20',
  pink: 'bg-pink-500/15 text-pink-400 ring-1 ring-inset ring-pink-500/20',
  amber: 'bg-amber-500/15 text-amber-400 ring-1 ring-inset ring-amber-500/20',
  rose: 'bg-rose-500/15 text-rose-400 ring-1 ring-inset ring-rose-500/20',
};