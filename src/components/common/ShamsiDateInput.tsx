/**
 * Shamsi date input.
 * ============================================================================
 * Accepts a Shamsi date from the user and emits the Gregorian `YYYY-MM-DD`
 * string the API and database expect, so callers can drop this in wherever a
 * `<input type="date">` was used without changing their submit logic.
 *
 * Validation is real: month 1–12, and day bounded by the ACTUAL length of that
 * Shamsi month (Hut has 29 or 30 days depending on the leap year), so an
 * impossible date can never be converted into a plausible-looking Gregorian one.
 */
import React, { useMemo, useState } from 'react';
import {
  AFGHAN_MONTHS_FA,
  isoToJalali,
  jalaliMonthLength,
  jalaliToIso,
  todayJalali,
  toLatinDigits,
} from '../../utils/jalali';

interface ShamsiDateInputProps {
  /** Gregorian 'YYYY-MM-DD' currently held by the form (or '' when empty). */
  value: string;
  /** Receives the Gregorian 'YYYY-MM-DD', or '' when cleared/incomplete. */
  onChange: (gregorianIso: string) => void;
  label?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
}

const selectCls =
  'bg-slate-50 border border-slate-200 rounded-lg px-2 py-2 text-sm font-semibold disabled:opacity-60';

export function ShamsiDateInput({
  value,
  onChange,
  label,
  required = false,
  disabled = false,
  className = '',
}: ShamsiDateInputProps) {
  const fallbackYear = useMemo(() => todayJalali().jy, []);

  // Local draft state exists so the user can pick day/month/year in any order
  // without the value being cleared mid-edit. It is derived from `value`
  // during render (rather than in an effect) so a form reset or a freshly
  // loaded record is reflected immediately, with no extra render pass.
  const [draft, setDraft] = useState<{ source: string; jy: string; jm: string; jd: string }>(() => {
    const p = value ? isoToJalali(value) : null;
    return { source: value, jy: p ? String(p.jy) : '', jm: p ? String(p.jm) : '', jd: p ? String(p.jd) : '' };
  });

  let { jy, jm, jd } = draft;
  if (draft.source !== value) {
    const p = value ? isoToJalali(value) : null;
    jy = p ? String(p.jy) : '';
    jm = p ? String(p.jm) : '';
    jd = p ? String(p.jd) : '';
    setDraft({ source: value, jy, jm, jd });
  }

  const setJy = (v: string) => setDraft((d) => ({ ...d, source: value, jy: v }));
  const setJm = (v: string) => setDraft((d) => ({ ...d, source: value, jm: v }));
  const setJd = (v: string) => setDraft((d) => ({ ...d, source: value, jd: v }));

  const maxDay = useMemo(() => {
    const y = Number(toLatinDigits(jy));
    const m = Number(toLatinDigits(jm));
    if (!y || !m || m < 1 || m > 12) return 31;
    return jalaliMonthLength(y, m);
  }, [jy, jm]);

  const emit = (nextY: string, nextM: string, nextD: string) => {
    const y = Number(toLatinDigits(nextY));
    const m = Number(toLatinDigits(nextM));
    const d = Number(toLatinDigits(nextD));
    if (!y || !m || !d) return onChange('');
    if (m < 1 || m > 12) return onChange('');
    if (d < 1 || d > jalaliMonthLength(y, m)) return onChange('');
    onChange(jalaliToIso(y, m, d));
  };

  const years = useMemo(() => {
    const base = fallbackYear;
    const list: number[] = [];
    for (let y = base + 2; y >= base - 60; y--) list.push(y);
    return list;
  }, [fallbackYear]);

  return (
    <div className={className}>
      {label && (
        <label className="block text-slate-600 font-semibold mb-1 text-xs">
          {label} <span className="text-slate-400 font-normal">(هجری شمسی)</span>
        </label>
      )}
      <div className="flex items-center gap-2">
        <select
          aria-label="روز"
          value={jd}
          disabled={disabled}
          required={required}
          onChange={(e) => { setJd(e.target.value); emit(jy, jm, e.target.value); }}
          className={`${selectCls} w-20`}
        >
          <option value="">روز</option>
          {Array.from({ length: maxDay }, (_, i) => i + 1).map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        <select
          aria-label="ماه"
          value={jm}
          disabled={disabled}
          required={required}
          onChange={(e) => {
            setJm(e.target.value);
            // Clamp the day if the new month is shorter (e.g. 31 → Hut).
            const y = Number(toLatinDigits(jy)) || fallbackYear;
            const m = Number(e.target.value);
            const len = m >= 1 && m <= 12 ? jalaliMonthLength(y, m) : 31;
            const clamped = Number(toLatinDigits(jd)) > len ? String(len) : jd;
            if (clamped !== jd) setJd(clamped);
            emit(jy, e.target.value, clamped);
          }}
          className={`${selectCls} flex-1 min-w-[7rem]`}
        >
          <option value="">ماه</option>
          {AFGHAN_MONTHS_FA.map((name, i) => (
            <option key={name} value={i + 1}>{name}</option>
          ))}
        </select>
        <select
          aria-label="سال"
          value={jy}
          disabled={disabled}
          required={required}
          onChange={(e) => { setJy(e.target.value); emit(e.target.value, jm, jd); }}
          className={`${selectCls} w-24`}
        >
          <option value="">سال</option>
          {years.map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
      </div>
      {value && (
        <p className="text-[10px] text-slate-400 mt-1">میلادی: {value}</p>
      )}
    </div>
  );
}

export default ShamsiDateInput;
