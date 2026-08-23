/**
 * WP-11 frontend consumer contract.
 * ============================================================================
 * Reporting, dashboard, BOS and search are consumers of authoritative server
 * projections. These tests pin the structural contracts so the browser does not
 * quietly become a second authority.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('../../../../../', import.meta.url)));
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const storeSrc = read('src/apiStore.ts');
const dashboardSrc = read('src/components/dashboard/DashboardView.tsx');
const bosSrc = read('src/components/dashboard/BusinessOperatingSystemView.tsx');
const searchSrc = read('src/components/common/GlobalSearch.tsx');

describe('dashboard and BOS preload and refresh authoritative server projections', () => {
  it('loads finance dashboard and profitability projections with the dashboard workspace', () => {
    const dashboardCase = storeSrc.slice(
      storeSrc.indexOf("case 'dashboard':"),
      storeSrc.indexOf("case 'students':"),
    );
    expect(dashboardCase).toContain('reloadDashboardSummary()');
    expect(dashboardCase).toContain('reloadFinanceDashboard()');
    expect(dashboardCase).toContain('reloadRevenueByClass()');
    expect(dashboardCase).toContain('reloadRevenueByTimeSlot()');
  });

  it('refreshes dashboard and finance truth after a BOS withdrawal', () => {
    const body = storeSrc.slice(
      storeSrc.indexOf('const withdrawProfitDistribution = async'),
      storeSrc.indexOf('/** Create a branch budget envelope under a canonical subcategory. */'),
    );
    expect(body).toContain('reloadFinanceOverview()');
    expect(body).toContain('reloadFinanceDashboard()');
    expect(body).toContain('reloadDashboardSummary()');
    expect(body).toContain('reloadRevenueByClass()');
    expect(body).toContain('reloadRevenueByTimeSlot()');
    expect(body).toContain("invalidate('finance')");
  });
});

describe('DashboardView remains a consumer, not an executive gate for the whole workspace', () => {
  it('gates only the BOS tab on Dashboard.Executive', () => {
    expect(dashboardSrc).toContain("...(canViewExecutive ? [{ id: 'bos', label: 'Business OS', icon: Zap }] : [])");
    expect(dashboardSrc).toContain("mainTab === 'bos' && canViewExecutive");
  });

  it('does not short-circuit the whole dashboard when the caller lacks Dashboard.Executive', () => {
    expect(dashboardSrc).not.toContain('if (!canViewExecutive) {');
    expect(dashboardSrc).toContain('Operations Dashboard');
  });

  it('passes the authoritative revenue projections through to BusinessOperatingSystemView', () => {
    expect(dashboardSrc).toContain('revenueByClass={revenueByClass} revenueByTimeSlot={revenueByTimeSlot}');
  });
});

describe('BusinessOperatingSystemView consumes server projections instead of inventing them', () => {
  it('derives the New Visitors tile from the marketing funnel lead totals', () => {
    expect(bosSrc).toContain('const visitorIntake = funnel.funnel.reduce((sum, row) => sum + row.leads, 0);');
    expect(bosSrc).not.toContain('studentStats.newStudents + studentStats.returningStudents');
  });
});

describe('GlobalSearch is a thin consumer of the server search contract', () => {
  it('delegates lookup to /search and groups the returned rows only for display', () => {
    expect(searchSrc).toContain("api.get<SearchResult[]>('/search', { q: query.trim() })");
    expect(searchSrc).toContain('const grouped = useMemo(() => results.reduce');
    expect(searchSrc).not.toMatch(/results\.filter\(|setResults\(results\.|sort\(\)/);
  });
});
