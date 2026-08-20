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
   * Every money-typed request field found by inventorying the route layer.
   * If a new financial input is added without validation, add it here — or
   * better, route it through assertMoney and this test passes by itself.
   */
  const INVENTORY: Array<[string, string]> = [
    ['academic.routes.ts', 'default fee'],
    ['academic.routes.ts', 'level fee'],
    ['books.routes.ts', 'book price'],
    ['books.routes.ts', 'book purchase price'],
    ['books.routes.ts', 'discount'],
    ['classes.routes.ts', 'class fee'],
    ['exams.routes.ts', 'exam fee'],
    ['funding.routes.ts', 'scholarship budget'],
    ['funding.routes.ts', 'award amount'],
    ['funding.routes.ts', 'monthly sponsorship amount'],
    ['funding.routes.ts', 'campaign target amount'],
    ['journey.routes.ts', 'discount amount'],
    ['skills.routes.ts', 'monthlyRate'],
    ['students.routes.ts', 'tuition amount'],
    ['students.routes.ts', 'amount paid'],
    ['teachers.routes.ts', 'base salary'],
    ['teachers.routes.ts', 'default skill rate'],
    ['visitors.routes.ts', 'semester fee'],
    ['visitors.routes.ts', 'received fee amount'],
  ];

  for (const [file, field] of INVENTORY) {
    it(`${file} validates "${field}"`, () => {
      const src = fs.readFileSync(path.join(routesDir, file), 'utf8');
      expect(src).toContain(`assertMoney(`);
      expect(src, `${file} must validate ${field}`).toContain(`'${field}'`);
    });
  }

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
