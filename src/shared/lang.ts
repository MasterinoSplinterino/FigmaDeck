import { CONFIG } from '../config';

/**
 * Language tag for a text run, decided by the run's own characters
 * (Cyrillic → ru-RU, otherwise en-US; see CONFIG.text.langRules).
 * PowerPoint uses it for spell-checking; a wrong tag underlines the whole text.
 */
export function detectLang(text: string, fallback: string = CONFIG.text.defaultLang): string {
  for (const rule of CONFIG.text.langRules) {
    if (rule.test.test(text)) return rule.lang;
  }
  return fallback;
}
