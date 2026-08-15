import React from 'react';
import { LogOut } from 'lucide-react';
import { ROLE_LABELS } from '../../config/roles';
import type { AppRole } from '../../types/navigation';

interface SidebarFooterProps {
  activeRole: string;
  currentBranchName: string;
  onLogout: () => void;
  isExpanded: boolean;
}

export default function SidebarFooter({ activeRole, currentBranchName, onLogout, isExpanded }: SidebarFooterProps) {
  const roleLabel = ROLE_LABELS[activeRole as AppRole] || activeRole;

  // Collapsed view
  if (!isExpanded) {
    return (
      <div className="mt-auto border-t border-white/[0.06] p-3 shrink-0 flex justify-center">
        <button
          onClick={onLogout}
          aria-label="Sign out"
          className="p-3 rounded-xl text-slate-500 hover:bg-rose-500/10 hover:text-rose-400 transition-colors cursor-pointer focus:outline-none"
        >
          <LogOut className="w-5 h-5" />
        </button>
      </div>
    );
  }

  // Expanded view
  return (
    <div className="mt-auto border-t border-white/[0.06] p-3 space-y-2 shrink-0">
      <div className="px-3 py-2 rounded-xl bg-slate-800/50 border border-white/[0.04]">
        <p className="text-[11px] font-bold text-slate-300 truncate tracking-tight">{roleLabel}</p>
        <p className="text-[10px] text-slate-500 truncate mt-0.5" title={currentBranchName}>{currentBranchName}</p>
      </div>
      <button
        type="button"
        onClick={onLogout}
        aria-label="Sign out of your account"
        className="group w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-[12px] font-semibold text-slate-500 hover:bg-rose-500/10 hover:text-rose-400 transition-all duration-200 cursor-pointer focus:outline-none"
      >
        <LogOut className="w-4 h-4 transition-transform duration-200 group-hover:-translate-x-0.5" aria-hidden="true" />
        <span>Sign out</span>
      </button>
    </div>
  );
}