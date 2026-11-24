import { createContext, createElement, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { translate } from '@shared/i18n';
import type { Locale } from '@shared/types';

export type TFn = (key: string, params?: Record<string, string | number>) => string;

const LocaleContext = createContext<Locale>('en');

export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return createElement(LocaleContext.Provider, { value: locale }, children);
}

export function useLocale(): Locale {
  return useContext(LocaleContext);
}

export function useT(): TFn {
  const locale = useLocale();
  return useMemo<TFn>(() => (key, params) => translate(locale, key, params), [locale]);
}

/** Non-hook translator for the rare place that needs a string outside React. */
export function tWith(locale: Locale): TFn {
  return (key, params) => translate(locale, key, params);
}