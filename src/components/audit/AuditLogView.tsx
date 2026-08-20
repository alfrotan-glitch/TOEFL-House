/**
 * Audit log — server-filtered and paginated.
 * Queries GET /api/audit-logs (owner/manager only) with operator, action and
 * date-range filters plus paging; the server applies filters in SQL and
 * returns the total, so the full immutable history stays navigable at scale.
 */
import { text } from '../../design-system/styles';
import React, { useEffect, useState, useCallback } from 'react';
import { Search, RefreshCw } from 'lucide-react';
import { api } from '../../api/client';
import { useDatasetVersion } from '../../state/serverStateFreshness';
import { ShamsiDateInput } from '../common/ShamsiDateInput';

interface AuditLogRow {
  id: string;
  operator_name: string;
  action: string;
  date: string;
  time: string;
  old_value: string | null;
  new_value: string | null;
  ip: string;
  device: string;
  branch_id: string | null;
}

const PAGE_SIZE = 200;

export default function AuditLogView() {
  const [rows, setRows] = useState<AuditLogRow[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [operatorName, setOperatorName] = useState('');
  const [action, setAction] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const fetchPage = useCallback(async (offset: number, append: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{ rows: AuditLogRow[]; total: number }>('/audit-logs', {
        operatorName: operatorName || undefined,
        action: action || undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        limit: String(PAGE_SIZE),
        offset: String(offset),
        includeTotal: '1',
      });
      setRows((prev) => (append ? [...prev, ...res.rows] : res.rows));
      setTotal(res.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the audit log.');
    } finally {
      setLoading(false);
    }
  }, [operatorName, action, dateFrom, dateTo]);

  // Every backend mutation writes an audit row, so the trail is stale after any
  // successful write anywhere in the app.
  const auditVersion = useDatasetVersion('audit');
  useEffect(() => {
    void (async () => { setRows([]); setTotal(null); await fetchPage(0, false); })();
  }, [fetchPage, auditVersion]);

  return (
    <div className="space-y-5 text-start">
      <div className="flex flex-col md:flex-row gap-3 items-start md:items-end justify-between">
        <div>
          <h2 className="text-xl font-extrabold text-slate-900">Audit Log</h2>
          <p className={text.hint}>Append-only, searchable change history for financial and operational actions.</p>
        </div>
        <button type="button" onClick={() => void fetchPage(0, false)} className="px-3 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-[11px] font-bold cursor-pointer flex items-center gap-1.5"><RefreshCw className="w-3.5 h-3.5" /> Refresh</button>
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
        <div className="space-y-1">
          <label className="text-[10px] font-bold text-slate-400 uppercase">Operator</label>
          <input value={operatorName} onChange={(e) => setOperatorName(e.target.value)} placeholder="e.g. Ahmad" className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500/10" />
        </div>
        <div className="space-y-1">
          <label className="text-[10px] font-bold text-slate-400 uppercase">Action</label>
          <input value={action} onChange={(e) => setAction(e.target.value)} placeholder="e.g. Refund, Payment" className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500/10" />
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
          <span className="text-[11px] font-bold text-slate-500 flex items-center gap-1.5"><Search className="w-3.5 h-3.5" /> {total !== null ? `${total} events matched` : 'Searching…'}</span>
          {loading && <span className="text-[10px] text-slate-400 animate-pulse">Loading…</span>}
        </div>
        {error && <div className="px-5 py-3 text-[11px] font-semibold text-rose-700 bg-rose-50 border-b border-rose-100">{error}</div>}
        <div className="overflow-x-auto">
          <table className="w-full text-start text-xs">
            <thead>
              <tr className="border-b border-slate-100 text-slate-500">
                <th className="py-2.5 px-4 font-bold">Date / Time</th>
                <th className="py-2.5 px-4 font-bold">Operator</th>
                <th className="py-2.5 px-4 font-bold">Action</th>
                <th className="py-2.5 px-4 font-bold">IP</th>
                <th className="py-2.5 px-4 font-bold">Branch</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading ? (
                <tr><td colSpan={5} className="text-center py-10 text-slate-400">No audit events match these filters.</td></tr>
              ) : rows.map((log) => (
                <tr key={log.id} className="border-b border-slate-50 hover:bg-slate-50/60">
                  <td className="py-2.5 px-4 font-mono text-slate-500 whitespace-nowrap">{log.date} {log.time}</td>
                  <td className="py-2.5 px-4 font-semibold text-slate-800">{log.operator_name}</td>
                  <td className="py-2.5 px-4 text-slate-700">{log.action}</td>
                  <td className="py-2.5 px-4 font-mono text-[10px] text-slate-400">{log.ip}</td>
                  <td className="py-2.5 px-4 font-mono text-[10px] text-slate-400">{log.branch_id || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {total !== null && rows.length < total && (
          <div className="px-5 py-3">
            <button type="button" onClick={() => void fetchPage(rows.length, true)} disabled={loading} className="w-full py-2.5 rounded-xl bg-slate-50 hover:bg-slate-100 text-[11px] font-bold text-indigo-700 cursor-pointer disabled:opacity-50">
              {loading ? 'Loading…' : `Load more (${total - rows.length} remaining)`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
