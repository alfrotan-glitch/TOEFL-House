import React from 'react';
import { GraduationCap, PanelLeftClose, PanelLeftOpen } from 'lucide-react';

interface SidebarBrandProps {
  isExpanded: boolean;
  isPinned: boolean;
  onTogglePin: () => void;
}

export default function SidebarBrand({ isExpanded, isPinned, onTogglePin }: SidebarBrandProps) {
  return (
    <div className={`h-16 flex items-center border-b border-white/[0.06] shrink-0 relative ${isExpanded ? 'px-5' : 'justify-center px-0'}`}>
      <div className={`flex items-center relative z-10 ${isExpanded ? 'gap-2.5' : 'justify-center'}`}>
        <div className="w-9 h-9 bg-gradient-to-br from-indigo-500 to-violet-600 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-500/30 transition-transform duration-300 hover:scale-105 shrink-0">
          <GraduationCap className="w-5 h-5 text-white" />
        </div>
        {isExpanded && (
          <div className="animate-in fade-in slide-in-from-left-4 duration-300">
            <h1 className="text-[15px] font-bold text-slate-100 tracking-tight leading-none">The TOEFL House</h1>
            <p className="text-[8px] text-slate-400 font-bold uppercase tracking-[0.16em] mt-0.5">Enterprise ERP</p>
          </div>
        )}
      </div>

      {/* Pin / Collapse Button */}
      {isExpanded && (
        <button 
          onClick={onTogglePin} 
          className={`absolute top-1/2 -translate-y-1/2 p-1.5 rounded-md transition-all duration-200 ${isPinned ? 'right-3 text-indigo-400 bg-indigo-500/10' : 'right-3 text-slate-500 hover:text-slate-200 hover:bg-white/5'}`}
          aria-label={isPinned ? "Unpin sidebar" : "Pin sidebar open"}
          title={isPinned ? "Unpin sidebar" : "Pin sidebar open"}
        >
          {isPinned ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
        </button>
      )}
    </div>
  );
}