import { incrementNumberSetting } from './settings.js';

export function nextScopedDocumentNumber(kind: string, scopeId: string, prefix: string, year = new Date().getFullYear(), width = 6): string {
  if (!kind || !scopeId || !prefix) throw new Error('Document numbering requires kind, scope and prefix.');
  const key = `document_sequence:${kind}:${scopeId}:${year}`;
  const seq = Math.trunc(Number(incrementNumberSetting(key, 1, 0)) || 1);
  return `${prefix}-${year}-${String(seq).padStart(width, '0')}`;
}
