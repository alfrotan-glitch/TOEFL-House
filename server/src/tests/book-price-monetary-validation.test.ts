/**
 * Book prices are money and must clear the same validation bar as every other
 * monetary input.
 * ============================================================================
 * DEFECT CLASS: a validated sibling field hiding an unvalidated one.
 *
 * `POST /api/books` carefully validated `stock`
 * (`Number.isInteger(Number(stock)) && >= 0`) and then wrote `price` straight
 * through with no check at all. Reproduced against the live API — every one of
 * these returned `{"ok":true}` and was persisted:
 *
 *     price "abc"  -> stored as the literal TEXT 'abc'
 *     price -100   -> stored, with purchase_price derived as -60
 *     price 1e309  -> stored as NULL
 *     price 1e15   -> stored as 1000000000000000
 *
 * The consequence is worse than a bad number on a screen. `/books/:id/sell`
 * computes `book.price * quantity`, so a book priced 'abc' yields NaN and the
 * sale dies with a raw `NOT NULL constraint failed: book_sales.total_amount`.
 * The book becomes permanently unsellable and the operator sees a database
 * error, not a validation message.
 *
 * Both the create and the update handler now route price and purchase price
 * through `assertMoney`. These tests assert the shipped source as well as the
 * invariant, because a test that only re-implements the rule cannot fail when
 * the route regresses.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertMoney } from '../utils/money.js';

const booksRouteSource = fs.readFileSync(
  path.join(path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..'), 'routes', 'books.routes.ts'),
  'utf8',
);

const resolvePrice = (price: unknown) => assertMoney(price, 'book price');

describe('book price monetary validation', () => {
  it('rejects a non-numeric price instead of storing the raw string', () => {
    expect(() => resolvePrice('abc')).toThrow(/finite number/i);
  });

  it('rejects a negative price', () => {
    expect(() => resolvePrice(-100)).toThrow(/negative/i);
  });

  it('rejects values outside the float range instead of storing NULL', () => {
    expect(() => resolvePrice('1e309')).toThrow(/finite number/i);
  });

  it('rejects a price beyond supported monetary precision', () => {
    expect(() => resolvePrice(1e15)).toThrow(/precision/i);
  });

  it('accepts ordinary prices and a zero price', () => {
    expect(resolvePrice(1200)).toBe(1200);
    expect(resolvePrice('750.25')).toBe(750.25);
    expect(resolvePrice(0)).toBe(0);
  });

  it('the create handler validates price and purchase price', () => {
    // Pin the binding, not just the presence of a call: an earlier version of
    // this test passed even when `validatedPrice` was changed to a bare cast,
    // because `assertMoney(price, ...)` still appeared elsewhere in the file.
    expect(booksRouteSource).toContain("const validatedPrice = assertMoney(price, 'book price');");
    expect(booksRouteSource).toContain("assertMoney(purchasePrice, 'book purchase price')");
    expect(booksRouteSource).not.toMatch(/const validatedPrice = price\b/);
  });

  it('the create handler no longer writes the raw request price to the database', () => {
    // The insert and restock statements must use the validated value.
    expect(booksRouteSource).toContain('stmtInsertBook.run(newId, String(title).trim(), validatedPrice');
    expect(booksRouteSource).not.toContain('stmtInsertBook.run(newId, String(title).trim(), price,');
  });

  it('the update handler validates a supplied price rather than passing it through', () => {
    expect(booksRouteSource).not.toContain('price ?? existing.price');
    expect(booksRouteSource).toContain("price != null ? assertMoney(price, 'book price') : existing.price");
  });

  it('a derived purchase price stays numeric', () => {
    // finalPurchasePrice falls back to 60% of the validated price, so it can
    // never inherit NaN from an unvalidated input.
    const derived = Math.round(resolvePrice(1200) * 0.6);
    expect(Number.isFinite(derived)).toBe(true);
    expect(derived).toBe(720);
  });
});

/**
 * Teacher base salary — same invariant, different route.
 *
 * The create handler checked `Number.isFinite(n) && n >= 0`, which is stricter
 * than the book-price gap but still let 1e15 through: a base salary of one
 * quadrillion was accepted and stored. It now uses `assertMoney`, which adds
 * the two-decimal rounding and safe-integer-cents ceiling.
 */
describe('teacher base salary monetary validation', () => {
  const teachersRouteSource = fs.readFileSync(
    path.join(path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..'), 'routes', 'teachers.routes.ts'),
    'utf8',
  );

  it('rejects a salary beyond supported monetary precision', () => {
    expect(() => assertMoney(1e15, 'base salary')).toThrow(/precision/i);
  });

  it('still rejects non-numeric and negative salaries', () => {
    expect(() => assertMoney('abc', 'base salary')).toThrow(/finite number/i);
    expect(() => assertMoney(-5000, 'base salary')).toThrow(/negative/i);
  });

  it('accepts ordinary salaries including zero', () => {
    expect(assertMoney(30000, 'base salary')).toBe(30000);
    expect(assertMoney(0, 'base salary')).toBe(0);
  });

  it('the create handler routes base salary through assertMoney', () => {
    expect(teachersRouteSource).toContain("assertMoney(baseSalary, 'base salary')");
    // The bare finite-check that allowed 1e15 must not come back.
    expect(teachersRouteSource).not.toContain('!Number.isFinite(numericBaseSalary) || numericBaseSalary < 0');
  });
});
