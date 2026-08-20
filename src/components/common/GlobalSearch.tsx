import React, { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Command, Search, X } from 'lucide-react';
import { api } from '../../api/client';

type SearchResult = { id: string; entity: string; title: string; subtitle: string; tab: string; meta?: string };

interface Props {
  open: boolean;
  onClose: () => void;
  onNavigate: (tab: string) => void;
}

export default function GlobalSearch({ open, onClose, onNavigate }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  // Reset the search state whenever the dialog opens, by adjusting state
  // during render (no setState-in-effect).
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open) {
      setQuery('');
      setResults([]);
      setActiveIndex(0);
    }
  }

  useEffect(() => {
    if (!open || query.trim().length < 2) {
      // Clear stale results without synchronously setting state inside the
      // effect (microtask runs right after the current render commits).
      Promise.resolve().then(() => {
        setResults([]);
        setActiveIndex(0);
      });
      return;
    }
    const timer = window.setTimeout(async () => {
      setResults([]);
      setLoading(true);
      try {
        const rows = await api.get<SearchResult[]>('/search', { q: query.trim() });
        setResults(rows || []);
        setActiveIndex(0);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 180);
    return () => window.clearTimeout(timer);
  }, [open, query]);

  const grouped = useMemo(() => results.reduce<Record<string, SearchResult[]>>((acc, item) => {
    (acc[item.entity] ||= []).push(item);
    return acc;
  }, {}), [results]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[80] bg-slate-950/35 backdrop-blur-sm p-4 md:p-8" role="presentation" onMouseDown={onClose}>
      <div className="mx-auto mt-[8vh] w-full max-w-2xl overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl" role="dialog" aria-modal="true" aria-label="Global workspace search" onMouseDown={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-slate-200 px-5 py-4">
          <Search className="h-5 w-5 text-indigo-500" />
          <input
            autoFocus
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls="global-search-results"
            aria-autocomplete="list"
            aria-activedescendant={results[activeIndex] ? `global-search-option-${activeIndex}` : undefined}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') { onClose(); return; }
              if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex((index) => Math.min(index + 1, Math.max(results.length - 1, 0))); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex((index) => Math.max(index - 1, 0)); return; }
              if (e.key === 'Home') { e.preventDefault(); setActiveIndex(0); return; }
              if (e.key === 'End') { e.preventDefault(); setActiveIndex(Math.max(results.length - 1, 0)); return; }
              if (e.key === 'Enter' && results[activeIndex]) {
                e.preventDefault();
                const item = results[activeIndex];
                onNavigate(item.tab);
                onClose();
              }
            }}
            placeholder="Search students, visitors, classes, teachers, invoices, books…"
            className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-slate-900 outline-none placeholder:text-slate-400"
          />
          <span className="hidden sm:inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] font-bold text-slate-500"><Command className="h-3 w-3" />K</span>
          <button className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={onClose} aria-label="Close search"><X className="h-4 w-4" /></button>
        </div>

        <div id="global-search-results" role="listbox" aria-label="Search results" className="max-h-[60vh] overflow-y-auto p-3">
          {loading && <div className="px-4 py-8 text-center text-xs font-semibold text-slate-400">Searching…</div>}
          {!loading && query.trim().length < 2 && (
            <div className="px-4 py-10 text-center"><p className="text-sm font-black text-slate-700">Global workspace search</p><p className="mt-1 text-xs text-slate-400">Find a record without remembering which module contains it.</p></div>
          )}
          {!loading && query.trim().length >= 2 && results.length === 0 && (
            <div className="px-4 py-10 text-center text-xs font-semibold text-slate-400">No records found.</div>
          )}
          {!loading && Object.entries(grouped).map(([entity, items]) => (
            <div key={entity} className="mb-3 last:mb-0">
              <div className="px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-slate-400">{entity}</div>
              <div className="space-y-1">
                {items.map(item => {
                  const globalIndex = results.findIndex((result) => result.entity === item.entity && result.id === item.id);
                  return (<button key={`${item.entity}-${item.id}`} id={`global-search-option-${globalIndex}`} role="option" aria-selected={globalIndex === activeIndex} onMouseEnter={() => setActiveIndex(globalIndex)} onClick={() => { onNavigate(item.tab); onClose(); }} className={`flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-start ${globalIndex === activeIndex ? 'bg-indigo-50 ring-1 ring-indigo-100' : 'hover:bg-indigo-50/60'}`}>
                    <div className="min-w-0 flex-1"><p className="truncate text-xs font-black text-slate-900">{item.title}</p><p className="truncate text-[11px] text-slate-500">{item.subtitle || 'No secondary identifier'}{item.meta ? ` · ${item.meta}` : ''}</p></div>
                    <ArrowRight className="h-4 w-4 shrink-0 text-slate-300" />
                  </button>);
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
