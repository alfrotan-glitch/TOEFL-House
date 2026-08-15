import React from 'react';
import {
  LayoutDashboard,
  UserPlus,
  GitBranch,
  Users,
  GraduationCap,
  CalendarClock,
  ClipboardList,
  FileText,
  Calculator,
  HandCoins,
  Heart,
  BarChart3,
  BookOpen,
  Workflow,
  Scale,
  Activity,
  Shield,
  Settings,
  Building2,
  type LucideIcon,
} from 'lucide-react';
import type { NavIconKey } from '../types/navigation';

const ICON_MAP: Record<NavIconKey, LucideIcon> = {
  LayoutDashboard,
  UserPlus,
  GitBranch,
  Users,
  GraduationCap,
  CalendarClock,
  ClipboardList,
  FileText,
  Calculator,
  HandCoins,
  Heart,
  BarChart3,
  BookOpen,
  Workflow,
  Scale,
  Activity,
  Shield,
  Settings,
  Building2,
};

interface NavIconProps {
  className?: string;
  strokeWidth?: number;
}

export function renderNavIcon(
  key: NavIconKey, 
  { className = 'w-[18px] h-[18px]', strokeWidth = 2 }: NavIconProps = {}
): React.ReactNode {
  const Icon = ICON_MAP[key];
  return Icon ? <Icon className={className} strokeWidth={strokeWidth} /> : null;
}