/**
 * The reporting workspace.
 * ============================================================================
 * Renders the DECLARED report catalog. Every report on this screen exists
 * because `REPORT_CATALOG` declares it, and every number on it was produced by
 * the report engine — this view contains no metric definition, no aggregation
 * and no arithmetic over values.
 *
 * That restraint is the point. §18 allows one definition per metric and many
 * consumers; the moment a screen adds two figures together to make a third, it
 * has become a second definition that nothing reconciles. So the only thing
 * done to a value here is FORMATTING: thousands separators, an AFN suffix, a
 * percent sign. Which of those to apply is chosen by the `unit` the server
 * sends, not guessed from the metric's name.
 *
 * Export does not serialize this table. It asks the server for the file, which
 * runs the same engine call and serializes its result — so a spreadsheet that
 * leaves the building cannot disagree with the screen it came from. Printing
 * goes through the print authority for the same reason.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, Download, Printer, RefreshCw, FileText, AlertTriangle } from 'lucide-react';
import { api } from '../../api/client';
import { formatAFN } from '../../utils/format';
import { formatJalaliDateTime } from '../../utils/jalali';
import { brandPrintHeaderHtml } from '../../config/branding';
import { openPrintDocument, escapeHtml } from '../../design-system/print';
import { text, layout, surface, control, button, badge } from '../../design-system/styles';

type MetricUnit = 'afn' | 'count' | 'percent' | 'days';

interface CatalogReport {
  id: string;
  title: string;
  category: string;
  purpose: string;
  periods: string[];
  permission: string;
}

interface Catalog {
  categories: string[];
  periods: string[];
  reports: CatalogReport[];
}

interface ReportMetric {
  id: string;
  label: string;
  unit: MetricUnit;
  value: number;
  note: string;
}

interface ReportRun {
  id: string;
  title: string;
  category: string;
  purpose: string;
  period: string;
  boundaries: { from: string; to: string; periodKey: string };
  scope: { branchId: string | null; isAll: boolean };
  metrics: ReportMetric[];
  isEmpty: boolean;
}

/**
 * Presentation only.
 *
 * The unit comes from the server so this cannot drift from the definition: a
 * metric that changes from a count to a percentage starts rendering as a
 * percentage without this file being edited.
 */
function formatMetric(value: number, unit: MetricUnit): string {
  switch (unit) {
    case 'afn':
      return formatAFN(value);
    case 'percent':
      return `${value}%`;
    case 'days':
      return `${value.toLocaleString()} days`;
    case 'count':
    default:
      return value.toLocaleString();
  }
}

const PERIOD_LABEL: Record<string, string> = {
  today: 'Today',
  week: 'This week',
  month: 'This month',
  quarter: 'This quarter',
  year: 'This year',
};

interface ReportsViewProps {
  triggerToast: (message: string, type: 'success' | 'error' | 'info') => void;
}

