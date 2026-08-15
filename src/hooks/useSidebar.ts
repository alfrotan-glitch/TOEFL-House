import { useCallback, useMemo, useState } from 'react';
import { NAVIGATION_SECTIONS } from '../config/navigation';
import { canAccessTab } from '../config/permissions';
import type { AppRole, NavSectionConfig } from '../types/navigation';
function buildDefaultOpenMap(): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const section of NAVIGATION_SECTIONS) {
    map[section.id] = section.defaultOpen !== false;
  }
  return map;
}

export function useSidebar(
  activeRole: AppRole, // FIX: Strict type safety instead of string
  currentTab: string,
  permissionCodes?: string[] | Set<string>, // FIX: Support Set for O(1) performance
  tabAccess?: Record<string, boolean>
) {
  const [openSections, setOpenSections] = useState<Record<string, boolean>>(buildDefaultOpenMap);
  const [searchQuery, setSearchQuery] = useState('');

  const toggleSection = useCallback((sectionId: string) => {
    setOpenSections((prev) => ({ ...prev, [sectionId]: !prev[sectionId] }));
  }, []);

  const visibleSections = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    
    return NAVIGATION_SECTIONS.map((section) => {
      const items = section.items.filter((item) => {
        // Check permissions first
        if (!canAccessTab(item.id, activeRole, permissionCodes, tabAccess)) return false;
        
        // If no search query, show all allowed items
        if (!q) return true;
        
        // Build haystack efficiently for search
        const hay = [
          item.label, 
          item.description || '', 
          section.label, 
          ...(item.keywords || [])
        ].join(' ').toLowerCase();
        
        return hay.includes(q);
      });
      
      return { ...section, items };
    }).filter((section) => section.items.length > 0);
  }, [activeRole, searchQuery, permissionCodes, tabAccess]);

  const isSectionOpen = useCallback((section: NavSectionConfig) => {
    // Auto-expand if user is searching or if the current tab is inside this section
    if (searchQuery.trim()) return true;
    if (section.items.some((i) => i.id === currentTab)) return true;
    return openSections[section.id] !== false;
  }, [openSections, currentTab, searchQuery]);
  const checkTabAccess = useCallback(
    (tab: string) => canAccessTab(tab, activeRole, permissionCodes, tabAccess),
    [activeRole, permissionCodes, tabAccess]
  );

  return {
    visibleSections,
    searchQuery,
    setSearchQuery,
    toggleSection,
    isSectionOpen,
    canAccessTab: checkTabAccess,
  };
}