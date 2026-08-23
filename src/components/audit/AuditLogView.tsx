/**
 * Audit workspace — server-filtered and paginated.
 *
 * The browser consumes authoritative audit projections from the server:
 * append-only audit rows plus the durable audit-failure side-channel. Filters,
 * totals, paging and branch scope all execute on the backend so the UI never
 * reconstructs history from a local cache.
 */
import { text } from '../../design-system/styles';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, RefreshCw, Search, ShieldAlert } from 'lucide-react';
import { api } from '../../api/client';
import { useDatasetVersion } from '../../state/serverStateFreshness';
import { ShamsiDateInput } from '../common/ShamsiDateInput';
import type { AuditFailure, AuditLog, PaginatedRows } from '../../types';

type AuditTab = 'log' | 'failures';

const PAGE_SIZE = 200;

function prettySnapshot(value: string | null): string {
  if (!value) return '—';
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

export default function AuditLogView() {
  const [activeTab, setActiveTab] = useState<AuditTab>('log');
  const [logRows, setLogRows] = useState<AuditLog[]>([]);
  const [logTotal, setLogTotal] = useState<number | null>(null);
  const [failureRows, setFailureRows] = useState<AuditFailure[]>([]);
  const [failureTotal, setFailureTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [operatorName, setOperatorName] = useState('');
  const [action, setAction] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const filters = useMemo(() => ({
    action: action || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
  }), [action, dateFrom, dateTo]);

  const fetchLogs = useCallback(async (offset: number, append: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<PaginatedRows<AuditLog>>('/audit-logs', {
        operatorName: operatorName || undefined,
        ...filters,
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      setLogRows((prev) => (append ? [...prev, ...res.rows] : res.rows));
      setLogTotal(res.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the audit log.');
    } finally {
      setLoading(false);
    }
  }, [filters, operatorName]);

  const fetchFailures = useCallback(async (offset: number, append: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<PaginatedRows<AuditFailure>>('/audit-logs/failures', {
        error: operatorName || undefined,
        ...filters,
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      setFailureRows((prev) => (append ? [...prev, ...res.rows] : res.rows));
      setFailureTotal(res.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load audit failures.');
    } finally {
      setLoading(false);
    }
  }, [filters, operatorName]);

  // Every backend mutation writes an audit row, so the trail is stale after any
  // successful write anywhere in the app.
  const auditVersion = useDatasetVersion('audit');
  useEffect(() => {
    void (async () => {
      setError(null);
      if (activeTab === 'log') {
        setLogRows([]);
        setLogTotal(null);
        await fetchLogs(0, false);
        return;
      }
      setFailureRows([]);
      setFailureTotal(null);
      await fetchFailures(0, false);
    })();
  }, [activeTab, fetchFailures, fetchLogs, auditVersion]);

  const total = activeTab === 'log' ? logTotal : failureTotal;
  const rowsRemaining = activeTab === 'log'
    ? Math.max((logTotal ?? 0) - logRows.length, 0)
    : Math.max((failureTotal ?? 0) - failureRows.length, 0);

  return (
    <div className="space-y-5 text-start">
      <div className="flex flex-col md:flex-row gap-3 items-start md:items-end justify-between">
        <div>
          <h2 className="text-xl font-extrabold text-slate-900">Audit Log</h2>
          <p className={text.hint}>Append-only change history plus durable audit-write failure visibility.</p>
        </div>
        <button
          type="button"
          onClick={() => void (activeTab === 'log' ? fetchLogs(0, false) : fetchFailures(0, false))}
          className="px-3 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-[11px] font-bold cursor-pointer flex items-center gap-1.5"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>

      <div className="flex gap-1 bg-slate-100 rounded-xl p-1 w-full sm:w-fit">
        <button
          type="button"
          onClick={() => setActiveTab('log')}
          className={`px-3 py-2 rounded-lg text-xs font-bold ${activeTab === 'log' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500'}`}
        >
          Audit trail
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('failures')}
          className={`px-3 py-2 rounded-lg text-xs font-bold ${activeTab === 'failures' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500'}`}
        >
          Audit write failures
        </button>
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
        <div className="space-y-1">
          <label className="text-[10px] font-bold text-slate-400 uppercase">{activeTab === 'log' ? 'Operator' : 'Error contains'}</label>
          <input
            value={operatorName}
            onChange={(e) => setOperatorName(e.target.value)}
            placeholder={activeTab === 'log' ? 'e.g. Ahmad' : 'e.g. UNIQUE constraint'}
            className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500/10"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[10px] font-bold text-slate-400 uppercase">Action</label>
          <input
            value={action}
            onChange={(e) => setAction(e.target.value)}
            placeholder="e.g. Refund, Payment"
            className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500/10"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[10px] font-bold text-slate-400 uppercase">From</label>
          <ShamsiDateInput value={dateFrom} onChange={setDateFrom} />
        </div>
        <div className="space-y-1">
          <label className="text-[10px] font-bold text-slate-400 uppercase">To</label>
          <ShamsiDateInput value={dateTo} onChange={setDateTo} />
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm">
        <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
          <span className="text-[11px] font-bold text-slate-500 flex items-center gap-1.5">
            {activeTab === 'log' ? <Search className="w-3.5 h-3.5" /> : <ShieldAlert className="w-3.5 h-3.5" />}
            {total !== null ? `${total} ${activeTab === 'log' ? 'events' : 'failures'} matched` : 'Searching…'}
          </span>
          {loading && <span className="text-[10px] text-slate-400 animate-pulse">Loading…</span>}
        </div>
        {error && <div className="px-5 py-3 text-[11px] font-semibold text-rose-700 bg-rose-50 border-b border-rose-100">{error}</div>}
        <div className="overflow-x-auto">
          {activeTab === 'log' ? (
            <table className="w-full text-start text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-slate-500">
                  <th className="py-2.5 px-4 font-bold">Date / Time</th>
                  <th className="py-2.5 px-4 font-bold">Operator</th>
                  <th className="py-2.5 px-4 font-bold">Action</th>
                  <th className="py-2.5 px-4 font-bold">Branch</th>
                  <th className="py-2.5 px-4 font-bold">Details</th>
                </tr>
              </thead>
              <tbody>
                {logRows.length === 0 && !loading ? (
                  <tr><td colSpan={5} className="text-center py-10 text-slate-400">No audit events match these filters.</td></tr>
                ) : logRows.map((log) => (
                  <tr key={log.id} className="border-b border-slate-50 hover:bg-slate-50/60 align-top">
                    <td className="py-2.5 px-4 font-mono text-slate-500 whitespace-nowrap">{log.date} {log.time}</td>
                    <td className="py-2.5 px-4">
                      <p className="font-semibold text-slate-800">{log.operatorName || 'System'}</p>
                      <p className="text-[10px] text-slate-400">{log.operatorRole || '—'}</p>
                    </td>
                    <td className="py-2.5 px-4 text-slate-700">{log.action}</td>
                    <td className="py-2.5 px-4 font-mono text-[10px] text-slate-400">{log.branchId || '—'}</td>
                    <td className="py-2.5 px-4">
                      <details className="rounded-lg border border-slate-200 bg-slate-50 p-2">
                        <summary className="cursor-pointer list-none text-[11px] font-bold text-indigo-700 flex items-center gap-1.5">
                          <AlertTriangle className="w-3.5 h-3.5" /> Inspect row
                        </summary>
                        <div className="mt-2 space-y-2">
                          <div>
                            <p className="text-[10px] font-bold uppercase text-slate-400">Before</p>
                            <pre className="mt-1 whitespace-pre-wrap break-all rounded-lg bg-white p-2 text-[10px] text-slate-600">{prettySnapshot(log.oldValue)}</pre>
                          </div>
                          <div>
                            <p className="text-[10px] font-bold uppercase text-slate-400">After</p>
                            <pre className="mt-1 whitespace-pre-wrap break-all rounded-lg bg-white p-2 text-[10px] text-slate-600">{prettySnapshot(log.newValue)}</pre>
                          </div>
                          <p className="text-[10px] text-slate-400 break-all">IP: {log.ip || '—'} · Device: {log.device || '—'}</p>
                        </div>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="w-full text-start text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-slate-500">
                  <th className="py-2.5 px-4 font-bold">Occurred</th>
                  <th className="py-2.5 px-4 font-bold">Action</th>
                  <th className="py-2.5 px-4 font-bold">Error</th>
                  <th className="py-2.5 px-4 font-bold">Branch</th>
                  <th className="py-2.5 px-4 font-bold">Details</th>
                </tr>
              </thead>
              <tbody>
                {failureRows.length === 0 && !loading ? (
                  <tr><td colSpan={5} className="text-center py-10 text-slate-400">No audit failures match these filters.</td></tr>
                ) : failureRows.map((failure) => (
                  <tr key={failure.id} className="border-b border-slate-50 hover:bg-slate-50/60 align-top">
                    <td className="py-2.5 px-4 font-mono text-slate-500 whitespace-nowrap">{failure.occurredAt}</td>
                    <td className="py-2.5 px-4 text-slate-700">{failure.action}</td>
                    <td className="py-2.5 px-4 text-rose-700 font-semibold">{failure.error}</td>
                    <td className="py-2.5 px-4 font-mono text-[10px] text-slate-400">{failure.branchId || '—'}</td>
                    <td className="py-2.5 px-4">
                      <details className="rounded-lg border border-slate-200 bg-slate-50 p-2">
                        <summary className="cursor-pointer list-none text-[11px] font-bold text-indigo-700 flex items-center gap-1.5">
                          <ShieldAlert className="w-3.5 h-3.5" /> Inspect failure
                        </summary>
                        <div className="mt-2 space-y-2">
                          <p className="text-[10px] text-slate-500 break-all">Request ID: {failure.requestId || '—'}</p>
                          <p className="text-[10px] text-slate-500 break-all">Operator ID: {failure.operatorId || '—'}</p>
                          <div>
                            <p className="text-[10px] font-bold uppercase text-slate-400">Captured payload</p>
                            <pre className="mt-1 whitespace-pre-wrap break-all rounded-lg bg-white p-2 text-[10px] text-slate-600">{prettySnapshot(failure.payload)}</pre>
                          </div>
                        </div>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {total !== null && rowsRemaining > 0 && (
          <div className="px-5 py-3">
            <button
              type="button"
              onClick={() => void (activeTab === 'log'
                ? fetchLogs(logRows.length, true)
                : fetchFailures(failureRows.length, true))}
              disabled={loading}
              className="w-full py-2.5 rounded-xl bg-slate-50 hover:bg-slate-100 text-[11px] font-bold text-indigo-700 cursor-pointer disabled:opacity-50"
            >
              {loading ? 'Loading…' : `Load more (${rowsRemaining} remaining)`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
