import React from 'react';
import { renderNavIcon } from '../../config/icons';
import { BADGE_TONE_CLASS } from '../../config/badges';
import type { NavItemConfig } from '../../types/navigation';

interface SidebarItemProps {
  item: NavItemConfig;
  isActive: boolean;
  onSelect: (id: string) => void;
  isExpanded: boolean;
}

export default function SidebarItem({ item, isActive, onSelect, isExpanded }: SidebarItemProps) {
  const badgeClass = item.badgeTone ? BADGE_TONE_CLASS[item.badgeTone] : 'bg-indigo-100 text-indigo-700';

  // Collapsed view (icon only with tooltip)
  if (!isExpanded) {
    return (
      <button
        type="button"
        onClick={() => onSelect(item.id)}
        title={item.label}
        className={`group relative w-12 h-12 flex items-center justify-center rounded-xl transition-all duration-200 cursor-pointer focus:outline-none ${
          isActive ? 'bg-indigo-500/10 text-indigo-400 shadow-sm' : 'text-slate-500 hover:bg-slate-800/50 hover:text-slate-200'
        }`}
      >
        {isActive && <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-6 rounded-r-full bg-indigo-500" aria-hidden="true" />}
        <span className={`transition-transform duration-200 ${isActive ? 'scale-110' : 'group-hover:scale-110'}`} aria-hidden="true">
          {renderNavIcon(item.icon)}
        </span>
        
        {/* Premium Tooltip */}
        <span className="absolute left-14 top-1/2 -translate-y-1/2 bg-slate-900 text-white text-xs font-semibold px-2 py-1 rounded-md opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-200 whitespace-nowrap shadow-xl z-50 border border-white/10">
          {item.label}
        </span>
      </button>
    );
  }

  // Expanded view
  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      title={item.description || item.label}
      className={`group w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13px] font-semibold transition-all duration-200 cursor-pointer relative overflow-hidden focus:outline-none ${
        isActive ? 'bg-indigo-500/10 text-indigo-300 shadow-sm' : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-100'
      }`}
    >
      {isActive && <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-6 rounded-r-full bg-indigo-500" aria-hidden="true" />}
      <span className={`transition-transform duration-200 ${isActive ? 'scale-110 text-indigo-400' : 'group-hover:scale-110'}`} aria-hidden="true">
        {renderNavIcon(item.icon)}
      </span>
      <span className="flex-1 text-left truncate">{item.label}</span>
      {item.badge && <span className={`${badgeClass} text-[8px] font-black px-1.5 py-0.5 rounded-full tracking-wider shrink-0`}>{item.badge}</span>}
    </button>
  );
}