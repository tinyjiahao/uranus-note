import { createLowlight } from "lowlight";
import { Decoration } from "@tiptap/pm/view";
import json from "highlight.js/lib/languages/json";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import sql from "highlight.js/lib/languages/sql";
import yaml from "highlight.js/lib/languages/yaml";

// V9-03: lowlight registered on demand only — no `common`/`all` bundles.
export const lowlight = createLowlight();
lowlight.register({ json, javascript, typescript, xml, css, python, bash, sql, yaml });

/** Registered languages shown in the code-block language dropdown ("text" = no language). */
export const CODE_LANGUAGES: { id: string; label: string }[] = [
  { id: "text", label: "文本" },
  { id: "json", label: "JSON" },
  { id: "javascript", label: "JavaScript" },
  { id: "typescript", label: "TypeScript" },
  { id: "xml", label: "HTML/XML" },
  { id: "css", label: "CSS" },
  { id: "python", label: "Python" },
  { id: "bash", label: "Shell" },
  { id: "sql", label: "SQL" },
  { id: "yaml", label: "YAML" },
];

/** Blocks too large to highlight synchronously. */
export const HIGHLIGHT_MAX_CHARS = 50_000;

/** Shared JSON detector used by the format button, the language display and unlabeled highlighting. */
export function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

type Hast = { type: string; value?: string; tagName?: string; properties?: { className?: string[] }; children?: Hast[] };

/** Convert a lowlight hast tree to inline decorations with hljs-* classes. `start` is the doc position of the first content char. */
export function hastDecorations(root: Hast, start: number): Decoration[] {
  const out: Decoration[] = [];
  const walk = (node: Hast, offset: number, classes: string): number => {
    if (node.type === "text") return offset + (node.value ?? "").length;
    if (node.type !== "element") return offset;
    const own = (node.properties?.className ?? []).filter(name => name.startsWith("hljs-"));
    const merged = own.length ? own.join(" ") : classes;
    let cursor = offset;
    for (const child of node.children ?? []) cursor = walk(child, cursor, merged);
    if (own.length && cursor > offset) out.push(Decoration.inline(offset, cursor, { class: own.join(" ") }));
    return cursor;
  };
  let cursor = start;
  for (const child of root.children ?? []) cursor = walk(child, cursor, "");
  return out;
}

/** Highlight `text` as `language`, returning inline decorations anchored at `start`; empty on failure. */
export function highlightDecorations(language: string, text: string, start: number): Decoration[] {
  try {
    return hastDecorations(lowlight.highlight(language, text) as unknown as Hast, start);
  } catch {
    return [];
  }
}
