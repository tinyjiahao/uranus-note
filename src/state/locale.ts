import { useSyncExternalStore } from "react";
import { english } from "./messages";

export type Locale = "zh-CN" | "en";
const preferenceKey = "uranus.locale";
function readLocale(): Locale {
  try { return localStorage.getItem(preferenceKey) === "en" ? "en" : "zh-CN"; }
  catch { return "zh-CN"; }
}
let locale = readLocale();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const getLocale = () => locale;
export const useLocale = () => useSyncExternalStore(subscribe, getLocale);

export function setLocale(next: Locale) {
  if (next === locale) return;
  locale = next;
  try { localStorage.setItem(preferenceKey, next); } catch { /* Retain the choice for this page. */ }
  document.documentElement.lang = next;
  for (const listener of listeners) listener();
}

export function t(message: string, ...values: unknown[]): string {
  const localized = locale === "en" && Object.hasOwn(english, message) ? english[message]! : message;
  return values.length ? localized.replace(/\{(\d+)\}/g, (_, index) => String(values[Number(index)])) : localized;
}
