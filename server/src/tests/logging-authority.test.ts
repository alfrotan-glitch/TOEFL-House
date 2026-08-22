/**
 * The logger's job is to be diagnosable without being dangerous.
 * ============================================================================
 * Runtime logging used to be fifty-three `console.*` calls with no level, no
 * shape and no filtering. These tests pin the properties that replaced them —
 * and the one that matters most in a financial system: a credential must never
 * reach a log line, because that is the easiest place to leak one and the
 * hardest place to notice it afterwards.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createLogger, redact } from '../core/observability/logger.js';

/** Captures what the logger actually wrote, per stream. */
function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const so = vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out.push(String(s)); return true; }) as never);
  const se = vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => { err.push(String(s)); return true; }) as never);
  return { out, err, restore: () => { so.mockRestore(); se.mockRestore(); } };
}

const ENV = process.env.NODE_ENV;
const LEVEL = process.env.LOG_LEVEL;

afterEach(() => {
  process.env.NODE_ENV = ENV;
  if (LEVEL === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = LEVEL;
});

describe('redaction', () => {
  it('replaces credential-shaped fields at any depth', () => {
    const result = redact({
      username: 'ahmad',
      password: 'hunter2',
      nested: { apiKey: 'abc', jwt: 'x.y.z', note: 'keep me' },
      list: [{ secret: 's' }],
    }) as Record<string, unknown>;

    expect(result.username).toBe('ahmad');
    expect(result.password).toBe('[redacted]');
    expect((result.nested as Record<string, unknown>).apiKey).toBe('[redacted]');
    expect((result.nested as Record<string, unknown>).jwt).toBe('[redacted]');
    expect((result.nested as Record<string, unknown>).note).toBe('keep me');
    expect(((result.list as unknown[])[0] as Record<string, unknown>).secret).toBe('[redacted]');
  });

  it('does not hang on a cyclic context', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic.self = cyclic;
    expect(() => redact(cyclic)).not.toThrow();
  });

  it('a credential passed in context never reaches the stream', () => {
    process.env.NODE_ENV = 'development';
    process.env.LOG_LEVEL = 'debug';
    const cap = capture();
    try {
      createLogger('auth').info('login attempt', { username: 'ahmad', password: 'hunter2' });
    } finally {
      cap.restore();
    }
    const written = cap.out.join('');
    expect(written).toContain('ahmad');
    expect(written).not.toContain('hunter2');
    expect(written).toContain('[redacted]');
  });
});

describe('levels', () => {
  it('is silent below error under test, so a passing suite is quiet', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.LOG_LEVEL;
    const cap = capture();
    try {
      const log = createLogger('probe');
      log.debug('d');
      log.info('i');
      log.warn('w');
      log.error('boom');
    } finally {
      cap.restore();
    }
    expect(cap.out.join('')).toBe('');
    expect(cap.err.join('')).toContain('boom');
  });

  it('honours an explicit LOG_LEVEL', () => {
    process.env.NODE_ENV = 'test';
    process.env.LOG_LEVEL = 'debug';
    const cap = capture();
    try {
      createLogger('probe').debug('visible now');
    } finally {
      cap.restore();
    }
    expect(cap.out.join('')).toContain('visible now');
  });

  it('separates diagnostics from failures by stream', () => {
    process.env.NODE_ENV = 'development';
    process.env.LOG_LEVEL = 'debug';
    const cap = capture();
    try {
      const log = createLogger('probe');
      log.info('progress');
      log.warn('degraded');
      log.error('failed');
    } finally {
      cap.restore();
    }
    expect(cap.out.join('')).toContain('progress');
    expect(cap.err.join('')).toContain('degraded');
    expect(cap.err.join('')).toContain('failed');
    expect(cap.out.join('')).not.toContain('failed');
  });
});

describe('shape', () => {
  it('emits one parseable JSON object per line in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.LOG_LEVEL = 'info';
    const cap = capture();
    try {
      createLogger('finance').info('payment recorded', { paymentId: 'pay_1', amount: 500 });
    } finally {
      cap.restore();
    }
    const line = cap.out.join('').trim();
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe('info');
    expect(parsed.source).toBe('finance');
    expect(parsed.message).toBe('payment recorded');
    expect(parsed.paymentId).toBe('pay_1');
    expect(typeof parsed.ts).toBe('string');
  });

  it('describes a thrown Error instead of serialising it to {}', () => {
    process.env.NODE_ENV = 'production';
    process.env.LOG_LEVEL = 'info';
    const cap = capture();
    try {
      createLogger('db').error('write failed', new TypeError('no such column: role'));
    } finally {
      cap.restore();
    }
    const parsed = JSON.parse(cap.err.join('').trim());
    expect(parsed.error).toBe('TypeError');
    // The line keeps the caller's message; the exception's own text is a
    // separate field. Spreading it over `message` used to replace one with
    // the other, so a log line said "no such column: role" where the caller
    // had written "write failed".
    expect(parsed.message).toBe('write failed');
    expect(parsed.errorMessage).toBe('no such column: role');
    // The stack is diagnostic; production keeps it out of the shipped line.
    expect(parsed.stack).toBeUndefined();
  });

  it('keeps the stack in development, where a developer reads it', () => {
    process.env.NODE_ENV = 'development';
    process.env.LOG_LEVEL = 'debug';
    const cap = capture();
    try {
      createLogger('db').error('write failed', new Error('boom'));
    } finally {
      cap.restore();
    }
    expect(cap.err.join('')).toContain('stack');
  });
});
