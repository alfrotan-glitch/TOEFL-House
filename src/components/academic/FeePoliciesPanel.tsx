import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Check, DollarSign, Loader2, Pencil, Plus, RefreshCw, X } from 'lucide-react';
import { api } from '../../api/client';
import { useInvalidate } from '../../state/serverStateFreshness';
import { formatAFN } from '../../utils/format';

interface FeeRuleRow {
  id: string;
  branchId: string;
  feeType: string;
  name: string;
  amount: number;
  currency: string;
  isOptional: boolean;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  version: number;
  isActive: boolean;
  programVersionId: string | null;
  versionLabel: string | null;
  levelId: string | null;
  levelName: string | null;
  createdAt: string;
}

interface ProgramVersion {
  id: string;
  versionLabel: string;
  status: string;
}

interface Level {
  id: string;
  name: string;
  programVersionId?: string | null;
}

const OPERATIONAL_FEE_TYPES = [
  { value: 'placement', label: 'Placement Test' },
  { value: 'registration', label: 'Registration' },
  { value: 'diploma', label: 'Certificate / Diploma' },
  { value: 'card', label: 'ID Card' },
] as const;

const inputCls = 'w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 transition-all';
const labelCls = 'mb-1.5 block text-[10px] font-extrabold uppercase tracking-wider text-slate-500';

const emptyForm = {
  feeType: 'placement',
  name: 'Placement Test fee',
  amount: 0,
  isActive: true,
  isOptional: false,
  effectiveFrom: '',
  effectiveTo: '',
  programVersionId: '',
  levelId: '',
};

