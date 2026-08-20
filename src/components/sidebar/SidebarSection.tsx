import React from 'react';
import { ChevronDown } from 'lucide-react';
import SidebarItem from './SidebarItem';
import type { NavItemConfig, NavSectionConfig } from '../../types/navigation';

interface SidebarSectionProps {
  section: NavSectionConfig & { items: NavItemConfig[] };
  isOpen: boolean;
  onToggle: () => void;
  currentTab: string;
  onSelectItem: (id: string) => void;
  isExpanded: boolean;
}

export default function SidebarSection({ section, isOpen, onToggle, currentTab, onSelectItem, isExpanded }: SidebarSectionProps) {
  // Render only icons when sidebar is collapsed
  if (!isExpanded) {
    return (
      <div className="flex flex-col items-center gap-1 py-2">
        {section.items.map((item) => (
          <SidebarItem 
            key={`${section.id}:${item.id}`} 
            item={item} 
            isActive={item.id === currentTab} 
            onSelect={onSelectItem}
            isExpanded={false}
          />
        ))}
      </div>
    );
  }

  // Expanded view with smooth accordion grid animation
  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        className="group w-full flex items-center gap-2 px-3 py-1.5 text-[9px] font-bold uppercase tracking-[0.16em] text-slate-500 hover:text-slate-300 transition-colors cursor-pointer focus:outline-none rounded-md"
      >
        <span className="flex-1 text-start truncate">
          {section.mark ? `${section.mark} ` : ''}
          {section.label}
        </span>
        <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-300 ease-out ${isOpen ? 'rotate-180' : 'rotate-0 -translate-x-0.5'}`} aria-hidden="true" />
      </button>
      
      <div className={`grid transition-all duration-300 ease-in-out ${isOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
        <div className="overflow-hidden">
          <ul className="space-y-0.5 pt-1 pb-1">
            {section.items.map((item) => (
              <li key={`${section.id}:${item.id}:${item.label}`}>
                <SidebarItem item={item} isActive={item.id === currentTab} onSelect={onSelectItem} isExpanded={true} />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}