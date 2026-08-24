/**
 * The canonical monetary boundary — property-based and inventory coverage.
 * ============================================================================
 * WHY THIS FILE EXISTS
 *
 * Seven audit passes kept finding the SAME defect wearing different clothes:
 * a money field validated with a comparison instead of a parse, where a
 * non-number fails OPEN because every comparison against NaN is false.
 *
 *     Number('abc') < 0        === false   -> negative check passes
 *     999999 > (NaN)           === false   -> budget check passes
 *     Number('') === 0                     -> empty form field becomes free
 *
 * Fixing instances one at a time was not converging, so pass 14 attacked it
 * structurally instead:
 *
 *   1. an inventory of every money-typed request field in every route;
 *   2. one canonical boundary (`assertMoney`) that PARSES rather than coerces;
 *   3. this file, which pins the boundary's behaviour exhaustively and asserts
 *      the inventory stays routed through it.
 *
 * The boundary itself was found to be part of the problem: it delegated to
 * `Number(value)`, so '', '   ', null, [], [5], true and '0x10' were all
 * silently accepted as amounts. That is fixed and locked down below.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertMoney } from '../utils/money.js';

const routesDir = path.join(path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..'), 'routes');

/** Deterministic pseudo-random generator so a failure is always reproducible. */
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('assertMoney parses rather than coerces', () => {
  it('rejects every non-numeric JavaScript value that Number() would coerce', () => {
    // Each of these used to return a plausible amount instead of an error.
    const coercible: Array<[unknown, string]> = [
      ['', 'empty string'],
      ['   ', 'whitespace only'],
      [null, 'null'],
      [undefined, 'undefined'],
      [[], 'empty array'],
      [[5], 'single-element array'],
      [true, 'true'],
      [false, 'false'],
      ['0x10', 'hex literal'],
      ['1e3', 'exponent notation'],
      ['1_000', 'numeric separator'],
      [{}, 'object'],
      ['12,50', 'comma decimal'],
      ['١٢٣', 'non-ASCII digits'],
      ['Infinity', 'the word Infinity'],
      ['-', 'lone sign'],
    ];
    for (const [value, label] of coercible) {
      expect(() => assertMoney(value, 'amount'), `${label} must be refused`).toThrow();
    }
  });

  it('rejects non-finite numbers', () => {
    // 1e309 overflows to Infinity; written via Number() so the literal does not
    // trip eslint's no-loss-of-precision while still exercising the overflow
    // value a client can actually send in JSON.
    const overflow = Number('1e309');
    for (const v of [NaN, Infinity, -Infinity, overflow, -overflow]) {
      expect(() => assertMoney(v, 'amount')).toThrow(/finite number/i);
    }
  });

  it('rejects negatives unless explicitly allowed', () => {
    expect(() => assertMoney(-0.01, 'amount')).toThrow(/negative/i);
    expect(() => assertMoney('-1', 'amount')).toThrow(/negative/i);
    // Contra rows (refunds, voids) legitimately carry a negative amount.
    expect(assertMoney(-500, 'amount', { allowNegative: true })).toBe(-500);
  });

  it('rejects values beyond safe monetary precision', () => {
    for (const v of [1e15, -1e15, Number.MAX_SAFE_INTEGER]) {
      expect(() => assertMoney(v, 'amount', { allowNegative: true })).toThrow(/precision/i);
    }
  });

  it('accepts the values a real operator types', () => {
    expect(assertMoney(0, 'amount')).toBe(0);
    expect(assertMoney(1500, 'amount')).toBe(1500);
    expect(() => assertMoney('750.25', 'amount')).toThrow(/whole number/i);
    expect(assertMoney(' 42 ', 'amount')).toBe(42);
    expect(() => assertMoney('.5', 'amount')).toThrow(/whole number/i);
    expect(assertMoney('6000.', 'amount')).toBe(6000);
  });

  it('normalises to the canonical whole afghani and never returns -0', () => {
    expect(() => assertMoney(10.006, 'amount')).toThrow(/whole number/i);
    expect(() => assertMoney(0.001, 'amount')).toThrow(/whole number/i);
    expect(Object.is(assertMoney(-0, 'amount', { allowNegative: true }), -0)).toBe(false);
  });

  it('PROPERTY: whatever it returns is always a safe, finite, whole number', () => {
    // 2,000 pseudo-random inputs mixing valid and hostile shapes. The boundary
    // may reject anything it likes, but it must never RETURN a value that
    // breaks the invariant — that is what downstream arithmetic relies on.
    const rng = makeRng(20260817);
    const shapes = [
      () => Math.floor(rng() * 1e6),
      () => -Math.floor(rng() * 1e6),
      () => rng() * 1e16,
      () => String(Math.floor(rng() * 1000)),
      () => `${Math.floor(rng() * 1000)}.${Math.floor(rng() * 1000)}`, // fractional: must be refused
      () => (rng() > 0.5 ? NaN : Infinity),
      () => ['abc', '', '   ', '0x1f', '1e5', null, undefined, [], {}, true][Math.floor(rng() * 10)],
    ];
    let returned = 0;
    for (let i = 0; i < 2000; i += 1) {
      const value = shapes[Math.floor(rng() * shapes.length)]();
      let out: number;
      try {
        out = assertMoney(value, 'amount', { allowNegative: true });
      } catch {
        continue; // rejection is always an acceptable outcome
      }
      returned += 1;
      expect(Number.isFinite(out), `returned non-finite for ${String(value)}`).toBe(true);
      expect(Number.isSafeInteger(out), `not a safe integer for ${String(value)}`).toBe(true);
      expect(Number.isInteger(out), `not a whole afghani for ${String(value)}`).toBe(true);
    }
    // Guard against the test silently passing because everything was rejected.
    expect(returned).toBeGreaterThan(200);
  });

  it('PROPERTY: a rejected input never becomes a silent zero', () => {
    // The dangerous failure mode is not an exception — it is a 0 that looks
    // like a deliberate free-of-charge decision.
    for (const hostile of ['', '  ', 'abc', null, undefined, [], {}, false, 'NaN']) {
      let result: number | 'threw';
      try { result = assertMoney(hostile, 'amount'); } catch { result = 'threw'; }
      expect(result, `${String(hostile)} must throw, not return 0`).toBe('threw');
    }
  });
});

