import React from 'react';
import { Building2, ChevronDown } from 'lucide-react';
import type { SidebarBranchOption, SidebarCampusOption } from '../../types/navigation';

interface SidebarBranchSelectorProps {
  activeBranchId: string;
  changeBranch: (branchId: string) => void;
  canPickBranch: boolean;
  branches: SidebarBranchOption[];
  campuses: SidebarCampusOption[];
}

export default function SidebarBranchSelector({
  activeBranchId, changeBranch, canPickBranch, branches, campuses,
}: SidebarBranchSelectorProps) {
  if (!canPickBranch || branches.length <= 1) return null;

  const selectId = "sidebar-active-branch-select";

  return (
    <div className="px-3 py-2 border-b border-white/[0.06]">
      <label 
        htmlFor={selectId} 
        className="text-[9px] font-bold text-slate-500 uppercase tracking-[0.18em] mb-1.5 flex items-center gap-1.5 cursor-pointer"
      >
        <Building2 className="w-3 h-3" aria-hidden="true" />
        Active branch
      </label>
      
      <div className="relative">
        <select
          id={selectId}
          value={activeBranchId}
          onChange={(e) => changeBranch(e.target.value)}
          className="w-full text-xs bg-slate-800/50 border border-white/[0.06] rounded-lg ps-3 pe-9 py-2 font-semibold text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500/30 cursor-pointer transition-colors appearance-none [&>option]:bg-slate-800 [&>option]:text-slate-200 truncate"
          aria-label="Select active branch"
        >
          {branches
            .filter((b) => b.isActive !== false || b.id === activeBranchId)
            .map((b) => {
              const campus = campuses.find((c) => c.id === b.campusId);
              const label = campus
                ? `${campus.name} / ${b.name}${b.code ? ` (${b.code})` : ''}`
                : `${b.name}${b.code ? ` (${b.code})` : ''}`;
              return (
                <option key={b.id} value={b.id}>
                  {label}
                  {b.isActive === false ? ' (inactive)' : ''}
                </option>
              );
            })}
        </select>
        <ChevronDown 
          className="w-4 h-4 text-slate-500 absolute end-2.5 top-1/2 -translate-y-1/2 pointer-events-none" 
          aria-hidden="true" 
        />
      </div>
    </div>
  );
}