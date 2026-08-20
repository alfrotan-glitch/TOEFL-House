/**
 * Language and direction: the shared contract.
 * ============================================================================
 * Kept separate from the provider component so the constants, types and hook
 * can be imported without dragging a component into the module graph (and so
 * fast refresh keeps working for the provider itself).
 */
import { createContext, useContext } from 'react';

/** Languages the interface supports. */
export const SUPPORTED_LANGUAGES = ['en', 'fa'] as const;
export type AppLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export type TextDirection = 'ltr' | 'rtl';

/** The writing direction each supported language is rendered in. */
const DIRECTION_OF: Record<AppLanguage, TextDirection> = {
  en: 'ltr',
  fa: 'rtl',
};

export function directionOf(lang: AppLanguage): TextDirection {
  return DIRECTION_OF[lang];
}

export const LANGUAGE_STORAGE_KEY = 'th.lang';

export interface DirectionContextValue {
  lang: AppLanguage;
  dir: TextDirection;
  setLang: (lang: AppLanguage) => void;
}

export const DirectionContext = createContext<DirectionContextValue | null>(null);

/**
 * Reads the active language and direction.
 *
 * Components should rarely need `dir`: logical properties mirror on their own.
 * It exists for the few cases that genuinely cannot be expressed in CSS — a
 * chart axis, or an icon that means "forward" rather than "right".
 */
export function useDirection(): DirectionContextValue {
  const ctx = useContext(DirectionContext);
  if (!ctx) throw new Error('useDirection must be used inside a DirectionProvider.');
  return ctx;
}
