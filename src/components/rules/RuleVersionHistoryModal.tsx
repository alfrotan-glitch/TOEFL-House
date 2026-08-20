/**
 * TOEFL House ERP — Rule Version History Modal
 */
import { text } from '../../design-system/styles';
import React, { useEffect, useState } from 'react';
import { X, RotateCcw, AlertTriangle, History, Loader2, Filter } from 'lucide-react';
import type { BusinessRule, BusinessRuleVersion } from '../../types';
import { formatJalaliDateTime } from '../../utils/jalali';

interface Props {
  rule: BusinessRule;
  getBusinessRuleVersions: (ruleId: string) => Promise<BusinessRuleVersion[]>;
  onRollback: (version: number) => Promise<void>;
  onClose: () => void;
}

export default function RuleVersionHistoryModal({ rule, getBusinessRuleVersions, onRollback, onClose }: Props) {
  const [versions, setVersions] = useState<BusinessRuleVersion[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rollingBackTo, setRollingBackTo] = useState<number | null>(null);

  useEffect(() => {
    void (async () => {
      setIsLoading(true);
      try {
        setVersions(await getBusinessRuleVersions(rule.id));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load history.');
      } finally {
        setIsLoading(false);
      }
    })();
  }, [rule.id, getBusinessRuleVersions]);

  const handleRollback = async (version: number) => {
    setRollingBackTo(version);
    setError(null);
    try {
      await onRollback(version);
    } catch (err: any) {
      setError(err?.message || 'Restore failed.');
      setRollingBackTo(null);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4 animate-in fade-in duration-200" onClick={onClose}>
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col border border-slate-200" onClick={e => e.stopPropagation()}>
        
        <div className="p-5 border-b border-slate-100 flex items-center justify-between shrink-0 bg-slate-50 rounded-t-3xl">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-50 flex items-center justify-center text-indigo-600 border border-indigo-100"><History className="w-5 h-5" /></div>
            <div>
              <h2 className="text-base font-extrabold text-slate-900">Version History</h2>
              <p className="text-[11px] text-slate-500 font-mono truncate max-w-[200px]">{rule.name}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-200 rounded-xl text-slate-500 cursor-pointer transition-colors"><X className="w-5 h-5" /></button>
        </div>

        <div className="overflow-y-auto p-6 flex-1 bg-white">
          {error && (
            <div className="bg-rose-50 border border-rose-200 text-rose-700 text-xs font-semibold rounded-xl p-3 flex items-center gap-2 mb-4">
              <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
            </div>
          )}

          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-12 text-slate-400">
              <Loader2 className="w-6 h-6 animate-spin mb-2" />
              <p className="text-xs">Loading history...</p>
            </div>
          ) : versions.length === 0 ? (
            <div className="text-center py-12">
              <History className="w-8 h-8 text-slate-300 mx-auto mb-2" />
              <p className="text-sm text-slate-400">No version history available.</p>
            </div>
          ) : (
            <div className="relative ps-8 space-y-6">
              <div className="absolute start-3 top-2 bottom-2 w-0.5 bg-slate-200"></div>
              
              {versions.slice().sort((a, b) => b.version - a.version).map(v => {
                const isCurrent = v.version === rule.version;
                return (
                  <div key={v.version} className="relative">
                    <div className={`absolute -left-8 top-1 w-6 h-6 rounded-full flex items-center justify-center border-2 border-white ring-1 ${isCurrent ? 'bg-emerald-500 ring-emerald-500' : 'bg-slate-300 ring-slate-300'}`}>
                      {isCurrent && <div className="w-2 h-2 bg-white rounded-full"></div>}
                    </div>

                    <div className={`bg-slate-50 border rounded-2xl p-4 transition-all ${isCurrent ? 'border-emerald-200 shadow-sm' : 'border-slate-200'}`}>
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className={text.value}>Version {v.version}</span>
                          {isCurrent && <span className="text-[10px] font-bold bg-emerald-100 text-emerald-700 rounded-full px-2 py-0.5">Current</span>}
                          {!v.isActive && !isCurrent && <span className="text-[10px] font-bold bg-slate-200 text-slate-500 rounded-full px-2 py-0.5">Inactive</span>}
                        </div>
                        {!isCurrent && (
                          <button disabled={rollingBackTo === v.version} onClick={() => handleRollback(v.version)} className="text-[11px] font-bold text-indigo-600 hover:bg-indigo-50 rounded-lg px-2.5 py-1.5 flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer">
                            {rollingBackTo === v.version ? <><Loader2 className="w-3 h-3 animate-spin" /> Restoring...</> : <><RotateCcw className="w-3.5 h-3.5" /> Restore</>}
                          </button>
                        )}
                      </div>
                      
                      <p className="text-[11px] text-slate-500 mb-3">Edited by <span className="font-semibold text-slate-700">{v.modifiedBy}</span> on {formatJalaliDateTime(v.modifiedAt)}</p>

                      <div className="mt-2 pt-2 border-t border-slate-200">
                        <p className="flex items-center gap-1 text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5"><Filter className="w-3 h-3" /> Conditions</p>
                        <div className="flex flex-wrap gap-1">
                          {v.conditions.length === 0 ? (
                            <span className="text-[10px] bg-white border border-dashed border-slate-200 rounded-lg px-2 py-1 text-slate-400">No conditions</span>
                          ) : (
                            v.conditions.map((c, i) => <span key={i} className="text-[10px] bg-violet-50 border border-violet-100 rounded-lg px-2 py-1 text-violet-700 font-mono">{c.field} {c.operator} {Array.isArray(c.value) ? c.value.join(',') : String(c.value)}</span>)
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="p-4 border-t border-slate-100 flex justify-end shrink-0 bg-slate-50 rounded-b-3xl">
          <button onClick={onClose} className="text-xs font-bold text-slate-600 hover:bg-slate-200 rounded-xl px-5 py-2.5 transition-colors cursor-pointer">Close</button>
        </div>
      </div>
    </div>
  );
}