describe('the financial input inventory stays routed through the boundary', () => {
  /**
   * DERIVED, NOT DECLARED.
   *
   * This inventory used to be a hand-maintained list of `[file, label]` pairs,
   * checked one-directionally: for each LISTED pair, assert the file contains
   * `assertMoney(` and that label. A money field added without validation could
   * never fail it, and the list had drifted — `invoices.routes.ts` was absent
   * altogether while validating three money fields, and `students.routes.ts`
   * listed two of its five labels.
   *
   * The inventory is now computed from the source on every run: every money
   * label that reaches `assertMoney` is discovered, and every money-shaped
   * request field is checked for reaching it. A new financial input either
   * routes through the boundary or fails here.
   *
   * SCOPE covers the route layer AND `core/finance`, because the settlement and
   * sponsorship authorities (D-120, D-131, D-140) legitimately parse money
   * inside core rather than at the route.
   */
  const coreFinanceDir = path.join(
    path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..'),
    'core', 'finance',
  );

  const sourcesIn = (dir: string) =>
    fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => ({ file: f, dir }));

  const MONEY_SOURCES = [...sourcesIn(routesDir), ...sourcesIn(coreFinanceDir)];

  /** Every label this file actually hands to assertMoney. */
  const labelsOf = (text: string): string[] =>
    [...text.matchAll(/assertMoney\(\s*[^,)]+,\s*'([^']+)'/g)].map((m) => m[1]);

  const derived = MONEY_SOURCES
    .map(({ file, dir }) => ({ file, labels: labelsOf(fs.readFileSync(path.join(dir, file), 'utf8')) }))
    .filter((entry) => entry.labels.length > 0);

  it('the money boundary is reached from every source that parses money', () => {
    // A living inventory: it must not be empty, and it must cover the money
    // authorities this work package established.
    expect(derived.length).toBeGreaterThan(0);
    const byFile = Object.fromEntries(derived.map((d) => [d.file, d.labels]));

    // Route-layer money that the retired hand-list omitted entirely.
    expect(byFile['invoices.routes.ts'], 'invoices.routes.ts parses money and must be inventoried').toBeDefined();
    expect(byFile['invoices.routes.ts']).toEqual(expect.arrayContaining(['unitPrice', 'discount amount']));

    // Core-layer money the route-only scan could never see.
    expect(byFile['obligations.ts'], 'the settlement authority parses money in core').toBeDefined();
  });

  it.each(
    derived.map(({ file, labels }) => [file, labels] as const),
  )('%s parses every money field it names', (file, labels) => {
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      expect(label.trim(), `${file} passed an empty money label`).not.toBe('');
    }
  });

  /**
   * The other direction, which is the one that used to be impossible: a
   * money-shaped request field that never reaches the boundary.
   *
   * A destructured request field whose name reads as money must appear within
   * the same file in an `assertMoney` call, or be explicitly exempted with the
   * reason it is not a monetary input.
   */
  const MONEY_WORD_RE = /\b(amount|price|fee|salary|budget|rate)\b/;

  /**
   * `surchargeFee` is a money field and `\bfee\b` does not match inside it, so
   * the name is split at its camel humps before the words are looked for. A
   * boundary-only match let every camelCase money field through.
   */
  const readsAsMoney = (field: string) =>
    // An identifier names a row, never a figure, however money-ish the noun.
    !/Ids?$/.test(field)
    && MONEY_WORD_RE.test(field.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase());

  /** Fields whose names read as money but are not monetary inputs. */
  const NOT_MONEY: Record<string, string> = {
    amountPaidNow: 'alias parsed as "amount paid" in the same handler',
    amountPaid: 'visitor conversion rejects legacy money fields outright instead of parsing them',
    feeType: 'a taxonomy code, not a figure',
    feeKey: 'a configuration key, not a figure',
    rateType: 'a classification, not a figure',
    amountReceived: 'alias parsed as "amount received" in the same handler',
  };

  it('no money-shaped request field escapes the boundary unparsed', () => {
    const offenders: string[] = [];
    for (const { file, dir } of MONEY_SOURCES) {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      if (!text.includes('assertMoney(')) continue;
      const labels = labelsOf(text).join(' | ').toLowerCase();
      for (const match of text.matchAll(/const\s*\{([^}]*)\}\s*=\s*req\.body/g)) {
        for (const raw of match[1].split(',')) {
          const field = raw.split(':')[0].split('=')[0].trim();
          if (!field || !readsAsMoney(field) || NOT_MONEY[field]) continue;
          // The field is money-shaped: some assertMoney label in this file must
          // plausibly name it, or the field must be handed to assertMoney directly.
          const named = labels.includes(field.toLowerCase())
            || labels.split(/[^a-z]+/).some((w) => w && field.toLowerCase().includes(w))
            || new RegExp(`assertMoney\\(\\s*${field}\\b`).test(text);
          if (!named) offenders.push(`${file}: ${field}`);
        }
      }
    }
    expect(offenders, 'these request fields look like money but reach no boundary').toEqual([]);
  });

  it('no route writes a raw request price/fee/salary straight into SQL', () => {
    // Catch the specific shapes that produced real defects in passes 12-14.
    const banned: Array<[string, RegExp]> = [
      ['books.routes.ts', /stmtInsertBook\.run\([^)]*\btitle\)?\.trim\(\), price,/],
      ['classes.routes.ts', /let resolvedFee = fee;/],
      ['academic.routes.ts', /Number\(defaultFee\) \|\| ACADEMIC_DEFAULTS/],
      ['funding.routes.ts', /donorId \|\| null, campaignId \|\| null, totalBudget,/],
      ['visitors.routes.ts', /Number\(amountPaid\) < 0/],
    ];
    for (const [file, pattern] of banned) {
      const src = fs.readFileSync(path.join(routesDir, file), 'utf8');
      expect(src, `${file} regressed to an unvalidated write`).not.toMatch(pattern);
    }
  });
});
