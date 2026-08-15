/**
 * Enterprise sidebar — composition root.
 * Features: Pin/Unpin (Dock) mode, Hover-to-Expand, Auto-collapse on blur.
 */
import React, { useState } from 'react';
import SidebarBrand from './SidebarBrand';
import SidebarSearch from './SidebarSearch';
import SidebarBranchSelector from './SidebarBranchSelector';
import SidebarSection from './SidebarSection';
import SidebarFooter from './SidebarFooter';
import MobileSidebar from './MobileSidebar';
import { useSidebar } from '../../hooks/useSidebar';
import type { SidebarBranchOption, SidebarCampusOption, AppRole } from '../../types/navigation';

export interface SidebarProps {
  currentTab: string;
  setCurrentTab: (tab: string) => void;
  activeRole: AppRole;
  onLogout: () => void;
  activeBranchId: string;
  changeBranch: (branchId: string) => void;
  canPickBranch: boolean;
  branches: SidebarBranchOption[];
  campuses?: SidebarCampusOption[];
  currentBranchName: string;
  isOpen: boolean;
  onClose: () => void;
  permissionCodes?: string[];
  tabAccess?: Record<string, boolean>;
}

export default function Sidebar({
  currentTab, setCurrentTab, activeRole, onLogout, activeBranchId, changeBranch,
  canPickBranch, branches, campuses = [], currentBranchName, isOpen, onClose, permissionCodes, tabAccess,
}: SidebarProps) {
  // Default to false (collapsed) to maximize workspace
  const [isPinned, setIsPinned] = useState<boolean>(() => {
    try { return localStorage.getItem('erp.sidebar.pinned') === '1'; } catch { return false; }
  });
  const [isHovering, setIsHovering] = useState(false);

  const togglePinned = () => {
    setIsPinned((prev) => {
      const next = !prev;
      try { localStorage.setItem('erp.sidebar.pinned', next ? '1' : '0'); } catch { /* ignore storage errors */ }
      return next;
    });
  };

  const {
    visibleSections, searchQuery, setSearchQuery, toggleSection, isSectionOpen,
  } = useSidebar(activeRole, currentTab, permissionCodes, tabAccess);

  // Expanded if pinned or currently hovering
  const isExpanded = isPinned || isHovering;

  const handleSelectItem = (tab: string) => {
    setCurrentTab(tab);
    // If unpinned, it will naturally collapse when the mouse leaves.
  };

  // Premium Midnight Glass shell
  const shellClass = `flex flex-col h-full z-30 bg-[#0c0a12] text-slate-300 border-r border-white/[0.06] shadow-2xl shadow-black/50 transition-all duration-300 ease-in-out ${isExpanded ? 'w-64' : 'w-[76px]'}`;

  return (
    <>
      {/* Desktop Sidebar */}
      <aside 
        className={`hidden lg:flex ${shellClass}`} 
        aria-label="Main navigation"
        onMouseEnter={() => setIsHovering(true)}
        onMouseLeave={() => setIsHovering(false)}
      >
        <SidebarBrand 
          isExpanded={isExpanded} 
          isPinned={isPinned}
          onTogglePin={togglePinned} 
        />
        
        {isExpanded && (
          <SidebarBranchSelector
            activeBranchId={activeBranchId}
            changeBranch={changeBranch}
            canPickBranch={canPickBranch}
            branches={branches}
            campuses={campuses}
          />
        )}
        
        {isExpanded && <SidebarSearch value={searchQuery} onChange={setSearchQuery} />}
        
        <nav className="flex-1 overflow-y-auto overflow-x-hidden px-2 py-4 space-y-2 scrollbar-thin scrollbar-thumb-white/5 scrollbar-track-transparent">
          {visibleSections.map((section) => (
            <SidebarSection
              key={section.id}
              section={section}
              // If collapsed, sections are considered "open" to render their item icons.
              isOpen={isExpanded ? isSectionOpen(section) : true} 
              onToggle={() => isExpanded && toggleSection(section.id)}
              currentTab={currentTab}
              onSelectItem={handleSelectItem}
              isExpanded={isExpanded}
            />
          ))}
          {visibleSections.length === 0 && isExpanded && (
            <p className="text-[11px] text-slate-500 px-3 py-4 text-center font-medium">
              No modules match your search.
            </p>
          )}
        </nav>
        
        <SidebarFooter 
          activeRole={activeRole} 
          currentBranchName={currentBranchName} 
          onLogout={onLogout} 
          isExpanded={isExpanded}
        />
      </aside>

      {/* Mobile Drawer Sidebar */}
      <MobileSidebar
        isOpen={isOpen}
        onClose={onClose}
        currentTab={currentTab}
        onSelectItem={setCurrentTab}
        activeRole={activeRole}
        onLogout={onLogout}
        activeBranchId={activeBranchId}
        changeBranch={changeBranch}
        canPickBranch={canPickBranch}
        branches={branches}
        campuses={campuses}
        currentBranchName={currentBranchName}
        visibleSections={visibleSections}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        isSectionOpen={isSectionOpen}
        toggleSection={toggleSection}
      />
    </>
  );
}