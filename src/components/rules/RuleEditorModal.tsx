/**
 * TOEFL House ERP — Rule Editor Modal
 */
import React, { useState } from 'react';
import { X, Plus, Trash2, Save, Loader2, Filter, Zap, SlidersHorizontal, AlertCircle } from 'lucide-react';
import type { BusinessRule, BusinessRuleCondition, BusinessRuleAction, BusinessRuleOperator, RuleCategory } from '../../types';

interface Props {
  category: RuleCategory;
  existingRule: BusinessRule | null;
  onSave: (data: Partial<BusinessRule>) => Promise<void>;
  onClose: () => void;
  triggerToast: (message: string, type: 'success' | 'error' | 'info') => void;
}

const OPERATORS: { value: BusinessRuleOperator; label: string }[] = [
  { value: 'eq', label: 'Equals (=)' }, { value: 'neq', label: 'Not equals (≠)' },
  { value: 'gt', label: 'Greater than (>)' }, { value: 'gte', label: 'Greater or equal (≥)' },
  { value: 'lt', label: 'Less than (<)' }, { value: 'lte', label: 'Less or equal (≤)' },
  { value: 'in', label: 'In list (in)' }, { value: 'not_in', label: 'Not in list' },
  { value: 'contains', label: 'Contains' }, { value: 'between', label: 'Between' },
];

const ACTION_TYPES: { value: BusinessRuleAction['type']; label: string }[] = [
  { value: 'set_value', label: 'Set Value' }, { value: 'add_discount', label: 'Add Discount' },
  { value: 'calculate', label: 'Calculate Formula' }, { value: 'block', label: 'Block Operation' },
  { value: 'warn', label: 'Show Warning' }, { value: 'notify', label: 'Send Notification' },
  { value: 'trigger_event', label: 'Trigger Event' },
];

const emptyCondition = (): BusinessRuleCondition => ({ field: '', operator: 'eq', value: '' });
const emptyAction = (): BusinessRuleAction => ({ type: 'set_value', targetKey: '' });
const inputCls = "w-full text-xs border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 transition-all";
const labelCls = "block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5";

