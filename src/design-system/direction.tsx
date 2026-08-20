/**
 * Text direction is a first-class layout mode, not an override.
 * ============================================================================
 * The product must work in English (LTR) and Persian/Dari (RTL). The previous
 * arrangement hard-coded `dir="ltr"` on 37 elements across 30 files and used
 * physical direction utilities (`ml-`, `pe-`, `text-left`, `left-`)
 * throughout, so an RTL rendering would have had to be retrofitted screen by
 * screen — exactly the "scattered overrides" approach the requirement forbids.
 *
 * Instead: ONE authority decides the document's language and direction, the
 * browser inherits it, and every component is written with LOGICAL properties
 * (`ms-`, `pe-`, `text-start`, `start-`) so it mirrors automatically. A
 * component never asks which direction it is in.
 *
 * Scope note: this establishes the direction ARCHITECTURE and the language
 * switch. Translated message catalogs are a separate concern and are not
 * claimed here — `useDirection().lang` is what a catalog would key off.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  DirectionContext,
  LANGUAGE_STORAGE_KEY,
  SUPPORTED_LANGUAGES,
  directionOf,
  type AppLanguage,
} from './direction-context';

function readStoredLanguage(): AppLanguage {
  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (stored && (SUPPORTED_LANGUAGES as readonly string[]).includes(stored)) {
      return stored as AppLanguage;
    }
  } catch {
    // A browser with storage disabled still gets a working interface.
  }
  return 'en';
}

/**
 * Owns the document's language and direction.
 *
 * The `dir` attribute is set on <html> rather than on individual view roots so
 * that portalled content — dialogs, dropdowns, toasts, anything rendered
 * outside the React tree's DOM position — inherits it too. Setting it per-view
 * is precisely how a modal ends up LTR inside an RTL page.
 */
export function DirectionProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<AppLanguage>(readStoredLanguage);
  const dir = directionOf(lang);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('lang', lang);
    root.setAttribute('dir', dir);
  }, [lang, dir]);

  const setLang = useCallback((next: AppLanguage) => {
    setLangState(next);
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
    } catch {
      // Preference is not persisted; the session still switches.
    }
  }, []);

  const value = useMemo(() => ({ lang, dir, setLang }), [lang, dir, setLang]);
  return <DirectionContext.Provider value={value}>{children}</DirectionContext.Provider>;
}
