import React from 'react';
import {Phone, Mail, Edit, Trash2, ArrowRightLeft, DollarSign} from 'lucide-react';
import {Employee} from '../../types';
import {formatAFN} from '../../utils/format';

export interface EmployeeDirectoryPanelProps {
  employees: Employee[];
  filteredEmployees: Employee[];
  isOwnerOrFinance: boolean;
  isOwnerOrManager: boolean;
  onEdit: (e: Employee) => void;
  onDelete: (id: string, name: string) => void;
  onPay: (e: Employee) => void;
  onTransfer: (e: Employee) => void;
}

export function EmployeeDirectoryPanel({
  filteredEmployees, isOwnerOrFinance, isOwnerOrManager, onEdit, onDelete, onPay, onTransfer
}: EmployeeDirectoryPanelProps) {
  if (filteredEmployees.length === 0) {
    return (
      <div className="col-span-full rounded-2xl border border-slate-200 bg-white p-8 text-center text-xs text-slate-400">
        No employees match the current search or filter.
      </div>
    );
  }

  return (
    <>
      {filteredEmployees.map((emp) => (
        <div key={emp.id} className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm flex flex-col justify-between hover:border-slate-300 transition-colors">
          <div className="space-y-3">
            <div className="flex justify-between items-start gap-2">
              <div>
                <p className="font-extrabold text-slate-900 text-sm">{emp.fullName}</p>
                <p className="text-[10px] text-slate-400 mt-0.5">
                  {(emp.status || 'active').toUpperCase()}
                  {emp.role ? ` · ${emp.role}` : ''}
                </p>
              </div>
            </div>
            <div className="space-y-1 text-[11px] text-slate-600">
              {emp.phone && <p className="flex items-center gap-1.5"><Phone className="w-3 h-3 text-slate-400" />{emp.phone}</p>}
              {emp.email && <p className="flex items-center gap-1.5"><Mail className="w-3 h-3 text-slate-400" />{emp.email}</p>}
            </div>
            <div className="flex items-center justify-between border-t border-slate-100 pt-3">
              <div>
                <p className="text-[10px] text-slate-400 font-semibold">Base Salary</p>
                <p className="text-sm font-extrabold text-teal-700 font-mono">{formatAFN(emp.baseSalary || 0)}</p>
              </div>
              <div className="flex flex-wrap gap-1.5 justify-end">
                {isOwnerOrFinance && (
                  <button onClick={() => onPay(emp)} className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 text-emerald-700 px-2 py-1 text-[10px] font-bold hover:bg-emerald-100">
                    <DollarSign className="w-3 h-3" /> Pay
                  </button>
                )}
                {isOwnerOrManager && (
                  <button onClick={() => onTransfer(emp)} className="inline-flex items-center gap-1 rounded-lg bg-amber-50 text-amber-800 px-2 py-1 text-[10px] font-bold hover:bg-amber-100">
                    <ArrowRightLeft className="w-3 h-3" /> Transfer
                  </button>
                )}
                <button onClick={() => onEdit(emp)} className="inline-flex items-center gap-1 rounded-lg bg-indigo-50 text-indigo-700 px-2 py-1 text-[10px] font-bold hover:bg-indigo-100">
                  <Edit className="w-3 h-3" /> Edit
                </button>
                {isOwnerOrManager && (
                  <button onClick={() => onDelete(emp.id, emp.fullName)} className="inline-flex items-center gap-1 rounded-lg bg-rose-50 text-rose-700 px-2 py-1 text-[10px] font-bold hover:bg-rose-100">
                    <Trash2 className="w-3 h-3" /> Delete
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      ))}
    </>
  );
}