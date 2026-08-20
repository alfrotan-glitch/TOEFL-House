/**
 * TOEFL House ERP — Rule Test Panel (Dry Run)
 */
import React, { useState } from 'react';
import { X, Play, AlertTriangle, CheckCircle2, Terminal, Braces, XCircle } from 'lucide-react';
import type { RuleCategory, RuleEngineResult } from '../../types';
import type { CategoryMeta } from './RulesManagementView';

interface Props {
  categories: CategoryMeta[];
  evaluateBusinessRules: (category: RuleCategory, data: Record<string, unknown>, dryRun?: boolean) => Promise<RuleEngineResult>;
  onClose: () => void;
}

const EXAMPLE_PAYLOADS: Partial<Record<RuleCategory, string>> = {
  fee: '{\n  "isFirstPlacementTest": true,\n  "isFirstCertificate": true,\n  "isFirstCardIssuance": true,\n  "examScore": 92\n}',
  discount: '{\n  "discountPercent": 35\n}',
  promotion: '{\n  "examScore": 91\n}',
  attendance: '{\n  "attendanceRate": 62\n}',
  payroll: '{\n  "performanceScore": 95,\n  "baseDue": 20000\n}'
};

export default function RuleTestPanel({ categories, evaluateBusinessRules, onClose }: Props) {
  const [category, setCategory] = useState<RuleCategory>(categories[0]?.id ?? 'discount');
  const [rawJson, setRawJson] = useState(EXAMPLE_PAYLOADS[categories[0]?.id] || '{}');
  const [result, setResult] = useState<RuleEngineResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  const handleCategoryChange = (next: string) => {
    const cat = next as RuleCategory;
    setCategory(cat);
    setRawJson(EXAMPLE_PAYLOADS[cat] || '{}');
    setResult(null);
    setError(null);
  };

  const handleFormatJson = () => {
    try {
      const parsed = JSON.parse(rawJson);
      setRawJson(JSON.stringify(parsed, null, 2));
      setError(null);
    } catch {
      setError('Cannot format: Invalid JSON syntax.');
    }
  };

  const handleRun = async () => {
    setError(null);
    setResult(null);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      setError('Input is not valid JSON. Check for missing commas or quotes.');
      return;
    }
    setIsRunning(true);
    try {
      const res = await evaluateBusinessRules(category, parsed, true);
      setResult(res);
    } catch (err: any) {
      setError(err?.message || 'Test run failed. Check server logs.');
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4 animate-in fade-in duration-200" onClick={onClose}>
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col border border-slate-200" onClick={e => e.stopPropagation()}>
        
        <div className="p-5 border-b border-slate-100 flex items-center justify-between shrink-0 bg-slate-50 rounded-t-3xl">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-slate-900 flex items-center justify-center text-white"><Terminal className="w-5 h-5" /></div>
            <div>
              <h2 className="text-base font-extrabold text-slate-900">Rule Engine Dry-Run</h2>
              <p className="text-[11px] text-slate-500">Test your business logic without side effects.</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-200 rounded-xl text-slate-500 cursor-pointer transition-colors"><X className="w-5 h-5" /></button>
        </div>

        <div className="overflow-y-auto p-6 space-y-5 flex-1">
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-[11px] font-bold text-slate-600 block mb-1.5 uppercase tracking-wide">Rule Category</label>
              <select className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 bg-white cursor-pointer font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500/20" value={category} onChange={e => handleCategoryChange(e.target.value)}>
                {categories.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </div>
            <div className="flex items-end">
              <button onClick={handleFormatJson} className="text-xs font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl px-4 py-2.5 transition-colors flex items-center gap-1.5 cursor-pointer"><Braces className="w-3.5 h-3.5" /> Format JSON</button>
            </div>
          </div>

          <div>
            <label className="text-[11px] font-bold text-slate-600 block mb-1.5 uppercase tracking-wide">Input Context (JSON)</label>
            <textarea className="w-full text-xs font-mono border border-slate-700 bg-slate-900 text-emerald-300 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 min-h-[140px] resize-y" value={rawJson} onChange={e => setRawJson(e.target.value)} spellCheck="false" />
          </div>

          {error && (
            <div className="bg-rose-50 border border-rose-200 text-rose-700 text-xs font-semibold rounded-xl p-3 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
            </div>
          )}

          {result && (
            <div className="bg-slate-50 border border-slate-200 rounded-2xl p-5 space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
              
              <div className="flex items-center justify-between border-b border-slate-200 pb-3">
                <div className="flex items-center gap-2">
                  {result.isBlocked ? (
                    <span className="flex items-center gap-1.5 text-xs font-bold text-rose-700 bg-rose-100 rounded-full px-3 py-1"><XCircle className="w-3.5 h-3.5" /> Execution Blocked</span>
                  ) : (
                    <span className="flex items-center gap-1.5 text-xs font-bold text-emerald-700 bg-emerald-100 rounded-full px-3 py-1"><CheckCircle2 className="w-3.5 h-3.5" /> Execution Successful</span>
                  )}
                  <span className="text-[10px] font-mono text-slate-400 bg-slate-200 px-2 py-0.5 rounded-full">{result.totalExecutionTimeMs} ms</span>
                </div>
              </div>

              {result.blockReason && (
                <div className="text-xs text-rose-700 font-semibold bg-rose-50 p-2 rounded-lg border border-rose-100">Reason: {result.blockReason}</div>
              )}

              <div>
                <h4 className="text-[11px] font-extrabold text-slate-500 uppercase mb-2 flex items-center gap-1"><Braces className="w-3 h-3" /> Final Output</h4>
                <pre className="text-xs font-mono bg-white border border-slate-200 rounded-xl p-4 overflow-x-auto text-indigo-900">{JSON.stringify(result.finalOutputs, null, 2)}</pre>
              </div>

              {result.warnings.length > 0 && (
                <div>
                  <h4 className="text-[11px] font-extrabold text-amber-500 uppercase mb-2 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> Warnings</h4>
                  <ul className="text-xs text-amber-700 space-y-1 bg-amber-50 p-3 rounded-xl border border-amber-100">
                    {result.warnings.map((w, i) => <li key={i}>• {w}</li>)}
                  </ul>
                </div>
              )}

              <div>
                <h4 className="text-[11px] font-extrabold text-slate-500 uppercase mb-2">Evaluation Log ({result.evaluations.length})</h4>
                <div className="space-y-1.5 bg-white border border-slate-200 rounded-xl p-3">
                  {result.evaluations.map((e, i) => (
                    <div key={i} className="text-xs flex items-center justify-between border-b border-slate-50 last:border-0 pb-1.5 last:pb-0">
                      <div className="flex items-center gap-2">
                        {e.matched ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" /> : <XCircle className="w-3.5 h-3.5 text-slate-300" />}
                        <span className={`font-semibold ${e.matched ? 'text-slate-800' : 'text-slate-400'}`}>{e.ruleName}</span>
                      </div>
                      <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full ${e.matched ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-400'}`}>{e.matched ? 'Matched' : 'Rejected'}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-slate-100 flex justify-end gap-2 shrink-0 bg-slate-50 rounded-b-3xl">
          <button onClick={onClose} className="text-xs font-bold text-slate-600 hover:bg-slate-200 rounded-xl px-5 py-2.5 transition-colors cursor-pointer">Close</button>
          <button disabled={isRunning} onClick={handleRun} className="text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl px-5 py-2.5 flex items-center gap-1.5 shadow-md transition-colors cursor-pointer">
            <Play className="w-3.5 h-3.5" /> {isRunning ? 'Running…' : 'Execute Test'}
          </button>
        </div>
      </div>
    </div>
  );
}