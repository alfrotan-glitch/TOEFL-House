/**
 * TOEFL House ERP — Workflows & Automations View
 * ======================================================
 * Real approve/reject actions wired to the backend's role-checked,
 * event-emitting workflow engine (server/src/routes/workflows.routes.ts).
 * Previously this screen only displayed instances/automations with no
 * way to act on them — every approval had to happen outside the app.
 *
 * @license Apache-2.0
 */
import React, { useEffect, useState } from 'react';
import {
  Workflow, CheckCircle, XCircle, Clock, ChevronDown, ThumbsUp, ThumbsDown,
  AlertTriangle, Ban, History,
} from 'lucide-react';
import type { WorkflowInstance, Automation, WorkflowStatus } from '../../types';
import { formatJalaliDateTime } from '../../utils/jalali';

interface WorkflowStepDef {
  order: number;
  role: string;
  action: 'review' | 'approve' | 'notify' | 'execute';
  label: string;
  slaHours?: number;
}

interface WorkflowInstanceDetail extends WorkflowInstance {
  definitionName: string;
  steps: WorkflowStepDef[];
  history: { id: string; step: number; stepOrder: number; actor: string; action: string; notes?: string; timestamp: string }[];
}

interface Props {
  instances: WorkflowInstance[];
  automations: Automation[];
  activeRole: string;
  approveWorkflowStep: (instanceId: string, notes?: string) => Promise<void>;
  rejectWorkflowStep: (instanceId: string, reason: string) => Promise<void>;
  getWorkflowInstanceDetail: (instanceId: string) => Promise<WorkflowInstanceDetail>;
  toggleAutomation: (id: string, isActive: boolean) => Promise<void>;
}

const STATUS_LABELS: Record<WorkflowStatus, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  approved: 'Approved',
  rejected: 'Rejected',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const TERMINAL_STATUSES: WorkflowStatus[] = ['approved', 'rejected', 'completed', 'cancelled'];