export default function RuleEditorModal({ category, existingRule, onSave, onClose }: Props) {
  const [name, setName] = useState(existingRule?.name || '');
  const [description, setDescription] = useState(existingRule?.description || '');
  const [priority, setPriority] = useState(existingRule?.priority ?? 0);
  const [isActive, setIsActive] = useState(existingRule?.isActive ?? true);
  const [conditions, setConditions] = useState<BusinessRuleCondition[]>(existingRule?.conditions?.length ? existingRule.conditions.map(c => ({ ...c })) : []);
  const [actions, setActions] = useState<BusinessRuleAction[]>(existingRule?.actions?.length ? existingRule.actions.map(a => ({ ...a })) : [emptyAction()]);
  const [isSaving, setIsSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const updateCondition = (idx: number, patch: Partial<BusinessRuleCondition>) => setConditions(prev => prev.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  const updateAction = (idx: number, patch: Partial<BusinessRuleAction>) => setActions(prev => prev.map((a, i) => (i === idx ? { ...a, ...patch } : a)));

  const handleSubmit = async () => {
    setValidationError(null);
    if (!name.trim()) return setValidationError('Rule name is required.');
    if (actions.length === 0 || actions.some(a => !a.targetKey.trim())) return setValidationError('Each action must have a Target Key.');
    
    setIsSaving(true);
    try {
      await onSave({ name: name.trim(), description: description.trim(), category, conditions, actions, priority, isActive });
    } catch {
      setValidationError('Failed to save rule.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4 animate-in fade-in duration-200" onClick={onClose}>
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col border border-slate-200" onClick={e => e.stopPropagation()}>
        
        <div className="p-6 border-b border-slate-100 flex items-center justify-between shrink-0 bg-slate-50 rounded-t-3xl">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center text-white shadow-md"><SlidersHorizontal className="w-5 h-5" /></div>
            <div>
              <h2 className="text-lg font-extrabold text-slate-900 tracking-tight">{existingRule ? 'Edit Rule' : 'Create New Rule'}</h2>
              <p className="text-xs text-slate-500 capitalize">Category: {category.replace('_', ' ')}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-200 rounded-xl text-slate-500 cursor-pointer transition-colors"><X className="w-5 h-5" /></button>
        </div>

        <div className="overflow-y-auto p-6 space-y-6 flex-1 bg-slate-50/50">
          {validationError && (
            <div className="bg-rose-50 border border-rose-200 text-rose-700 text-xs font-semibold rounded-xl p-3 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" /> {validationError}
            </div>
          )}

          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
            <h3 className="text-xs font-extrabold text-slate-700 uppercase tracking-wider mb-4">Basic Information</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="md:col-span-2"><label className={labelCls}>Rule Name *</label><input className={inputCls} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Friend Referral Discount" /></div>
              <div className="md:col-span-2"><label className={labelCls}>Description</label><textarea className={inputCls} rows={2} value={description} onChange={e => setDescription(e.target.value)} placeholder="Explain what this rule does..." /></div>
              <div><label className={labelCls}>Execution Priority</label><input type="number" className={inputCls} value={priority} onChange={e => setPriority(Number(e.target.value))} /><p className="text-[10px] text-slate-400 mt-1">Higher numbers execute first.</p></div>
              <div className="flex items-end pb-1"><label className="flex items-center gap-2 text-xs font-bold text-slate-600 cursor-pointer"><input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} className="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500" /> Rule is Active</label></div>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xs font-extrabold text-violet-700 uppercase tracking-wider flex items-center gap-1.5"><Filter className="w-3.5 h-3.5" /> If Conditions (AND logic)</h3>
              <button onClick={() => setConditions(prev => [...prev, emptyCondition()])} className="text-[11px] font-bold text-indigo-600 hover:bg-indigo-50 rounded-lg px-2.5 py-1.5 flex items-center gap-1 cursor-pointer transition-colors"><Plus className="w-3.5 h-3.5" /> Add Condition</button>
            </div>
            <div className="space-y-2">
              {conditions.map((cond, idx) => (
                <div key={idx} className="flex flex-wrap items-center gap-2 bg-violet-50/40 border border-violet-100 rounded-xl p-2.5">
                  <input className="flex-1 min-w-[120px] text-xs border border-slate-200 rounded-lg px-2 py-1.5 font-mono bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400" placeholder="field_name (e.g. examScore)" value={cond.field} onChange={e => updateCondition(idx, { field: e.target.value })} />
                  <select className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400 cursor-pointer" value={cond.operator} onChange={e => updateCondition(idx, { operator: e.target.value as BusinessRuleOperator })}>
                    {OPERATORS.map(op => <option key={op.value} value={op.value}>{op.label}</option>)}
                  </select>
                  {cond.operator === 'between' ? (
                    <div className="flex gap-1">
                      <input type="number" className="w-20 text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400" placeholder="Min" value={cond.rangeValue?.[0] ?? ''} onChange={e => updateCondition(idx, { rangeValue: [Number(e.target.value), cond.rangeValue?.[1] ?? 0] })} />
                      <input type="number" className="w-20 text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400" placeholder="Max" value={cond.rangeValue?.[1] ?? ''} onChange={e => updateCondition(idx, { rangeValue: [cond.rangeValue?.[0] ?? 0, Number(e.target.value)] })} />
                    </div>
                  ) : cond.operator === 'in' || cond.operator === 'not_in' ? (
                    <input className="flex-1 min-w-[100px] text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400" placeholder="Comma-separated (a,b,c)" value={Array.isArray(cond.value) ? cond.value.join(',') : String(cond.value)} onChange={e => updateCondition(idx, { value: e.target.value.split(',').map(v => v.trim()) })} />
                  ) : (
                    <input className="flex-1 min-w-[100px] text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400" placeholder="Value" value={typeof cond.value === 'boolean' ? String(cond.value) : (cond.value as string)} onChange={e => updateCondition(idx, { value: coerceValue(e.target.value) })} />
                  )}
                  <button onClick={() => setConditions(prev => prev.filter((_, i) => i !== idx))} className="p-1.5 text-rose-500 hover:bg-rose-50 rounded-lg shrink-0 cursor-pointer transition-colors"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              ))}
              {conditions.length === 0 && (
                <div className="text-[11px] text-slate-500 text-center py-4 bg-slate-50 rounded-xl border border-dashed border-slate-200">No conditions — this rule will always execute for this category.</div>
              )}
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xs font-extrabold text-emerald-700 uppercase tracking-wider flex items-center gap-1.5"><Zap className="w-3.5 h-3.5" /> Then Actions</h3>
              <button onClick={() => setActions(prev => [...prev, emptyAction()])} className="text-[11px] font-bold text-indigo-600 hover:bg-indigo-50 rounded-lg px-2.5 py-1.5 flex items-center gap-1 cursor-pointer transition-colors"><Plus className="w-3.5 h-3.5" /> Add Action</button>
            </div>
            <div className="space-y-3">
              {actions.map((act, idx) => (
                <div key={idx} className="bg-emerald-50/40 border border-emerald-100 rounded-xl p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <select className="flex-1 text-xs border border-slate-200 rounded-lg px-2 py-2 bg-white font-semibold focus:outline-none focus:ring-1 focus:ring-indigo-400 cursor-pointer" value={act.type} onChange={e => updateAction(idx, { type: e.target.value as BusinessRuleAction['type'] })}>
                      {ACTION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                    <input className="flex-1 text-xs border border-slate-200 rounded-lg px-2 py-2 font-mono bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400" placeholder="target_key (e.g. discountPercent)" value={act.targetKey} onChange={e => updateAction(idx, { targetKey: e.target.value })} />
                    <button onClick={() => setActions(prev => prev.filter((_, i) => i !== idx))} className="p-1.5 text-rose-500 hover:bg-rose-50 rounded-lg shrink-0 cursor-pointer transition-colors"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                  <div className="ps-2 border-l-2 border-emerald-200 ms-1 space-y-2">
                    {(act.type === 'set_value' || act.type === 'add_discount') && (
                      <input className="w-full text-xs border border-slate-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-400" placeholder="Value (number, text, true/false)" value={act.value !== undefined ? String(act.value) : ''} onChange={e => updateAction(idx, { value: coerceValue(e.target.value) })} />
                    )}
                    {act.type === 'calculate' && (
                      <input className="w-full text-xs border border-slate-200 rounded-lg px-2 py-1.5 font-mono focus:outline-none focus:ring-1 focus:ring-indigo-400" placeholder="Formula (e.g. baseFee * 0.9)" value={act.formula || ''} onChange={e => updateAction(idx, { formula: e.target.value })} />
                    )}
                    {(act.type === 'block' || act.type === 'warn') && (
                      <input className="w-full text-xs border border-slate-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-400" placeholder="Message to display" value={act.message || ''} onChange={e => updateAction(idx, { message: e.target.value })} />
                    )}
                    {act.type === 'notify' && (
                      <div className="flex flex-col sm:flex-row gap-2">
                        <select className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400 cursor-pointer" value={act.channel || 'internal'} onChange={e => updateAction(idx, { channel: e.target.value as any })}>
                          <option value="internal">Internal</option><option value="sms">SMS</option><option value="email">Email</option><option value="whatsapp">WhatsApp</option><option value="push">Push</option>
                        </select>
                        <input className="flex-1 text-xs border border-slate-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-400" placeholder="Message text" value={act.message || ''} onChange={e => updateAction(idx, { message: e.target.value })} />
                      </div>
                    )}
                    {act.type === 'trigger_event' && (
                      <input className="w-full text-xs border border-slate-200 rounded-lg px-2 py-1.5 font-mono focus:outline-none focus:ring-1 focus:ring-indigo-400" placeholder="Event name (e.g. student.promoted)" value={act.eventName || ''} onChange={e => updateAction(idx, { eventName: e.target.value })} />
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="p-4 border-t border-slate-100 flex justify-end gap-2 shrink-0 bg-slate-50 rounded-b-3xl">
          <button onClick={onClose} className="text-xs font-bold text-slate-600 hover:bg-slate-200 rounded-xl px-5 py-2.5 cursor-pointer transition-colors">Cancel</button>
          <button disabled={isSaving} onClick={handleSubmit} className="text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl px-5 py-2.5 flex items-center gap-1.5 shadow-md cursor-pointer transition-colors">
            {isSaving ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving...</> : <><Save className="w-3.5 h-3.5" /> Save Rule</>}
          </button>
        </div>
      </div>
    </div>
  );
}

function coerceValue(raw: string): number | string | boolean {
  if (raw.toLowerCase() === 'true') return true;
  if (raw.toLowerCase() === 'false') return false;
  if (raw.trim() !== '' && !isNaN(Number(raw))) return Number(raw);
  return raw;
}