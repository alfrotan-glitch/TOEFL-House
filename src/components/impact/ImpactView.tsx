import { text, control } from '../../design-system/styles';
import React, { useState } from 'react';
import { Heart, FileText, TrendingUp } from 'lucide-react';
import { recentJalaliPeriods, jalaliPeriodLabel } from '../../utils/jalali';

export default function ImpactView({ reports, generateReport }: any) {
  const r = reports || [];
  /**
   * The period is chosen, not assumed. Posting a hard-coded '2026-Q1' sends a
   * GREGORIAN key, which the server refuses: impact reports resolve their
   * period through the Shamsi calendar authority like every other report.
   * Offering real Shamsi months from the calendar helper lets the operator
   * generate a report for any recent period, and the key cannot disagree with
   * what the server accepts.
   */
  const periodOptions = recentJalaliPeriods(12, 0);
  const [period, setPeriod] = useState<string>(periodOptions[0]);
  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-gradient-to-br from-pink-500 to-rose-500 rounded-xl flex items-center justify-center">
            <Heart className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-black text-slate-900">Impact reports</h1>
            <p className="text-sm text-slate-500">Social and educational impact of projects</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-gradient-to-br from-pink-50 to-rose-50 border border-pink-200 rounded-2xl p-6">
          <div className="flex items-center gap-2 mb-2"><TrendingUp className="w-5 h-5 text-pink-600" /><p className="text-xs font-bold text-pink-700">Students covered</p></div>
          <p className="text-4xl font-black text-pink-900">0</p>
        </div>
        <div className="bg-gradient-to-br from-purple-50 to-violet-50 border border-purple-200 rounded-2xl p-6">
          <div className="flex items-center gap-2 mb-2"><FileText className="w-5 h-5 text-purple-600" /><p className="text-xs font-bold text-purple-700">Published reports</p></div>
          <p className="text-4xl font-black text-purple-900">{r.length}</p>
        </div>
        <div className="bg-gradient-to-br from-indigo-50 to-blue-50 border border-indigo-200 rounded-2xl p-6">
          <div className="flex items-center gap-2 mb-2"><Heart className="w-5 h-5 text-indigo-600" /><p className="text-xs font-bold text-indigo-700">Course completion rate</p></div>
          <p className="text-4xl font-black text-indigo-900">0%</p>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-slate-900">Impact reports</h2>
          <div className="flex items-center gap-2">
            <label htmlFor="impact-period" className="sr-only">Report period</label>
            <select
              id="impact-period"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              className={control.select}
            >
              {periodOptions.map((key) => (
                <option key={key} value={key}>{jalaliPeriodLabel(key)}</option>
              ))}
            </select>
            <button onClick={() => generateReport && generateReport(period)} className="flex items-center gap-2 px-4 py-2 bg-pink-600 hover:bg-pink-700 text-white text-sm font-bold rounded-xl cursor-pointer">
              <FileText className="w-4 h-4" /> Generate new report
            </button>
          </div>
        </div>
        {r.length === 0 ? (
          <p className="text-center text-slate-400 py-12">No reports generated yet.</p>
        ) : (
          <div className="space-y-3">
            {r.map((x: any) => (
              <div key={x.id} className="bg-slate-50 border border-slate-200 rounded-xl p-4">
                <h3 className="font-bold text-slate-900">{x.title}</h3>
                <p className={text.hint}>{x.period}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}