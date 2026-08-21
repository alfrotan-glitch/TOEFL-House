/**
 * TOEFL House ERP — Business Rules Management (Rule Engine UI)
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Scale, Plus, History, TestTube2, Power, Trash2, Pencil, AlertTriangle, CheckCircle2, Filter, Zap, SlidersHorizontal } from 'lucide-react';
import { api } from '../../api/client';
import type {
  BusinessRule, RuleCategory, BusinessRuleCondition, BusinessRuleAction,
  BusinessRuleVersion, RuleEngineResult,
} from '../../types';
import RuleEditorModal from './RuleEditorModal';
import RuleTestPanel from './RuleTestPanel';
import RuleVersionHistoryModal from './RuleVersionHistoryModal';

export interface CategoryMeta {
  id: RuleCategory;
  label: string;
  icon: React.ReactNode;
}

interface Props {
  businessRules: Record<RuleCategory, BusinessRule[]>;
  activeRole: string;
  isGlobalOwner: boolean;
  reloadBusinessRules: (category: RuleCategory) => Promise<void>;
  createBusinessRule: (data: Partial<BusinessRule>) => Promise<BusinessRule>;
  updateBusinessRule: (ruleId: string, category: RuleCategory, data: Partial<BusinessRule>) => Promise<BusinessRule>;
  deactivateBusinessRule: (ruleId: string, category: RuleCategory) => Promise<void>;
  deleteBusinessRule: (ruleId: string, category: RuleCategory) => Promise<void>;
  rollbackBusinessRule: (ruleId: string, category: RuleCategory, version: number) => Promise<BusinessRule>;
  getBusinessRuleVersions: (ruleId: string) => Promise<BusinessRuleVersion[]>;
  evaluateBusinessRules: (category: RuleCategory, data: Record<string, unknown>, dryRun?: boolean) => Promise<RuleEngineResult>;
  triggerToast: (message: string, type: 'success' | 'error' | 'info') => void;
}


export default function RulesManagementView({
  businessRules, activeRole, isGlobalOwner, reloadBusinessRules, createBusinessRule, updateBusinessRule,
  deactivateBusinessRule, deleteBusinessRule, rollbackBusinessRule, getBusinessRuleVersions,
  evaluateBusinessRules, triggerToast,
}: Props) {
  const [categories, setCategories] = useState<CategoryMeta[]>([]);
  const [activeCategory, setActiveCategory] = useState<RuleCategory>('discount');
  const [showEditor, setShowEditor] = useState(false);
  const [editingRule, setEditingRule] = useState<BusinessRule | null>(null);
  const [showTestPanel, setShowTestPanel] = useState(false);
  const [versionsForRule, setVersionsForRule] = useState<BusinessRule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const canEdit = isGlobalOwner || activeRole === 'general_manager';
  const canDeleteOrRollback = isGlobalOwner;

  const rules = useMemo(() => businessRules[activeCategory] || [], [businessRules, activeCategory]);

  useEffect(() => {
    let cancelled = false;
    const loadMeta = async () => {
      try {
        const payload = await api.get<{ categories: Array<{ id: RuleCategory; label: string; editable: boolean }> }>('/rules/meta');
        const editable = payload.categories.filter((category) => category.editable).map((category) => ({ id: category.id, label: category.label, icon: <SlidersHorizontal className="w-3.5 h-3.5" /> }));
        if (!cancelled) {
          setCategories(editable);
          if (editable.length > 0 && !editable.some((category) => category.id === activeCategory)) setActiveCategory(editable[0].id);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load Rule Engine categories.');
      }
    };
    void loadMeta();
    return () => { cancelled = true; };
  }, [activeCategory]);

  useEffect(() => {
    void (async () => {
      setIsLoading(true);
      try {
        await reloadBusinessRules(activeCategory);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load rules.');
      } finally {
        setIsLoading(false);
      }
    })();
  }, [activeCategory, reloadBusinessRules]);

  const handleSave = async (data: Partial<BusinessRule>) => {
    setError(null);
    try {
      if (editingRule) {
        await updateBusinessRule(editingRule.id, activeCategory, data);
        triggerToast('Rule updated successfully.', 'success');
      } else {
        await createBusinessRule({ ...data, category: activeCategory });
        triggerToast('Rule created successfully.', 'success');
      }
      setShowEditor(false);
      setEditingRule(null);
    } catch (err: any) {
      triggerToast(err?.message || 'Failed to save rule.', 'error');
    }
  };

  const handleDeactivate = async (rule: BusinessRule) => {
    try {
      await deactivateBusinessRule(rule.id, activeCategory);
      triggerToast('Rule deactivated.', 'info');
    } catch (err: any) {
      triggerToast(err?.message || 'Failed to deactivate.', 'error');
    }
  };

  const handleDelete = async (rule: BusinessRule) => {
    if (!window.confirm(`Permanently delete rule "${rule.name}"?`)) return; // Kept for destructive action safety
    try {
      await deleteBusinessRule(rule.id, activeCategory);
      triggerToast('Rule deleted permanently.', 'info');
    } catch (err: any) {
      triggerToast(err?.message || 'Failed to delete.', 'error');
    }
  };

  return (
    <div className="space-y-6 font-sans text-start bg-slate-50 min-h-screen p-4 md:p-8">
      
      <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-sm flex flex-col md:flex-row justify-between items-center gap-4">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-2xl flex items-center justify-center shadow-lg shadow-indigo-200">
            <Scale className="w-7 h-7 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">Business Rules Engine</h1>
            <p className="text-sm text-slate-500 mt-1">Advanced cross-cutting rules only. Programs, levels, fees, placement, attendance and promotion are managed by their domain owners.</p>
          </div>
        </div>
        <div className="flex items-center gap-2 w-full md:w-auto">
          <button onClick={() => setShowTestPanel(true)} className="flex-1 md:flex-none flex items-center justify-center gap-1.5 text-xs font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl px-4 py-3 transition-colors cursor-pointer">
            <TestTube2 className="w-4 h-4" /> Test Rules
          </button>
          {canEdit && (
            <button onClick={() => { setEditingRule(null); setShowEditor(true); }} className="flex-1 md:flex-none flex items-center justify-center gap-1.5 text-xs font-bold bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl px-4 py-3 transition-colors cursor-pointer shadow-md">
              <Plus className="w-4 h-4" /> New Rule
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="bg-rose-50 border border-rose-200 text-rose-700 text-sm font-semibold rounded-xl p-4 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      <div className="bg-white rounded-2xl border border-slate-200 p-2 shadow-sm overflow-x-auto">
        <div className="flex gap-1 min-w-max">
          {categories.map(c => (
            <button key={c.id} onClick={() => setActiveCategory(c.id)} className={`flex items-center gap-1.5 text-xs font-bold rounded-xl px-4 py-2.5 transition-all whitespace-nowrap ${activeCategory === c.id ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-500 hover:bg-slate-100'}`}>
              {c.icon} {c.label}
              <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded-full ${activeCategory === c.id ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-400'}`}>
                {(businessRules[c.id] || []).length}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-4">
        <h2 className="text-sm font-bold text-slate-700 px-1">
          Rules in «{categories.find(c => c.id === activeCategory)?.label ?? activeCategory}» ({rules.length})
        </h2>

        {isLoading ? (
          <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center text-slate-400 shadow-sm">
            <div className="w-8 h-8 border-2 border-slate-200 border-t-indigo-500 rounded-full animate-spin mx-auto mb-3"></div>
            Loading rules...
          </div>
        ) : rules.length === 0 ? (
          <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-12 text-center shadow-sm">
            <SlidersHorizontal className="w-10 h-10 text-slate-300 mx-auto mb-3" />
            <p className="text-sm font-semibold text-slate-500">No rules defined in this category yet.</p>
            {canEdit && <button onClick={() => { setEditingRule(null); setShowEditor(true); }} className="mt-4 text-xs font-bold text-indigo-600 hover:underline">Create your first rule</button>}
          </div>
        ) : (
          <div className="space-y-3">
            {rules.slice().sort((a, b) => b.priority - a.priority).map(rule => (
              <div key={rule.id} className={`bg-white rounded-2xl border p-5 shadow-sm transition-all ${rule.isActive ? 'border-slate-200 hover:border-indigo-300 hover:shadow-md' : 'border-slate-100 opacity-60'}`}>
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="flex items-start gap-3 flex-1 min-w-[250px]">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center font-black text-sm shrink-0 ${rule.priority > 100 ? 'bg-rose-50 text-rose-600' : 'bg-indigo-50 text-indigo-600'}`}>
                      {rule.priority}
                    </div>
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-extrabold text-slate-900 text-sm">{rule.name}</h3>
                        <span className={`flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${rule.isActive ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-500'}`}>
                          {rule.isActive ? <CheckCircle2 className="w-3 h-3" /> : <Power className="w-3 h-3" />} {rule.isActive ? 'Active' : 'Inactive'}
                        </span>
                        {rule.scopeBranchId && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">Branch Scoped</span>}
                        <span className="text-[10px] font-mono text-slate-400">v{rule.version}</span>
                      </div>
                      {rule.description && <p className="text-xs text-slate-500 mt-1.5">{rule.description}</p>}
                    </div>
                  </div>
                  {canEdit && (
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => setVersionsForRule(rule)} title="Version History" className="p-2 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors cursor-pointer"><History className="w-4 h-4" /></button>
                      <button onClick={() => { setEditingRule(rule); setShowEditor(true); }} title="Edit" className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"><Pencil className="w-4 h-4" /></button>
                      {rule.isActive && <button onClick={() => handleDeactivate(rule)} title="Deactivate" className="p-2 text-slate-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-colors cursor-pointer"><Power className="w-4 h-4" /></button>}
                      {canDeleteOrRollback && <button onClick={() => handleDelete(rule)} title="Delete" className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors cursor-pointer"><Trash2 className="w-4 h-4" /></button>}
                    </div>
                  )}
                </div>
                <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4 border-t border-slate-100 pt-4">
                  <div>
                    <p className="flex items-center gap-1 text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2"><Filter className="w-3 h-3" /> If Conditions</p>
                    <div className="flex flex-wrap gap-1.5">
                      {rule.conditions.length === 0 ? (
                        <span className="text-[10px] bg-slate-50 border border-dashed border-slate-200 rounded-lg px-2 py-1 text-slate-400">Always runs (no conditions)</span>
                      ) : (
                        rule.conditions.map((c, i) => <span key={i} className="text-[10px] bg-violet-50 border border-violet-100 rounded-lg px-2 py-1 text-violet-700 font-mono">{formatCondition(c)}</span>)
                      )}
                    </div>
                  </div>
                  <div>
                    <p className="flex items-center gap-1 text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2"><Zap className="w-3 h-3" /> Then Actions</p>
                    <div className="flex flex-wrap gap-1.5">
                      {rule.actions.map((a, i) => <span key={i} className="text-[10px] bg-emerald-50 border border-emerald-100 rounded-lg px-2 py-1 text-emerald-700 font-mono">{formatAction(a)}</span>)}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showEditor && (
        <RuleEditorModal category={activeCategory} existingRule={editingRule} onSave={handleSave} onClose={() => { setShowEditor(false); setEditingRule(null); }} triggerToast={triggerToast} />
      )}

      {showTestPanel && (
        <RuleTestPanel categories={categories} evaluateBusinessRules={evaluateBusinessRules} onClose={() => setShowTestPanel(false)} />
      )}

      {versionsForRule && canDeleteOrRollback && (
        <RuleVersionHistoryModal rule={versionsForRule} getBusinessRuleVersions={getBusinessRuleVersions} onRollback={async version => { await rollbackBusinessRule(versionsForRule.id, activeCategory, version); setVersionsForRule(null); triggerToast('Rule restored successfully.', 'success'); }} onClose={() => setVersionsForRule(null)} />
      )}
    </div>
  );
}

function formatCondition(c: BusinessRuleCondition): string {
  const opLabels: Record<string, string> = { eq: '=', neq: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤', in: 'in', not_in: 'not in', contains: 'contains', between: 'between' };
  if (c.operator === 'between' && c.rangeValue) return `${c.field} between ${c.rangeValue[0]} and ${c.rangeValue[1]}`;
  return `${c.field} ${opLabels[c.operator] || c.operator} ${Array.isArray(c.value) ? c.value.join(', ') : c.value}`;
}

function formatAction(a: BusinessRuleAction): string {
  switch (a.type) {
    case 'set_value': return `Set ${a.targetKey} = ${a.value}`;
    case 'add_discount': return `Add ${a.value}% discount`;
    case 'block': return `Block: ${a.message || a.targetKey}`;
    case 'warn': return `Warn: ${a.message || a.targetKey}`;
    case 'notify': return `Notify (${a.channel || 'internal'}): ${a.message || ''}`;
    case 'trigger_event': return `Trigger: ${a.eventName || a.targetKey}`;
    case 'calculate': return `Calc: ${a.targetKey} = ${a.formula}`;
    default: return a.targetKey;
  }
}