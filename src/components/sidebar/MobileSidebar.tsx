import React, { useEffect } from 'react';
import {X} from 'lucide-react';
import SidebarSearch from './SidebarSearch';
import SidebarBranchSelector from './SidebarBranchSelector';
import SidebarSection from './SidebarSection';
import SidebarFooter from './SidebarFooter';
import type {NavSectionConfig, NavItemConfig, SidebarBranchOption, SidebarCampusOption} from '../../types/navigation';
import { BrandLogo } from '../common/BrandLogo';
import { BRAND_NAME, BRAND_SLOGAN } from '../../config/branding';

interface MobileSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  currentTab: string;
  onSelectItem: (id: string) => void;
  activeRole: string;
  onLogout: () => void;
  activeBranchId: string;
  changeBranch: (branchId: string) => void;
  canPickBranch: boolean;
  branches: SidebarBranchOption[];
  campuses: SidebarCampusOption[];
  currentBranchName: string;
  visibleSections: Array<NavSectionConfig & { items: NavItemConfig[] }>;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  isSectionOpen: (section: NavSectionConfig) => boolean;
  toggleSection: (sectionId: string) => void;
}

export default function MobileSidebar({
  isOpen, onClose, currentTab, onSelectItem, activeRole, onLogout, activeBranchId, changeBranch,
  canPickBranch, branches, campuses, currentBranchName, visibleSections, searchQuery, setSearchQuery,
  isSectionOpen, toggleSection,
}: MobileSidebarProps) {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSelect = (id: string) => {
    onSelectItem(id);
    onClose();
  };

  return (
    <aside 
      className="lg:hidden fixed inset-y-0 start-0 w-72 z-50 flex flex-col bg-[#0c0a12] text-slate-300 border-e border-white/[0.06] shadow-2xl animate-in slide-in-from-left duration-300"
      role="dialog"
      aria-modal="true"
      aria-label="Mobile navigation menu"
    >
      <div className="relative shrink-0">
        {/* Mobile brand */}
        <div className="h-16 flex items-center px-5 border-b border-white/[0.06] relative overflow-hidden">
          <div className="flex items-center gap-2.5 relative z-10">
            <div className="w-9 h-9 bg-white rounded-xl flex items-center justify-center shadow-lg shadow-indigo-500/20 shrink-0 p-1">
              <BrandLogo height={22} />
            </div>
            <div>
              <h1 className="text-[15px] font-bold text-slate-100 tracking-tight leading-none">{BRAND_NAME}</h1>
              <p className="text-[8px] text-slate-400 font-bold uppercase tracking-[0.16em] mt-0.5">{BRAND_SLOGAN}</p>
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="absolute end-3 top-1/2 -translate-y-1/2 p-2 text-slate-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-400/50"
          aria-label="Close menu"
        >
          <X className="w-5 h-5" />
        </button>
      </div>
      
      <div className="shrink-0">
        <SidebarBranchSelector
          activeBranchId={activeBranchId}
          changeBranch={changeBranch}
          canPickBranch={canPickBranch}
          branches={branches}
          campuses={campuses}
        />
        <SidebarSearch value={searchQuery} onChange={setSearchQuery} />
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-4 space-y-2 scrollbar-thin scrollbar-thumb-white/5 scrollbar-track-transparent">
        {visibleSections.map((section) => (
          <SidebarSection
            key={section.id}
            section={section}
            isOpen={isSectionOpen(section)}
            onToggle={() => toggleSection(section.id)}
            currentTab={currentTab}
            onSelectItem={handleSelect}
            isExpanded={true}
          />
        ))}
        {visibleSections.length === 0 && (
          <p className="text-[11px] text-slate-500 px-3 py-4 text-center font-medium">
            No modules match your search.
          </p>
        )}
      </nav>
      
      <SidebarFooter activeRole={activeRole} currentBranchName={currentBranchName} onLogout={onLogout} isExpanded={true} />
    </aside>
  );
}