import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../../..');
const frontendSrc = path.join(repoRoot, 'src');
const brandingModule = path.join(frontendSrc, 'config', 'branding.ts');

function source(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function frontendFiles(): string[] {
  const out: string[] = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && full !== brandingModule) out.push(full);
    }
  };
  walk(frontendSrc);
  return out;
}

function codeOnly(value: string): string {
  return value.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('WP-01 branding has one configuration authority', () => {
  it('defines the contractual name, slogan and official logo once', () => {
    const branding = source('src/config/branding.ts');
    expect(branding).toContain("BRAND_NAME = 'The TOEFL House'");
    expect(branding).toContain("BRAND_SLOGAN = 'Unlock the world with TOEFL'");
    const logo = /BRAND_LOGO_URL = '([^']+)'/.exec(branding)?.[1];
    expect(logo).toBe('/brand/toefl-house-logo.png');
    const onDisk = path.join(repoRoot, 'public', logo!.replace(/^\//, ''));
    expect(fs.statSync(onDisk).size).toBeGreaterThan(1024);
    expect(source('index.html')).toContain(logo!);
  });

  it('prevents component-local institute names and substitute TH marks', () => {
    const offenders: string[] = [];
    for (const file of frontendFiles()) {
      const code = codeOnly(fs.readFileSync(file, 'utf8'));
      if (/The TOEFL House|TOEFL House Academy|TOEFL House Higher Education/.test(code) || />\s*TH\s*</.test(code)) {
        offenders.push(path.relative(repoRoot, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('does not hardcode a branch business phone into a document surface', () => {
    const offenders: string[] = [];
    for (const file of frontendFiles()) {
      for (const line of codeOnly(fs.readFileSync(file, 'utf8')).split('\n')) {
        if (/e\.g\.|example|placeholder/i.test(line)) continue;
        if (/(["'>\s])(?:\+93[\d\s-]{7,}|07\d{8})(?=["'<\s.,)]|$)/.test(line)) {
          offenders.push(`${path.relative(repoRoot, file)}: ${line.trim().slice(0, 80)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('WP-01 selected branch reaches every academic configuration consumer', () => {
  it('scopes the configuration center and remounts branch-owned heavy panels', () => {
    const setup = source('src/components/academic/AcademicSetupView.tsx');
    expect(setup).toContain('const query = branchId ? { branchId } : undefined');
    expect(setup).toContain("key={`versions-${branchId ?? 'all'}");
    expect(setup).toContain("key={`offerings-${branchId ?? 'all'}");
    expect(setup).toContain("key={`generate-${branchId ?? 'all'}");
    expect(setup).toContain("await api.post('/academic/terms', { ...termForm, branchId }");
    expect(setup).toContain("await api.put('/academic/level-fees', { levelId: l.id, fee: feeFor(l.id, l.defaultFee), branchId }");
  });

  it('scopes offering, version, policy and generation reads and writes', () => {
    const offerings = source('src/components/academic/OfferingsPanel.tsx');
    const versions = source('src/components/academic/ProgramVersionsPanel.tsx');
    const generation = source('src/components/academic/ClassGenerationWizard.tsx');
    expect(offerings).toContain('const query = { branchId }');
    expect(offerings).toContain("await api.post('/offerings', { ...form, branchId");
    expect(versions).toContain('const query = branchId ? { branchId } : undefined');
    expect(versions).toContain("await api.post('/catalog/promotion-rules', {");
    expect(versions).toContain('programVersionId: selectedId,');
    expect(versions).toContain('...promoForm,');
    expect(versions).toContain('branchId,');
    expect(versions).toContain('await api.put(`/academic/program-versions/${selectedId}/placement-profile`, {');
    expect(versions).toContain('await api.delete(`/catalog/promotion-rules/${ruleId}`)');
    expect(generation).toContain('/offerings?branchId=${encodeURIComponent(branchId)}');
    expect(generation).toContain('branchId,\n        offeringId: selectedOffering.id');
  });

  it('scopes the shared program-version reload used outside the setup center', () => {
    const store = source('src/apiStore.ts');
    expect(store).toContain("api.get<any[]>('/catalog/program-versions', bq)");
    expect(store).toContain('const bq = useMemo(() => ({ branchId: currentBranchId }), [currentBranchId])');
  });
});

describe('WP-01 finance and generic rules remain separate authorities', () => {
  it('keeps the live saving percentage in income.ts and out of the generic default catalog', () => {
    const income = source('server/src/utils/income.ts');
    const catalog = source('server/src/core/configuration/policy-catalog.ts');
    expect(income).toContain("getNumberSetting('daily_saving_percent'");
    expect(income).not.toContain('evaluateRules(');
    expect(catalog).not.toContain('rule_default_auto_savings');
  });
});
