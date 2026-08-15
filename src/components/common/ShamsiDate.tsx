/**
 * Shamsi date display primitives.
 * ============================================================================
 * The database stores Gregorian `YYYY-MM-DD`; these components convert at the
 * point of display. Per the agreed transition policy the Shamsi date is
 * primary and the Gregorian original is shown alongside in smaller type, so
 * operators can cross-check against older paperwork without ambiguity.
 */
import React from 'react';
import { formatJalali, formatJalaliLatin, type JalaliFormat } from '../../utils/jalali';

interface ShamsiDateProps {
  /** Stored Gregorian date, e.g. '2026-08-15' or an ISO datetime. */
  value: string | null | undefined;
  format?: JalaliFormat;
  /** Show the Gregorian original next to the Shamsi date. Default: true. */
  showGregorian?: boolean;
  /** Latin digits/月 names instead of Persian script (for exports/print). */
  latin?: boolean;
  className?: string;
}

/**
 * Renders a stored Gregorian date as Shamsi, with the Gregorian value in a
 * muted span beside it.
 */
export function ShamsiDate({
  value,
  format = 'long',
  showGregorian = true,
  latin = false,
  className = '',
}: ShamsiDateProps) {
  const shamsi = latin ? formatJalaliLatin(value, format) : formatJalali(value, format);
  if (shamsi === '—') return <span className={className}>—</span>;
  const gregorian = String(value).slice(0, 10);
  return (
    <span className={className} title={`${shamsi} — میلادی: ${gregorian}`}>
      <span className="font-semibold">{shamsi}</span>
      {showGregorian && <span className="text-slate-400 font-normal text-[0.85em] ms-1.5">({gregorian})</span>}
    </span>
  );
}

/**
 * Compact variant for dense tables: Shamsi only, with the Gregorian date in
 * the tooltip so the information is still one hover away.
 */
export function ShamsiDateCompact({ value, format = 'short', latin = false, className = '' }: ShamsiDateProps) {
  const shamsi = latin ? formatJalaliLatin(value, format) : formatJalali(value, format);
  if (shamsi === '—') return <span className={className}>—</span>;
  return (
    <span className={className} title={`میلادی: ${String(value).slice(0, 10)}`}>
      {shamsi}
    </span>
  );
}

export default ShamsiDate;