export default function ReportsView({ triggerToast }: ReportsViewProps) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [period, setPeriod] = useState<string>('month');
  const [run, setRun] = useState<ReportRun | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get<Catalog>('/reports/catalog')
      .then((data) => {
        if (cancelled) return;
        setCatalog(data);
        setCatalogError(null);
        if (data.reports.length > 0) setSelectedId((prev) => prev ?? data.reports[0].id);
      })
      .catch((e: unknown) => {
        if (!cancelled) setCatalogError(e instanceof Error ? e.message : 'Could not load the report catalog.');
      });
    return () => { cancelled = true; };
  }, []);

  const selected = useMemo(
    () => catalog?.reports.find((r) => r.id === selectedId) ?? null,
    [catalog, selectedId],
  );

  // A report declares the periods it is meaningful at. Offering one it does not
  // support would produce a 400 the operator cannot act on, so the choice is
  // narrowed to what the server will accept.
  const availablePeriods = selected?.periods ?? [];
  useEffect(() => {
    if (availablePeriods.length > 0 && !availablePeriods.includes(period)) {
      setPeriod(availablePeriods.includes('month') ? 'month' : availablePeriods[0]);
    }
  }, [availablePeriods, period]);

  const loadRun = useCallback(async () => {
    if (!selectedId || availablePeriods.length === 0 || !availablePeriods.includes(period)) return;
    setRunning(true);
    setRunError(null);
    try {
      const data = await api.get<ReportRun>(`/reports/run/${selectedId}`, { period });
      setRun(data);
    } catch (e: unknown) {
      setRun(null);
      setRunError(e instanceof Error ? e.message : 'The report could not be produced.');
    } finally {
      setRunning(false);
    }
  }, [selectedId, period, availablePeriods]);

  useEffect(() => { void loadRun(); }, [loadRun]);

  /**
   * The file comes from the server, not from this table.
   *
   * Serializing the rendered rows would create a second producer of the same
   * numbers, which is the drift §77 exists to prevent — and an exported
   * spreadsheet is precisely the artifact nobody re-checks.
   */
  const exportCsv = async () => {
    if (!selectedId) return;
    setExporting(true);
    try {
      const res = await fetch(
        `/api/reports/run/${encodeURIComponent(selectedId)}/export?period=${encodeURIComponent(period)}`,
        { credentials: 'include' },
      );
      if (!res.ok) {
        let msg = 'Export failed.';
        try { msg = (await res.json()).error || msg; } catch { /* non-JSON error body */ }
        triggerToast(msg, 'error');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${selectedId}-${res.headers.get('X-Report-Period-Key') ?? period}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      triggerToast('Report exported.', 'success');
    } catch {
      triggerToast('Export failed.', 'error');
    } finally {
      setExporting(false);
    }
  };

  const printReport = () => {
    if (!run) return;
    const rows = run.metrics
      .map(
        (m) =>
          `<tr><td>${escapeHtml(m.label)}</td><td class="num">${escapeHtml(
            formatMetric(m.value, m.unit),
          )}</td><td>${escapeHtml(m.note)}</td></tr>`,
      )
      .join('');

    const opened = openPrintDocument({
      title: `${run.title} — ${run.boundaries.periodKey}`,
      footerNote: `${run.title} · ${run.boundaries.periodKey} · ${
        run.scope.isAll ? 'All branches' : (run.scope.branchId ?? '')
      }`,
      signatures: [{ role: 'Prepared by' }, { role: 'Approved by' }],
      bodyHtml: `
        ${brandPrintHeaderHtml(escapeHtml(run.title))}
        <div class="th-meta">
          Period: <b>${escapeHtml(run.boundaries.periodKey)}</b> ·
          Covering: <b>${escapeHtml(run.boundaries.from)} to ${escapeHtml(run.boundaries.to)}</b> ·
          Scope: <b>${escapeHtml(run.scope.isAll ? 'All branches' : (run.scope.branchId ?? ''))}</b> ·
          Generated: <b>${escapeHtml(formatJalaliDateTime(new Date().toISOString()))}</b>
        </div>
        <p>${escapeHtml(run.purpose)}</p>
        <table>
          <thead><tr><th>Metric</th><th class="num">Value</th><th>Definition</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `,
    });
    if (!opened) {
      triggerToast('The print window was blocked by the browser. Allow pop-ups and try again.', 'error');
    }
  };

  const byCategory = useMemo(() => {
    const map = new Map<string, CatalogReport[]>();
    for (const r of catalog?.reports ?? []) {
      if (!map.has(r.category)) map.set(r.category, []);
      map.get(r.category)!.push(r);
    }
    return map;
  }, [catalog]);

  if (catalogError) {
    return (
      <div className={`${surface.panel} p-8 text-center`}>
        <AlertTriangle className="w-8 h-8 text-rose-500 mx-auto mb-2" />
        <p className="font-bold text-slate-800">The report catalog could not be loaded.</p>
        <p className={text.hint}>{catalogError}</p>
      </div>
    );
  }

  if (!catalog) {
    return (
      <div className={`${surface.panel} p-12 text-center text-slate-400`}>
        <RefreshCw className="w-6 h-6 mx-auto mb-2 animate-spin" />
        Loading the report catalog…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className={`${surface.panel} p-6`}>
        <div className={layout.inlineWide}>
          <div className="w-12 h-12 bg-gradient-to-br from-indigo-500 to-violet-500 rounded-xl flex items-center justify-center">
            <BarChart3 className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-black text-slate-900">Reports</h1>
            <p className="text-sm text-slate-500">
              {catalog.reports.length} declared reports across {byCategory.size} categories. Every
              figure is computed by the server from one metric definition.
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[18rem_1fr] gap-6">
        {/* Catalog */}
        <nav className={`${surface.panel} p-3 h-fit`} aria-label="Report catalog">
          {[...byCategory.entries()].map(([category, reports]) => (
            <div key={category} className="mb-3">
              <p className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                {category}
              </p>
              <ul>
                {reports.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(r.id)}
                      aria-current={r.id === selectedId ? 'true' : undefined}
                      className={`w-full text-start px-2 py-1.5 rounded-lg text-xs font-semibold cursor-pointer ${
                        r.id === selectedId
                          ? 'bg-indigo-50 text-indigo-700'
                          : 'text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      {r.title}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        {/* Selected report */}
        <section className={`${surface.panel} p-6`}>
          {!selected ? (
            <p className="text-center text-slate-400 py-12">Select a report.</p>
          ) : (
            <>
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 border-b border-slate-100 pb-4">
                <div>
                  <h2 className="text-lg font-bold text-slate-900">{selected.title}</h2>
                  <p className={text.hint}>{selected.purpose}</p>
                  <span className={`${badge.neutral} mt-2`}>{selected.category}</span>
                </div>
                <div className="flex items-center gap-2">
                  <label htmlFor="report-period" className="sr-only">Period</label>
                  <select
                    id="report-period"
                    value={period}
                    onChange={(e) => setPeriod(e.target.value)}
                    className={`${control.select} w-auto`}
                  >
                    {availablePeriods.map((p) => (
                      <option key={p} value={p}>{PERIOD_LABEL[p] ?? p}</option>
                    ))}
                  </select>
                  <button type="button" onClick={() => void loadRun()} className={button.secondary} disabled={running}>
                    <RefreshCw className={`w-4 h-4 ${running ? 'animate-spin' : ''}`} /> Refresh
                  </button>
                  <button type="button" onClick={printReport} className={button.secondary} disabled={!run || running}>
                    <Printer className="w-4 h-4" /> Print
                  </button>
                  <button type="button" onClick={() => void exportCsv()} className={button.primary} disabled={exporting || running}>
                    <Download className="w-4 h-4" /> {exporting ? 'Exporting…' : 'Export CSV'}
                  </button>
                </div>
              </div>

              {running && (
                <p className="text-center text-slate-400 py-12">
                  <RefreshCw className="w-5 h-5 mx-auto mb-2 animate-spin" /> Producing the report…
                </p>
              )}

              {!running && runError && (
                <div className="py-10 text-center">
                  <AlertTriangle className="w-7 h-7 text-rose-500 mx-auto mb-2" />
                  <p className="font-bold text-slate-800">This report could not be produced.</p>
                  <p className={text.hint}>{runError}</p>
                  <p className={`${text.meta} mt-2`}>
                    No partial figures are shown: a report missing a metric still looks authoritative.
                  </p>
                </div>
              )}

              {!running && !runError && run && (
                <>
                  <p className={`${text.meta} mt-3`}>
                    {run.boundaries.periodKey} · covering {run.boundaries.from} to {run.boundaries.to} ·{' '}
                    {run.scope.isAll ? 'all branches' : `branch ${run.scope.branchId}`}
                  </p>

                  {run.isEmpty ? (
                    <div className="py-12 text-center">
                      <FileText className="w-7 h-7 text-slate-300 mx-auto mb-2" />
                      <p className="font-bold text-slate-700">No activity in this period.</p>
                      <p className={text.hint}>
                        Every metric returned zero. The report ran successfully — there is nothing to
                        show for {run.boundaries.periodKey}.
                      </p>
                    </div>
                  ) : (
                    <div className="mt-4 overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-slate-200">
                            <th className="text-start py-2 font-bold text-slate-600">Metric</th>
                            <th className="text-end py-2 font-bold text-slate-600">Value</th>
                            <th className="text-start py-2 font-bold text-slate-600 hidden md:table-cell">
                              Definition
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {run.metrics.map((m) => (
                            <tr key={m.id} className="border-b border-slate-50">
                              <td className="py-2.5 font-semibold text-slate-800">{m.label}</td>
                              <td className="py-2.5 text-end tabular-nums font-mono font-bold text-slate-900">
                                {formatMetric(m.value, m.unit)}
                              </td>
                              <td className="py-2.5 text-slate-500 hidden md:table-cell">{m.note}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
