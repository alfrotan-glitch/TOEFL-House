/**
 * Free-text field bounds (group F11)
 * ============================================================================
 * S16 — no route bounded the LENGTH of a text field.
 *
 * Proven live before the fix:
 *     POST /students/manual  fullName = 1,000,000 chars  ->  201 Created
 * The value was stored verbatim. The only thing that ever refused was
 * Express's body-size limit at ~5 MB, and it answered
 *     500 {"error":"request entity too large"}
 * — a client mistake reported as a server fault.
 *
 * Impact is not merely cosmetic: a roster endpoint returns up to 2,000 rows,
 * so a handful of such records turns every list response into megabytes, and
 * the damage persists in the database.
 *
 * Fixed with utils/textInput.ts, applied to the student, visitor and teacher
 * creation routes. Every violation is a 400 naming the field and its ceiling.
 */
import { describe, it, expect } from 'vitest';
import { optionalText, requiredText, assertTextLengths, TEXT_LIMITS } from '../utils/textInput.js';
import { HttpError } from '../middleware/errorHandler.js';

describe('S16: text length ceilings are enforced', () => {
  it('a value at the ceiling is accepted, one over is rejected', () => {
    expect(requiredText('X'.repeat(200), 'Full name', TEXT_LIMITS.name)).toHaveLength(200);
    expect(() => requiredText('X'.repeat(201), 'Full name', TEXT_LIMITS.name)).toThrow(HttpError);
  });

  it('rejection is a 400 that names the field and the limit', () => {
    let caught: unknown;
    try {
      requiredText('X'.repeat(1_000_000), 'Full name', TEXT_LIMITS.name);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(400);
    expect((caught as HttpError).message).toContain('Full name');
    expect((caught as HttpError).message).toContain('200');
  });

  it('a one-megabyte value is refused rather than stored', () => {
    expect(() => requiredText('X'.repeat(1_000_000), 'Full name', TEXT_LIMITS.name)).toThrow(HttpError);
    expect(() => optionalText('X'.repeat(1_000_000), 'Notes', TEXT_LIMITS.notes)).toThrow(HttpError);
  });

  it('assertTextLengths reports the FIRST offending field', () => {
    let caught: unknown;
    try {
      assertTextLengths([
        ['ok', 'Full name', TEXT_LIMITS.name],
        ['Y'.repeat(9999), 'Address', TEXT_LIMITS.line],
        ['Z'.repeat(9999), 'Notes', TEXT_LIMITS.notes],
      ]);
    } catch (e) {
      caught = e;
    }
    expect((caught as HttpError).message).toContain('Address');
  });
});

describe('S16: legitimate input is untouched', () => {
  it('accepts realistic Afghan and English names', () => {
    for (const name of ['محمد احمد رحیمی', 'Fatima Zahra Noori', "Abdul Qadir Khan-Zadah", 'Zainab']) {
      expect(requiredText(name, 'Full name', TEXT_LIMITS.name)).toBe(name);
    }
  });

  it('trims surrounding whitespace', () => {
    expect(requiredText('  Ahmad  ', 'Full name')).toBe('Ahmad');
    expect(optionalText('  note  ', 'Notes')).toBe('note');
  });

  it('absent and blank optional fields become null, not an error', () => {
    expect(optionalText(undefined, 'Notes')).toBeNull();
    expect(optionalText(null, 'Notes')).toBeNull();
    expect(optionalText('', 'Notes')).toBeNull();
    expect(optionalText('    ', 'Notes')).toBeNull();
  });

  it('a required field that is missing or blank is a 400', () => {
    for (const bad of [undefined, null, '', '   ']) {
      expect(() => requiredText(bad, 'Full name')).toThrow(HttpError);
    }
  });

  it('a non-string is a 400, not a coercion', () => {
    for (const bad of [42, {}, [], true]) {
      expect(() => requiredText(bad, 'Full name')).toThrow(HttpError);
      expect(() => optionalText(bad, 'Notes')).toThrow(HttpError);
    }
  });

  it('a long but legitimate note fits inside the notes ceiling', () => {
    const note = 'Student requested a payment plan. '.repeat(100); // ~3,400 chars
    expect(note.length).toBeLessThan(TEXT_LIMITS.notes);
    expect(optionalText(note, 'Notes', TEXT_LIMITS.notes)).toBe(note.trim());
  });
});