export default function FeePoliciesPanel({
  branchId,
  canEdit,
}: {
  branchId?: string;
  canEdit: boolean;
}) {
  const invalidate = useInvalidate();
  const [items, setItems] = useState<FeeRuleRow[]>([]);
  const [versions, setVersions] = useState<ProgramVersion[]>([]);
  const [levels, setLevels] = useState<Level[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<FeeRuleRow | null>(null);
  const [form, setForm] = useState(emptyForm);

  const load = useCallback(async () => {
    if (!branchId) return;
    setLoading(true);
    setError('');
    try {
      const query = { branchId };
      const [feeRules, versionRows, levelRows] = await Promise.all([
        api.get<FeeRuleRow[]>('/catalog/fee-rules', query),
        api.get<ProgramVersion[]>('/catalog/program-versions', query),
        api.get<Level[]>('/academic/levels', query),
      ]);
      setItems(Array.isArray(feeRules) ? feeRules : []);
      setVersions(Array.isArray(versionRows) ? versionRows.filter((row) => row.status !== 'archived') : []);
      setLevels(Array.isArray(levelRows) ? levelRows : []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load fee rules.');
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  useEffect(() => {
    void load();
  }, [load]);

  const operationalItems = useMemo(() => items.filter((row) =>
    OPERATIONAL_FEE_TYPES.some((type) => type.value === row.feeType)
  ), [items]);

  const filteredLevels = useMemo(() =>
    levels.filter((row) => !form.programVersionId || row.programVersionId === form.programVersionId),
  [levels, form.programVersionId]);

  const resetForm = () => {
    setEditing(null);
    setForm(emptyForm);
    setShowForm(false);
  };

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setShowForm(true);
  };

  const openEdit = (row: FeeRuleRow) => {
    setEditing(row);
    setForm({
      feeType: row.feeType,
      name: row.name,
      amount: row.amount,
      isActive: row.isActive,
      isOptional: row.isOptional,
      effectiveFrom: row.effectiveFrom ?? '',
      effectiveTo: row.effectiveTo ?? '',
      programVersionId: row.programVersionId ?? '',
      levelId: row.levelId ?? '',
    });
    setShowForm(true);
  };

  const save = async () => {
    if (!branchId) return;
    setSaving(true);
    setError('');
    try {
      const payload = {
        branchId,
        feeType: form.feeType,
        name: form.name.trim() || `${form.feeType} fee`,
        amount: Number(form.amount),
        isActive: form.isActive,
        isOptional: form.isOptional,
        effectiveFrom: form.effectiveFrom || null,
        effectiveTo: form.effectiveTo || null,
        programVersionId: form.programVersionId || null,
        levelId: form.levelId || null,
      };
      if (editing) await api.put(`/catalog/fee-rules/${editing.id}`, payload);
      else await api.post('/catalog/fee-rules', payload);
      invalidate('academic', 'offerings');
      resetForm();
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save fee rule.');
    } finally {
      setSaving(false);
    }
  };

  if (!branchId) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 py-16 text-center">
        <DollarSign className="mx-auto mb-3 h-10 w-10 text-slate-300" />
        <p className="text-xs text-slate-400">Select a branch to manage operational fee policies.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-indigo-50 p-2"><DollarSign className="h-5 w-5 text-indigo-600" /></div>
          <div>
            <h3 className="text-base font-extrabold text-slate-900">Operational Fee Policies</h3>
            <p className="mt-1 text-[11px] text-slate-500">Configure service fees in the canonical policy registry with amount, active state, effective dates and scope. Tuition stays in Programs &amp; Levels so this screen does not create a second tuition system.</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => void load()} className="inline-flex items-center gap-1 rounded-xl border border-slate-200 px-3 py-2 text-[11px] font-bold text-slate-600 hover:bg-slate-50">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh
          </button>
          <button type="button" onClick={openCreate} disabled={!canEdit} className="inline-flex items-center gap-1 rounded-xl bg-indigo-600 px-3 py-2 text-[11px] font-bold text-white disabled:opacity-50 hover:bg-indigo-700 shadow-sm">
            <Plus className="h-3.5 w-3.5" /> New Fee Rule
          </button>
        </div>
      </div>

      {!canEdit && (
        <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-bold text-amber-800">
          You can review fee policies, but changing them requires the <span className="font-mono">FeeStructure.Edit</span> permission.
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-[11px] text-rose-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button type="button" onClick={() => setError('')} className="font-bold underline">Dismiss</button>
        </div>
      )}

      {loading ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50 py-16 text-slate-400">
          <Loader2 className="mb-3 h-8 w-8 animate-spin text-indigo-500" />
          <p className="text-xs font-semibold uppercase tracking-wide">Loading fee policies…</p>
        </div>
      ) : operationalItems.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 py-16 text-center">
          <DollarSign className="mx-auto mb-3 h-10 w-10 text-slate-300" />
          <p className="text-sm font-bold text-slate-600">No operational fee rules yet</p>
          <p className="mt-1 text-xs text-slate-400">Create explicit policies for registration, placement, certificates, and ID cards. Missing required fees will now block the transaction.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {operationalItems.map((row) => (
            <div key={row.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-extrabold text-slate-900 break-words">{row.name}</p>
                  <p className="mt-1 text-[10px] font-mono text-slate-400">{row.feeType} · v{row.version}</p>
                </div>
                <span className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-bold ${row.isActive ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-slate-100 text-slate-600'}`}>
                  {row.isActive ? 'Active' : 'Inactive'}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-[11px]">
                <div className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
                  <div className="text-[9px] font-bold uppercase text-slate-400">Amount</div>
                  <div className="mt-1 font-extrabold text-slate-900">{formatAFN(row.amount)}</div>
                </div>
                <div className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
                  <div className="text-[9px] font-bold uppercase text-slate-400">Scope</div>
                  <div className="mt-1 font-bold text-slate-700 break-words">{row.levelName || row.versionLabel || 'Branch-wide'}</div>
                </div>
                <div className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
                  <div className="text-[9px] font-bold uppercase text-slate-400">Effective</div>
                  <div className="mt-1 font-bold text-slate-700">{row.effectiveFrom || 'Immediately'}</div>
                </div>
                <div className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
                  <div className="text-[9px] font-bold uppercase text-slate-400">Ends</div>
                  <div className="mt-1 font-bold text-slate-700">{row.effectiveTo || 'Open-ended'}</div>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
                <span className="rounded-full bg-slate-100 px-2 py-1 font-bold">{row.isOptional ? 'Optional fee' : 'Required fee'}</span>
                {row.versionLabel && <span className="rounded-full bg-indigo-50 px-2 py-1 font-bold text-indigo-700">Version: {row.versionLabel}</span>}
                {row.levelName && <span className="rounded-full bg-sky-50 px-2 py-1 font-bold text-sky-700">Level: {row.levelName}</span>}
              </div>
              <div className="mt-4 flex justify-end">
                <button type="button" onClick={() => openEdit(row)} disabled={!canEdit} className="inline-flex items-center gap-1 rounded-xl border border-slate-200 px-3 py-2 text-[11px] font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50">
                  <Pencil className="h-3.5 w-3.5" /> Edit
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm">
          <div className="w-full max-w-2xl overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-start justify-between border-b border-slate-100 px-6 py-5">
              <div>
                <h3 className="text-lg font-extrabold text-slate-900">{editing ? 'Edit Fee Rule' : 'Create Fee Rule'}</h3>
                <p className="mt-1 text-[11px] text-slate-500">Every change is audited and takes effect only within the scope you declare here.</p>
              </div>
              <button type="button" onClick={resetForm} className="rounded-lg p-2 hover:bg-slate-100"><X className="h-5 w-5 text-slate-500" /></button>
            </div>
            <div className="space-y-5 p-6">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div>
                  <label className={labelCls}>Fee type *</label>
                  <select value={form.feeType} onChange={(e) => setForm((current) => ({ ...current, feeType: e.target.value, name: `${OPERATIONAL_FEE_TYPES.find((row) => row.value === e.target.value)?.label || e.target.value} fee` }))} className={inputCls}>
                    {OPERATIONAL_FEE_TYPES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Name *</label>
                  <input value={form.name} onChange={(e) => setForm((current) => ({ ...current, name: e.target.value }))} className={inputCls} placeholder="Display name" />
                </div>
                <div>
                  <label className={labelCls}>Amount (AFN) *</label>
                  <input type="number" value={form.amount} onChange={(e) => setForm((current) => ({ ...current, amount: Number(e.target.value) }))} className={inputCls} min={0} step={1} />
                </div>
                <div>
                  <label className={labelCls}>Program version scope</label>
                  <select value={form.programVersionId} onChange={(e) => setForm((current) => ({ ...current, programVersionId: e.target.value, levelId: '' }))} className={inputCls}>
                    <option value="">Branch-wide</option>
                    {versions.map((row) => <option key={row.id} value={row.id}>{row.versionLabel}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Level scope</label>
                  <select value={form.levelId} onChange={(e) => setForm((current) => ({ ...current, levelId: e.target.value }))} className={inputCls}>
                    <option value="">All levels in scope</option>
                    {filteredLevels.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={labelCls}>Effective from</label>
                    <input type="date" value={form.effectiveFrom} onChange={(e) => setForm((current) => ({ ...current, effectiveFrom: e.target.value }))} className={inputCls} />
                  </div>
                  <div>
                    <label className={labelCls}>Effective to</label>
                    <input type="date" value={form.effectiveTo} onChange={(e) => setForm((current) => ({ ...current, effectiveTo: e.target.value }))} className={inputCls} />
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-700">
                  <input type="checkbox" checked={form.isActive} onChange={(e) => setForm((current) => ({ ...current, isActive: e.target.checked }))} /> Active now
                </label>
                <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-700">
                  <input type="checkbox" checked={form.isOptional} onChange={(e) => setForm((current) => ({ ...current, isOptional: e.target.checked }))} /> Optional fee
                </label>
              </div>

              <div className="rounded-xl border border-sky-100 bg-sky-50 px-4 py-3 text-[11px] text-sky-800">
                Zero is valid when the service is intentionally free. Missing configuration is not: required transactions will be blocked until an active rule exists.
              </div>

              <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-2">
                <button type="button" onClick={resetForm} className="rounded-xl bg-slate-100 px-4 py-2.5 text-xs font-bold text-slate-700">Cancel</button>
                <button type="button" onClick={() => void save()} disabled={saving || !canEdit} className="inline-flex items-center gap-1 rounded-xl bg-indigo-600 px-5 py-2.5 text-xs font-bold text-white disabled:opacity-50">
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} {editing ? 'Save Changes' : 'Create Fee Rule'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
