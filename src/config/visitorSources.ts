/**
 * Lead source vocabulary — one list, mirroring the server enum.
 *
 * `VISITOR_SOURCES` in server/src/routes/visitors.routes.ts accepts nine
 * values. The UI knew four, so the filter could not isolate walk_in, referral,
 * event, organic or facebook leads (101 of 250 in the audit sample), and the
 * badge map's `|| SOURCE_BADGES.other` fallback DISPLAYED all of them as
 * "Other". Worse, `friend` was labelled "Referral" while the genuine `referral`
 * source showed as "Other" — two different channels reported under one name.
 *
 * Keeping the vocabulary in one module is what stops the two lists drifting
 * again. If the server enum changes, this file is the single place to follow.
 */

/** Every source the server accepts, in the order the dropdown should show. */
export const VISITOR_SOURCE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'walk_in', label: 'Walk-in' },
  { value: 'referral', label: 'Referral' },
  { value: 'friend', label: 'Friend / word of mouth' },
  { value: 'social', label: 'Social media' },
  { value: 'facebook', label: 'Facebook' },
  { value: 'ads', label: 'Paid ads' },
  { value: 'event', label: 'Event' },
  { value: 'organic', label: 'Organic / search' },
  { value: 'other', label: 'Other' },
];

/** Lookup for rendering a stored value. Unknown values fall back to the raw code. */
export const SOURCE_LABELS: Record<string, string> = Object.fromEntries(
  VISITOR_SOURCE_OPTIONS.map((o) => [o.value, o.label])
);
