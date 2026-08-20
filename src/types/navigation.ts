/**
 * Navigation domain types for the enterprise sidebar.
 * Tab ids must match AuthenticatedApp switch cases in App.tsx.
 */

import type { UserRole } from '../types';

/**
 * Navigation speaks the same role vocabulary as everything else. This was a
 * second, separately maintained list of role names; two lists of one concept
 * drift, and this pair already had.
 */
export type AppRole = UserRole;

/** Implemented application tabs (must stay in sync with App.tsx routing). */
export type AppTabId =
  | 'dashboard'
  | 'visitors'
  | 'students'
  | 'classes'
  | 'sessions'
  | 'teachers'
  | 'exams'
  | 'finance'
  | 'funding'
  | 'impact'
  | 'books'
  | 'workflows'
  | 'rules'
  | 'test-bank'
  | 'audit'
  | 'settings'
  | 'academic-setup'
  | 'operations-report';

export type NavIconKey =
  | 'LayoutDashboard'
  | 'UserPlus'
  | 'GitBranch'
  | 'Users'
  | 'GraduationCap'
  | 'CalendarClock'
  | 'ClipboardList'
  | 'FileText'
  | 'Calculator'
  | 'HandCoins'
  | 'Heart' | 'BarChart3'
  | 'BookOpen'
  | 'Workflow'
  | 'Scale'
  | 'Activity'
  | 'Shield'
  | 'Settings'
  | 'Building2';

export type NavBadgeTone = 'emerald' | 'sky' | 'violet' | 'pink' | 'amber' | 'rose';

export interface NavItemConfig {
  /** Unique id — equals AppTabId when the item navigates to a real module. */
  id: AppTabId;
  label: string;
  icon: NavIconKey;
  /** Roles allowed to see and open this item. */
  badge?: string;
  badgeTone?: NavBadgeTone;
  /** Optional short description for tooltips / search. */
  description?: string;
  keywords?: string[];
}

export interface NavSectionConfig {
  id: string;
  label: string;
  /** Optional emoji / prefix for section header (display only). */
  mark?: string;
  /** Default expanded state in the sidebar. */
  defaultOpen?: boolean;
  items: NavItemConfig[];
}

export interface SidebarBranchOption {
  id: string;
  name: string;
  location?: string;
  isActive?: boolean;
  campusId?: string | null;
  code?: string | null;
}

export interface SidebarCampusOption {
  id: string;
  name: string;
  code: string;
  isActive?: boolean;
}
