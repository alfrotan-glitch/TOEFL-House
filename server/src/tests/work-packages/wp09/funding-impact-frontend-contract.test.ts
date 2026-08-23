import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const funding = fs.readFileSync(path.join(root, 'src', 'components', 'funding', 'FundingView.tsx'), 'utf8');
const impact = fs.readFileSync(path.join(root, 'src', 'components', 'impact', 'ImpactView.tsx'), 'utf8');
const store = fs.readFileSync(path.join(root, 'src', 'apiStore.ts'), 'utf8');
const fundingRoute = fs.readFileSync(path.join(root, 'server', 'src', 'routes', 'funding.routes.ts'), 'utf8');
const impactRoute = fs.readFileSync(path.join(root, 'server', 'src', 'routes', 'impact.routes.ts'), 'utf8');

describe('WP-09 · frontend contract', () => {
  it('renders the server funding summary instead of calculating treasury truth in the browser', () => {
    expect(funding).toContain('fundingSummary?.donationsReceived');
    expect(funding).toContain('fundingSummary?.scholarshipCommitted');
    expect(funding).not.toMatch(/donations\.reduce\(/);
    expect(funding).not.toMatch(/campaigns\.reduce\(/);
    expect(funding).not.toMatch(/scholarships\.reduce\(/);
  });

  it('requires a structured restriction target and an exact source for aid application', () => {
    expect(funding).toContain('Structured target');
    expect(funding).toContain('Exact received scholarship source');
    expect(funding).toContain('sponsorshipReceiptId');
    expect(funding).not.toContain('restrictionNote');
  });

  it('offers scope-aware Impact reports and never offers manual metric/story truth', () => {
    expect(impact).toContain('scopeKind');
    expect(impact).toContain('Proof before attribution');
    expect(impact).not.toContain('/impact/metrics');
    expect(impact).not.toContain('/impact/stories');
  });

  it('sends the selected branch with funding and impact mutations and refreshes their readers', () => {
    expect(store).toContain("branchId: currentBranchId");
    expect(store).toContain("funding:    ['funding', 'impact']");
    expect(store).toContain("invalidate('funding', 'finance')");
  });
});

describe('WP-09 · event notification boundary', () => {
  it('publishes funding/impact events without a duplicate direct notification writer', () => {
    expect(fundingRoute).toContain("eventBus.emit('donation.received'");
    expect(impactRoute).toContain("'impact.report_generated'");
    expect(fundingRoute).not.toContain('addNotification');
    expect(impactRoute).not.toContain('addNotification');
  });
});
