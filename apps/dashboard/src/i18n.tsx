import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import english from './translations.json';

export type Language = 'en' | 'zh';
export type TranslationValues = Record<string, string | number | boolean | null | undefined>;
export const LANGUAGE_STORAGE_KEY = 'bri-researcher:language';
export const translations: Readonly<Record<string, string>> = english;

function readLanguage(): Language {
  try { return window.localStorage.getItem(LANGUAGE_STORAGE_KEY) === 'zh' ? 'zh' : 'en'; }
  catch { return 'en'; }
}

// One locale for this client application. Legacy pure status/format helpers use
// this snapshot; React components receive the same locale through context.
let applicationLanguage: Language = readLanguage();

export function translate(key: string, values: TranslationValues = {}, language: Language = applicationLanguage): string {
  const template = language === 'zh' ? key : translations[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name] ?? '') : placeholder);
}

interface I18nContextValue {
  language: Language;
  locale: 'en-US' | 'zh-CN';
  setLanguage: (language: Language) => void;
  t: (key: string, values?: TranslationValues) => string;
}
const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children, initialLanguage }: { children: ReactNode; initialLanguage?: Language }): JSX.Element {
  const [language, updateLanguage] = useState<Language>(() => initialLanguage ?? readLanguage());
  applicationLanguage = language;
  const setLanguage = useCallback((next: Language) => {
    applicationLanguage = next;
    updateLanguage(next);
    try { window.localStorage.setItem(LANGUAGE_STORAGE_KEY, next); } catch { /* Selection still works without storage. */ }
  }, []);
  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
    document.title = language === 'zh' ? 'Brilliant Researcher · 研究工作台' : 'Brilliant Researcher · Research workbench';
  }, [language]);
  const value = useMemo<I18nContextValue>(() => ({ language, locale: language === 'zh' ? 'zh-CN' : 'en-US', setLanguage,
    t: (key, values) => translate(key, values, language),
  }), [language, setLanguage]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error('Dashboard components must be rendered within I18nProvider');
  return context;
}

export function LanguageSwitcher(): JSX.Element {
  const { language, setLanguage, t } = useI18n();
  return <div className="language-switcher" role="group" aria-label={t('界面语言')}>
    <button type="button" lang="en" aria-pressed={language === 'en'} onClick={() => setLanguage('en')}>EN</button>
    <button type="button" lang="zh-CN" aria-pressed={language === 'zh'} onClick={() => setLanguage('zh')}>中文</button>
  </div>;
}

// Only application-owned catalog labels are mapped. Skill descriptions and
// source instructions, user names, messages, and report text stay verbatim.
const CATALOG_GROUP_KEYS: Readonly<Record<string, string>> = {
  'Workflow Orchestrators': '工作流编排', 'Research Ideation': '研究想法',
  'Literature & Search': '文献与检索', 'Ideation & Method Design': '想法与方法设计',
  'Proof Engineering': '证明工程', 'Experiments & Infrastructure': '实验与基础设施',
  'Review, Audit & Assurance': '评审、审计与核验', 'Paper Writing & Figures': '论文写作与图表',
  'Talks, Posters & Resubmission': '报告、海报与重新投稿', Patents: '专利',
  'Meta, Utilities & Integrations': '元工具、实用工具与集成',
  Experiments: '实验', 'Paper Writing': '论文写作', Utilities: '实用工具',
  'Paper Submission': '论文投稿', 'Mathematical Proof': '数学证明', 'Research Skills': '研究技能',
};
export function catalogGroupKey(group: string): string { return CATALOG_GROUP_KEYS[group] ?? group; }
