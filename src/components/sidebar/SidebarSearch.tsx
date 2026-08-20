import React from 'react';
import { Search } from 'lucide-react';

interface SidebarSearchProps {
  value: string;
  onChange: (value: string) => void;
}

export default function SidebarSearch({ value, onChange }: SidebarSearchProps) {
  return (
    <div className="px-3 py-2 border-b border-white/[0.06]" role="search">
      <div className="relative">
        <Search 
          className="w-3.5 h-3.5 text-slate-500 absolute start-2.5 top-1/2 -translate-y-1/2 pointer-events-none transition-colors focus-within:text-indigo-400" 
          aria-hidden="true" 
        />
        <input
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Search modules…" title="Filter navigation modules"
          className="w-full ps-8 pe-3 py-2 text-[11px] font-medium rounded-lg bg-slate-800/50 border border-white/[0.06] text-slate-200 placeholder:text-slate-500 transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:bg-slate-800 focus:border-indigo-500/30"
          aria-label="Search navigation modules"
        />
      </div>
    </div>
  );
}