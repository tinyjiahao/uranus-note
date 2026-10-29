import { Extension, type Editor } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import type { EditorState } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import { isIndentLevel, MAX_INDENT } from "../../../shared/indent";

/** Adds a 1–6 level `indent` attribute to paragraphs and headings (list items keep using list nesting). */
export const BlockIndent = Extension.create({
  name: "blockIndent",
  addStorage: () => ({ released: false }),
  addProseMirrorPlugins() {
    const storage = this.storage as { released: boolean };
    return [new Plugin({ props: { handleKeyDown: (_view, event) => { if (event.key !== "Escape" && event.key !== "Tab" && event.key !== "Shift") storage.released = false; return false; } } })];
  },
  // Tab/Shift-Tab indent plain paragraphs and headings. Pressing Esc first releases the next Tab so keyboard users can still leave the editor.
  addKeyboardShortcuts() {
    const storage = this.storage as { released: boolean };
    const plain = () => {
      const { $from } = this.editor.state.selection;
      for (let depth = $from.depth; depth > 0; depth--) if (["codeBlock", "listItem", "taskItem", "tableCell", "tableHeader"].includes($from.node(depth).type.name)) return false;
      return this.editor.isEditable && !this.editor.view.composing;
    };
    return {
      Tab: () => {
        if (storage.released) { storage.released = false; return false; }
        if (!plain()) return false;
        if (!indentAvailability(this.editor).increase) return true;
        return changeIndent(this.editor, 1);
      },
      "Shift-Tab": () => {
        if (storage.released) { storage.released = false; return false; }
        if (!plain() || !indentAvailability(this.editor).decrease) return false;
        return changeIndent(this.editor, -1);
      },
      Escape: () => { storage.released = true; return false; },
    };
  },
  addGlobalAttributes() {
    return [{
      types: ["paragraph", "heading"],
      attributes: { indent: {
        default: null,
        parseHTML: (element: HTMLElement) => { const value = Number(element.getAttribute("data-indent")); return isIndentLevel(value) ? value : null; },
        renderHTML: (attrs: Record<string, unknown>) => isIndentLevel(attrs.indent) ? { "data-indent": String(attrs.indent) } : {},
      } },
    }];
  },
});

const LIST_ITEMS = new Set(["listItem", "taskItem"]);
const level = (value: unknown) => isIndentLevel(value) ? value : 0;

/** Plain paragraphs/headings touched by the selection; those inside list items are indented through the list instead. */
function targets(state: EditorState) {
  const found: { pos: number; attrs: Record<string, unknown>; indent: number }[] = [];
  for (const range of state.selection.ranges) {
    state.doc.nodesBetween(range.$from.pos, range.$to.pos, (node, pos) => {
      if (node.type.name === "codeBlock") return false;
      if (node.type.name !== "paragraph" && node.type.name !== "heading") return true;
      const $pos = state.doc.resolve(pos);
      let inList = false;
      for (let depth = $pos.depth; depth > 0; depth--) if (LIST_ITEMS.has($pos.node(depth).type.name)) inList = true;
      if (!inList && !found.some(item => item.pos === pos)) found.push({ pos, attrs: node.attrs, indent: level(node.attrs.indent) });
      return false;
    });
  }
  return found;
}

function listItemName(editor: Editor) {
  if (editor.state.selection instanceof CellSelection) return null;
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth--) { const name = $from.node(depth).type.name; if (LIST_ITEMS.has(name)) return name; }
  return null;
}

/** What the toolbar buttons can do right now: nest list items, or change paragraph/heading indent. */
export function indentAvailability(editor: Editor) {
  if (!editor.isEditable || editor.isActive("codeBlock")) return { increase: false, decrease: false };
  const list = listItemName(editor);
  if (list) return { increase: editor.can().sinkListItem(list), decrease: editor.can().liftListItem(list) };
  const blocks = targets(editor.state);
  return { increase: blocks.some(item => item.indent < MAX_INDENT), decrease: blocks.some(item => item.indent > 0) };
}

export function changeIndent(editor: Editor, delta: 1 | -1) {
  if (!editor.isEditable) return false;
  const list = listItemName(editor);
  if (list) return (delta > 0 ? editor.chain().focus().sinkListItem(list) : editor.chain().focus().liftListItem(list)).run();
  const tr = closeHistory(editor.state.tr);
  let changed = false;
  for (const item of targets(editor.state)) {
    const next = Math.min(MAX_INDENT, Math.max(0, item.indent + delta));
    if (next === item.indent) continue;
    tr.setNodeMarkup(item.pos, undefined, { ...item.attrs, indent: next || null }); changed = true;
  }
  if (changed) { editor.view.dispatch(tr); editor.view.focus(); }
  return changed;
}
