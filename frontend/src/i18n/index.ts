/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at:
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import en from './locales/en.json';

export const resources = {
  en: { translation: en },
} as const;

export const supportedLanguages = [
  { code: 'en', name: 'English', nativeName: 'English', dir: 'ltr' },
  { code: 'ar', name: 'Arabic', nativeName: 'العربية', dir: 'rtl' },
  { code: 'bn', name: 'Bengali', nativeName: 'বাংলা', dir: 'ltr' },
  { code: 'cs', name: 'Czech', nativeName: 'Čeština', dir: 'ltr' },
  { code: 'da', name: 'Danish', nativeName: 'Dansk', dir: 'ltr' },
  { code: 'de', name: 'German', nativeName: 'Deutsch', dir: 'ltr' },
  { code: 'es', name: 'Spanish', nativeName: 'Español', dir: 'ltr' },
  { code: 'fr', name: 'French', nativeName: 'Français', dir: 'ltr' },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', dir: 'ltr' },
  {
    code: 'id',
    name: 'Indonesian',
    nativeName: 'Bahasa Indonesia',
    dir: 'ltr',
  },
  { code: 'is', name: 'Icelandic', nativeName: 'Íslenska', dir: 'ltr' },
  { code: 'it', name: 'Italian', nativeName: 'Italiano', dir: 'ltr' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語', dir: 'ltr' },
  { code: 'ko', name: 'Korean', nativeName: '한국어', dir: 'ltr' },
  { code: 'ms', name: 'Malay', nativeName: 'Bahasa Melayu', dir: 'ltr' },
  { code: 'nl', name: 'Dutch', nativeName: 'Nederlands', dir: 'ltr' },
  { code: 'pl', name: 'Polish', nativeName: 'Polski', dir: 'ltr' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português', dir: 'ltr' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский', dir: 'ltr' },
  { code: 'sv', name: 'Swedish', nativeName: 'Svenska', dir: 'ltr' },
  { code: 'th', name: 'Thai', nativeName: 'ไทย', dir: 'ltr' },
  { code: 'tr', name: 'Turkish', nativeName: 'Türkçe', dir: 'ltr' },
  { code: 'uk', name: 'Ukrainian', nativeName: 'Українська', dir: 'ltr' },
  { code: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt', dir: 'ltr' },
  { code: 'zh', name: 'Chinese', nativeName: '中文', dir: 'ltr' },
] as const;

// RTL languages list
export const rtlLanguages = ['ar', 'he', 'fa', 'ur'] as const;

type SupportedLanguageCode = (typeof supportedLanguages)[number]['code'];
type LocaleMessages = typeof en;

const languageCodes = supportedLanguages.map(language => language.code);
const localeLoaders: Record<
  SupportedLanguageCode,
  () => Promise<LocaleMessages>
> = {
  en: () => Promise.resolve(en),
  ar: () => import('./locales/ar.json').then(module => module.default),
  bn: () => import('./locales/bn.json').then(module => module.default),
  cs: () => import('./locales/cs.json').then(module => module.default),
  da: () => import('./locales/da.json').then(module => module.default),
  de: () => import('./locales/de.json').then(module => module.default),
  es: () => import('./locales/es.json').then(module => module.default),
  fr: () => import('./locales/fr.json').then(module => module.default),
  hi: () => import('./locales/hi.json').then(module => module.default),
  id: () => import('./locales/id.json').then(module => module.default),
  is: () => import('./locales/is.json').then(module => module.default),
  it: () => import('./locales/it.json').then(module => module.default),
  ja: () => import('./locales/ja.json').then(module => module.default),
  ko: () => import('./locales/ko.json').then(module => module.default),
  ms: () => import('./locales/ms.json').then(module => module.default),
  nl: () => import('./locales/nl.json').then(module => module.default),
  pl: () => import('./locales/pl.json').then(module => module.default),
  pt: () => import('./locales/pt.json').then(module => module.default),
  ru: () => import('./locales/ru.json').then(module => module.default),
  sv: () => import('./locales/sv.json').then(module => module.default),
  th: () => import('./locales/th.json').then(module => module.default),
  tr: () => import('./locales/tr.json').then(module => module.default),
  uk: () => import('./locales/uk.json').then(module => module.default),
  vi: () => import('./locales/vi.json').then(module => module.default),
  zh: () => import('./locales/zh.json').then(module => module.default),
};

export const normalizeLanguageCode = (
  langCode?: string | null
): SupportedLanguageCode => {
  const normalized = langCode?.toLowerCase().split('-')[0];
  return languageCodes.includes(normalized as SupportedLanguageCode)
    ? (normalized as SupportedLanguageCode)
    : 'en';
};

// Helper function to check if a language is RTL
export const isRTL = (langCode: string): boolean => {
  return rtlLanguages.includes(
    normalizeLanguageCode(langCode) as (typeof rtlLanguages)[number]
  );
};

export const loadLanguageResource = async (
  langCode: string
): Promise<SupportedLanguageCode> => {
  const language = normalizeLanguageCode(langCode);

  if (!i18n.hasResourceBundle(language, 'translation')) {
    const translation = await localeLoaders[language]();
    i18n.addResourceBundle(language, 'translation', translation, true, true);
  }

  return language;
};

export const changeAppLanguage = async (
  langCode: string
): Promise<SupportedLanguageCode> => {
  const language = await loadLanguageResource(langCode);
  await i18n.changeLanguage(language);
  return language;
};

if (!i18n.isInitialized) {
  void i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      resources,
      fallbackLng: 'en',
      supportedLngs: languageCodes,
      nonExplicitSupportedLngs: true,
      load: 'languageOnly',
      debug: process.env.NODE_ENV === 'development',
      interpolation: {
        escapeValue: false,
      },
      detection: {
        order: ['localStorage', 'navigator', 'htmlTag'],
        caches: ['localStorage'],
        lookupLocalStorage: 'i18nextLng',
      },
    })
    .then(() => {
      const language = normalizeLanguageCode(
        i18n.language || i18n.resolvedLanguage
      );
      if (language === 'en') {
        return;
      }

      void loadLanguageResource(language).then(() => {
        if (normalizeLanguageCode(i18n.language) === language) {
          void i18n.changeLanguage(language);
        }
      });
    });
}

export default i18n;
