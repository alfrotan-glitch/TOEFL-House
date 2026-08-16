/**
 * Branding has exactly one source of truth.
 * ============================================================================
 * The institute name had been retyped as a literal in ~20 components, which
 * over time produced SEVEN different spellings of one brand:
 *
 *   "The TOEFL House"            "The TOEFL House Academy"
 *   "TOEFL House ERP"            "The TOEFL House Higher Education"
 *   "The TOEFL House ERP"        "TOEFL House"        "TH"
 *
 * Worse, three printed artefacts — the student ID card, the exam certificate
 * and the login screen — drew a *hand-made substitute* for the logo (a
 * coloured circle containing the letters "TH", or a generic graduation-cap
 * icon) because there was no shared logo asset to point at.
 *
 * Everything now reads from src/config/branding.ts. These tests fail the build
 * if a literal creeps back in, because branding drift is invisible in review:
 * each individual hardcoded string looks perfectly correct on its own.
 *
 * This test lives in the server suite because it is the only test runner in
 * the repository; it asserts against frontend source files on disk.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const frontendSrc = path.join(repoRoot, 'src');
const brandingModule = path.join(frontendSrc, 'config', 'branding.ts');

/** Every .ts/.tsx file under src/, excluding the branding module itself. */
function frontendFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (full === brandingModule) continue;
      out.push(full);
    }
  };
  walk(frontendSrc);
  return out;
}

/** Strips comments so documentation prose is not mistaken for rendered output. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('branding is centralised', () => {
  it('the branding module defines the official name, slogan and logo', () => {
    const src = fs.readFileSync(brandingModule, 'utf8');
    expect(src).toContain("BRAND_NAME = 'The TOEFL House'");
    // The slogan is contractual. Its exact wording and capitalisation matter.
    expect(src).toContain("BRAND_SLOGAN = 'Unlock the world with TOEFL'");
    expect(src).toContain('BRAND_LOGO_URL');
  });

  it('no component hardcodes the institute name', () => {
    const offenders: string[] = [];
    for (const file of frontendFiles()) {
      const code = codeOnly(fs.readFileSync(file, 'utf8'));
      if (/The TOEFL House|TOEFL House Academy|TOEFL House Higher Education/.test(code)) {
        offenders.push(path.relative(repoRoot, file));
      }
    }
    expect(offenders, 'import BRAND_NAME from src/config/branding.ts instead').toEqual([]);
  });

  it('no surface substitutes a hand-made mark for the official logo', () => {
    // The three real regressions: a "TH" disc on the ID card and exam
    // certificate, and a GraduationCap icon standing in on the sidebar.
    const offenders: string[] = [];
    for (const file of frontendFiles()) {
      const code = codeOnly(fs.readFileSync(file, 'utf8'));
      if (/>\s*TH\s*</.test(code)) offenders.push(`${path.relative(repoRoot, file)} (literal "TH" mark)`);
    }
    expect(offenders, 'render <BrandLogo /> instead of a substitute mark').toEqual([]);
  });

  it('the slogan is never re-worded', () => {
    const official = 'Unlock the world with TOEFL';
    const offenders: string[] = [];
    for (const file of frontendFiles()) {
      const code = codeOnly(fs.readFileSync(file, 'utf8'));
      // Catch near-miss capitalisations/wordings of the official slogan.
      const matches = code.match(/Unlock the [Ww]orld[^"'`<}\n]*/g) ?? [];
      for (const m of matches) {
        if (m.trim() !== official) offenders.push(`${path.relative(repoRoot, file)}: "${m.trim()}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the official logo asset exists and is referenced by index.html', () => {
    const src = fs.readFileSync(brandingModule, 'utf8');
    const url = /BRAND_LOGO_URL = '([^']+)'/.exec(src)?.[1];
    expect(url, 'BRAND_LOGO_URL must be defined').toBeTruthy();

    const onDisk = path.join(repoRoot, 'public', url!.replace(/^\//, ''));
    expect(
      fs.existsSync(onDisk),
      `The official logo is missing at public${url}. It must be the exact asset supplied by the institute — do not substitute a recreated one.`,
    ).toBe(true);
    // A zero-byte placeholder would satisfy existsSync but render as broken.
    expect(fs.statSync(onDisk).size).toBeGreaterThan(1024);

    // index.html cannot import the module, so it is the one permitted place
    // the path is repeated — assert the two never drift apart.
    const html = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
    expect(html).toContain(url!);
  });

  it('the logo asset is not duplicated across the repository', () => {
    const copies: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (/logo.*\.(png|jpe?g|svg|webp)$/i.test(entry.name)) copies.push(path.relative(repoRoot, full));
      }
    };
    walk(repoRoot);
    expect(copies.length, `expected exactly one logo file, found: ${copies.join(', ')}`).toBeLessThanOrEqual(1);
  });

  it('no document template hardcodes a business phone number', () => {
    // The book-sale receipt printed a literal `0788223344` on every copy from
    // every branch. Contact details are per-branch operational data and must
    // come from the API via resolveDocumentIssuer(), never from source.
    //
    // Matches an Afghan mobile literal (07xxxxxxxx) or a +93 number in real
    // code. Comments are stripped first, so the explanatory note in
    // documentIssuer.ts does not trip this, and validation HINT text
    // ("e.g. 0799887766") is allowed — it is guidance, not business identity.
    const offenders: string[] = [];
    for (const file of frontendFiles()) {
      const code = codeOnly(fs.readFileSync(file, 'utf8'));
      for (const line of code.split('\n')) {
        if (/e\.g\.|example|placeholder/i.test(line)) continue;
        if (/(["'>\s])(?:\+93[\d\s-]{7,}|07\d{8})(?=["'<\s.,)]|$)/.test(line)) {
          offenders.push(`${path.relative(repoRoot, file)}: ${line.trim().slice(0, 90)}`);
        }
      }
    }
    expect(offenders, `hardcoded business phone number(s):\n${offenders.join('\n')}`).toEqual([]);
  });
});