export default function WorkflowsView({
  instances, automations, activeRole,
  approveWorkflowStep, rejectWorkflowStep, getWorkflowInstanceDetail, toggleAutomation,
}: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorkflowInstanceDetail | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isActing, setIsActing] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'active' | 'all'>('active');

  const visibleInstances = statusFilter === 'active'
    ? instances.filter(i => !TERMINAL_STATUSES.includes(i.status))
    : instances;

  useEffect(() => {
    void (async () => {
      if (!selectedId) { setDetail(null); return; }
      setIsLoadingDetail(true);
      setActionError(null);
      try {
        setDetail(await getWorkflowInstanceDetail(selectedId));
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Failed to load details.');
      } finally {
        setIsLoadingDetail(false);
      }
    })();
  }, [selectedId, getWorkflowInstanceDetail]);

  const currentStepDef = detail?.steps.find(s => s.order === detail.currentStep);
  // Mirrors the backend's own check: the assigned role, or owner/manager, may act.
  const canActOnCurrentStep =
    !!currentStepDef &&
    !TERMINAL_STATUSES.includes(detail!.status) &&
    (activeRole === currentStepDef.role || activeRole === 'owner' || activeRole === 'manager');

  const handleApprove = async () => {
    if (!selectedId) return;
    setIsActing(true);
    setActionError(null);
    try {
      await approveWorkflowStep(selectedId);
      const refreshed = await getWorkflowInstanceDetail(selectedId);
      setDetail(refreshed);
    } catch (err: any) {
      setActionError(err?.message || 'Approval failed.');
    } finally {
      setIsActing(false);
    }
  };

  const handleReject = async () => {
    if (!selectedId || !rejectReason.trim()) {
      setActionError('Rejection reason is required.');
      return;
    }
    setIsActing(true);
    setActionError(null);
    try {
      await rejectWorkflowStep(selectedId, rejectReason.trim());
      const refreshed = await getWorkflowInstanceDetail(selectedId);
      setDetail(refreshed);
      setShowRejectForm(false);
      setRejectReason('');
    } catch (err: any) {
      setActionError(err?.message || 'Rejection failed.');
    } finally {
      setIsActing(false);
    }
  };

  return (
    <div className="space-y-6" dir="ltr">
      <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-gradient-to-br from-indigo-500 to-purple-500 rounded-xl flex items-center justify-center">
            <Workflow className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-black text-slate-900">Workflows & automation</h1>
            <p className="text-sm text-slate-500">Manage approval chains and automated actions</p>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <h2 className="text-lg font-bold text-slate-900">Active workflows ({visibleInstances.length})</h2>
          <div className="flex gap-1 bg-slate-100 rounded-xl p-1">
            <button
              onClick={() => setStatusFilter('active')}
              className={`text-xs font-bold rounded-lg px-3 py-1.5 ${statusFilter === 'active' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500'}`}
            >
              Active
            </button>
            <button
              onClick={() => setStatusFilter('all')}
              className={`text-xs font-bold rounded-lg px-3 py-1.5 ${statusFilter === 'all' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500'}`}
            >
              All
            </button>
          </div>
        </div>

        {visibleInstances.length === 0 ? (
          <p className="text-center text-slate-400 py-12">
            {statusFilter === 'active' ? 'No active workflows.' : 'No workflows found.'}
          </p>
        ) : (
          <div className="space-y-3">
            {visibleInstances.map(x => (
              <button
                key={x.id}
                onClick={() => setSelectedId(x.id === selectedId ? null : x.id)}
                className="w-full text-left bg-slate-50 border border-slate-200 rounded-xl p-4 flex items-center justify-between hover:border-slate-300 transition-colors"
              >
                <div>
                  <h3 className="font-bold text-slate-900">{x.entityType} — {x.entityId}</h3>
                  <p className="text-xs text-slate-500">Step {x.currentStep}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`flex items-center gap-1 text-xs font-bold px-2 py-1 rounded-full ${
                    x.status === 'completed' || x.status === 'approved' ? 'bg-emerald-100 text-emerald-700' :
                    x.status === 'rejected' || x.status === 'cancelled' ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-700'
                  }`}>
                    {(x.status === 'completed' || x.status === 'approved') && <CheckCircle className="w-3 h-3" />}
                    {(x.status === 'rejected' || x.status === 'cancelled') && <XCircle className="w-3 h-3" />}
                    {(x.status === 'pending' || x.status === 'in_progress') && <Clock className="w-3 h-3" />}
                    {STATUS_LABELS[x.status]}
                  </span>
                  <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${selectedId === x.id ? 'rotate-180' : ''}`} />
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Detail / action panel for the selected instance */}
        {selectedId && (
          <div className="mt-4 bg-indigo-50/50 border border-indigo-100 rounded-2xl p-5">
            {isLoadingDetail ? (
              <p className="text-center text-slate-400 py-6 text-sm">Loading details…</p>
            ) : detail ? (
              <div className="space-y-4">
                <div>
                  <h3 className="font-bold text-slate-900">{detail.definitionName}</h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Started {formatJalaliDateTime(detail.startedAt)}
                    {detail.completedAt && ` — Ended ${formatJalaliDateTime(detail.completedAt)}`}
                  </p>
                </div>

                {/* Steps overview */}
                <div className="flex flex-wrap gap-2">
                  {detail.steps.map(s => (
                    <span
                      key={s.order}
                      className={`text-[11px] font-bold rounded-full px-3 py-1.5 flex items-center gap-1 ${
                        s.order < detail.currentStep ? 'bg-emerald-100 text-emerald-700' :
                        s.order === detail.currentStep && !TERMINAL_STATUSES.includes(detail.status) ? 'bg-amber-100 text-amber-700' :
                        'bg-slate-100 text-slate-400'
                      }`}
                    >
                      {s.order < detail.currentStep && <CheckCircle className="w-3 h-3" />}
                      {s.label} ({s.role})
                    </span>
                  ))}
                </div>

                {actionError && (
                  <div className="bg-rose-50 border border-rose-200 text-rose-700 text-xs font-semibold rounded-xl p-3 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 shrink-0" /> {actionError}
                  </div>
                )}

                {/* Actions */}
                {TERMINAL_STATUSES.includes(detail.status) ? (
                  <p className="text-xs text-slate-500 bg-white rounded-xl p-3">
                    This workflow is final: «{STATUS_LABELS[detail.status]}» and can no longer be actioned.
                  </p>
                ) : canActOnCurrentStep ? (
                  showRejectForm ? (
                    <div className="space-y-2">
                      <textarea
                        className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2"
                        rows={2}
                        placeholder="Enter rejection reason…"
                        value={rejectReason}
                        onChange={e => setRejectReason(e.target.value)}
                      />
                      <div className="flex gap-2">
                        <button
                          disabled={isActing}
                          onClick={handleReject}
                          className="text-xs font-bold text-white bg-rose-600 hover:bg-rose-700 disabled:opacity-50 rounded-lg px-3.5 py-2"
                        >
                          {isActing ? 'Saving…' : 'Confirm reject'}
                        </button>
                        <button
                          onClick={() => { setShowRejectForm(false); setRejectReason(''); }}
                          className="text-xs font-bold text-slate-600 hover:bg-slate-100 rounded-lg px-3.5 py-2"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <button
                        disabled={isActing}
                        onClick={handleApprove}
                        className="flex items-center gap-1.5 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 rounded-lg px-3.5 py-2"
                      >
                        <ThumbsUp className="w-3.5 h-3.5" /> {isActing ? 'Saving…' : 'Approve this step'}
                      </button>
                      <button
                        onClick={() => setShowRejectForm(true)}
                        className="flex items-center gap-1.5 text-xs font-bold text-rose-600 bg-rose-50 hover:bg-rose-100 rounded-lg px-3.5 py-2"
                      >
                        <ThumbsDown className="w-3.5 h-3.5" /> Reject
                      </button>
                    </div>
                  )
                ) : (
                  <p className="text-xs text-amber-700 bg-amber-50 rounded-xl p-3 flex items-center gap-2">
                    <Ban className="w-4 h-4 shrink-0" />
                    Only role «{currentStepDef?.role}» (or manager/owner) can approve or reject this step.
                  </p>
                )}

                {/* History */}
                <div>
                  <h4 className="text-[11px] font-extrabold text-slate-400 uppercase mb-2 flex items-center gap-1.5">
                    <History className="w-3.5 h-3.5" /> History
                  </h4>
                  <div className="space-y-1.5">
                    {detail.history.length === 0 ? (
                      <p className="text-xs text-slate-400">No actions yet.</p>
                    ) : (
                      detail.history.map(h => (
                        <div key={h.id} className="text-xs bg-white rounded-lg px-3 py-1.5 flex items-center justify-between">
                          <span className="text-slate-700">
                            <strong>{h.actor}</strong> — {h.action === 'approve' ? 'approved' : h.action === 'reject' ? 'rejected' : h.action}
                            {h.notes && ` («${h.notes}»)`}
                          </span>
                          <span className="text-[10px] font-mono text-slate-400 shrink-0">{formatJalaliDateTime(h.timestamp)}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm">
        <h2 className="text-lg font-bold text-slate-900 mb-4">Automations ({automations.length})</h2>
        {automations.length === 0 ? (
          <p className="text-center text-slate-400 py-12">No automations defined.</p>
        ) : (
          <div className="space-y-3">
            {automations.map(x => (
              <div key={x.id} className="bg-slate-50 border border-slate-200 rounded-xl p-4 flex items-center justify-between">
                <div>
                  <h3 className="font-bold text-slate-900">{x.name}</h3>
                  <p className="text-xs text-slate-500">Trigger: {x.trigger}</p>
                </div>
                <button
                  onClick={() => toggleAutomation(x.id, !x.isActive)}
                  className={`text-xs font-bold px-2.5 py-1 rounded-full transition-colors ${
                    x.isActive ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' : 'bg-slate-200 text-slate-600 hover:bg-slate-300'
                  }`}
                >
                  {x.isActive ? 'Active' : 'Inactive'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
