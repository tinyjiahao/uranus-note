import { create } from "zustand";

export type LayoutMode = "three" | "two" | "focus";
export type ThemeMode = "system" | "light" | "dark";
export type WidthMode = "fluid" | "reading";
export const editorFontSizes = [14, 16, 18, 20] as const;
export type EditorFontSize = typeof editorFontSizes[number];
export function parseEditorFontSize(value: string | null): EditorFontSize {
  const size = Number(value);
  return editorFontSizes.includes(size as EditorFontSize) ? size as EditorFontSize : 14;
}
export type Sort = { by: "updated_at" | "created_at" | "title"; dir: "asc" | "desc" };
export const defaultSort: Sort = { by: "updated_at", dir: "desc" };
let storageError = false;
export function readPreference(key: string): string | null {
  try { return localStorage.getItem(key); } catch { storageError = true; return null; }
}
export function writePreference(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { useUiStore.setState({ storageWarning: true }); }
}
export function parseSort(value: string | null): Sort {
  try { const s = JSON.parse(value ?? "null") as Sort | null;
    if (s && ["updated_at", "created_at", "title"].includes(s.by) && ["asc", "desc"].includes(s.dir)) return s;
  } catch { /* Invalid preferences use defaults. */ }
  return defaultSort;
}
const choice = <T extends string>(key: string, values: readonly T[], fallback: T): T => {
  const value = readPreference(key); return values.includes(value as T) ? value as T : fallback;
};
type UiState = {
  layout: LayoutMode; theme: ThemeMode; widthMode: WidthMode; editorFontSize: EditorFontSize; sort: Sort; storageWarning: boolean;
  setEditorFontSize: (value: EditorFontSize) => void;
  setLayout: (value: LayoutMode) => void; setTheme: (value: ThemeMode) => void;
  setWidthMode: (value: WidthMode) => void; setSort: (value: Sort) => void; reset: () => void;
};
const layout = choice("uranus.layout", ["three", "two", "focus"], "three");
const theme = choice("uranus.theme", ["system", "light", "dark"], "system");
const widthMode = choice("uranus.editor.widthMode", ["fluid", "reading"], "fluid");
const sort = parseSort(readPreference("uranus.notes.sort"));
const editorFontSize = parseEditorFontSize(readPreference("uranus.editor.fontSize"));
export const useUiStore = create<UiState>((set, get) => ({
  layout, theme, widthMode, editorFontSize, sort, storageWarning: storageError,
  setEditorFontSize: (value) => { const editorFontSize = parseEditorFontSize(String(value)); writePreference("uranus.editor.fontSize", String(editorFontSize)); set({ editorFontSize }); },
  setLayout: (layout) => { writePreference("uranus.layout", layout); set({ layout }); },
  setWidthMode: (widthMode) => { writePreference("uranus.editor.widthMode", widthMode); set({ widthMode }); },
  setSort: (sort) => { writePreference("uranus.notes.sort", JSON.stringify(sort)); set({ sort }); },
  setTheme: (theme) => {
    writePreference("uranus.theme", theme);
    document.documentElement.dataset.theme = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
    set({ theme });
  },
  reset: () => { get().setLayout("three"); get().setTheme("system"); get().setWidthMode("fluid"); get().setEditorFontSize(14); get().setSort(defaultSort); },
}));
export function noteTime(value: number, now = new Date()) {
  const date = new Date(value); const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const prefix = date.toDateString() === now.toDateString() ? "今天" : date.toDateString() === yesterday.toDateString() ? "昨天" : "";
  return prefix ? `${prefix} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : date.toLocaleDateString();
}
