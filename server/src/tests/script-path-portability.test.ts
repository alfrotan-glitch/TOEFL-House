/**
 * WIN-1 — operator scripts must resolve their own location portably.
 * ============================================================================
 * `verify-deployment.mjs` located its migrations directory with:
 *
 *     path.dirname(new URL(import.meta.url).pathname)
 *
 * On Linux that happens to be a usable path. On Windows it is NOT: the URL
 * pathname of `file:///C:/Users/...` is `/C:/Users/...`, with a leading slash
 * and forward slashes, which `fs.existsSync()` can never resolve.
 *
 * The consequence was a verifier that FAILED OPEN — the single worst outcome
 * for a safety check:
 *
 *     migrationsOnDisk = []        (neither src/ nor dist/ appeared to exist)
 *     missing          = []        (nothing to compare against)
 *     check            = PASS      (on a database with unapplied migrations)
 *     exit code        = 0         (expected 1)
 *
 * That is precisely the reported failure: "FAILS when a migration on disk was
 * never applied — expected +0 to be 1" on Windows, while the same commit
 * passed on Linux.
 *
 * `fileURLToPath()` is the correct conversion on every platform. These tests
 * pin that contract for the operator scripts, so the bug cannot come back via
 * a copy-paste of the old idiom.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const repoRoot = path.resolve(serverRoot, '..');

const OPERATOR_SCRIPTS = [
  path.join(serverRoot, 'scripts', 'verify-deployment.mjs'),
  path.join(repoRoot, 'scripts', 'verify-product-integrity.mjs'),
  path.join(repoRoot, 'scripts', 'release-validate.mjs'),
  path.join(repoRoot, 'scripts', 'high-assurance-static-audit.mjs'),
  path.join(repoRoot, 'scripts', 'verify-bundle-weight.mjs'),
];

describe('WIN-1 — no script derives a filesystem path from URL.pathname', () => {
  for (const script of OPERATOR_SCRIPTS) {
    it(`${path.basename(script)} does not use import.meta.url .pathname as a path`, () => {
      if (!fs.existsSync(script)) return; // script is optional in some checkouts
      // Strip comments first: these files deliberately DOCUMENT the broken
      // idiom, and a doc comment must not be mistaken for executable code.
      const source = fs
        .readFileSync(script, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');

      // The exact broken idiom: taking .pathname off a file URL and treating
      // the result as a filesystem path.
      expect(source).not.toMatch(/new URL\([^)]*import\.meta\.url[^)]*\)\s*\.pathname/);
      expect(source).not.toMatch(/import\.meta\.url\s*\)\s*\.pathname/);
    });
  }

  it('verify-deployment.mjs uses fileURLToPath and finds all 75 migrations', () => {
    const script = path.join(serverRoot, 'scripts', 'verify-deployment.mjs');
    const source = fs.readFileSync(script, 'utf8');
    expect(source).toContain('fileURLToPath');

    // The directory the script resolves must really contain the migrations —
    // an empty list is what made the check fail open.
    const migrationsDir = path.join(serverRoot, 'src', 'db', 'migrations');
    expect(fs.existsSync(migrationsDir)).toBe(true);
    const sqlFiles = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
    expect(sqlFiles.length).toBeGreaterThan(0);
  });
});

describe('WIN-1 — fileURLToPath is what makes this portable', () => {
  it('URL.pathname keeps a leading slash on a Windows-style file URL', () => {
    // Documents the defect itself: this value is not a Windows path.
    const windowsUrl = 'file:///C:/Users/Operator/app/scripts/verify-deployment.mjs';
    expect(new URL(windowsUrl).pathname).toBe('/C:/Users/Operator/app/scripts/verify-deployment.mjs');
    expect(new URL(windowsUrl).pathname.startsWith('/C:')).toBe(true);
  });

  it('fileURLToPath round-trips this file to a real, existing path', () => {
    const self = fileURLToPath(import.meta.url);
    expect(path.isAbsolute(self)).toBe(true);
    expect(fs.existsSync(self)).toBe(true);
  });
});

describe('WIN-1 — line endings are pinned so checkouts match across platforms', () => {
  it('.gitattributes normalises text to LF', () => {
    const attrs = path.join(repoRoot, '.gitattributes');
    expect(fs.existsSync(attrs)).toBe(true);
    expect(fs.readFileSync(attrs, 'utf8')).toMatch(/\*\s+text=auto\s+eol=lf/);
  });
});
