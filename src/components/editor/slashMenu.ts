import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { closeHistory } from "@tiptap/pm/history";

// V9-10: slash command menu. Typing "/" at the start of an empty text block
// opens a filterable menu; query text lives in the document until a command
// deletes it. This supersedes the plan_v5 decision to keep "/" as plain text.

type SlashState = { from: number; index: number } | null;
const slashKey = new PluginKey<SlashState>("uranus-slash-menu");

export type SlashItem = { id: string; label: string; keywords: string; run: (editor: Editor) => boolean };

export const SLASH_ITEMS: SlashItem[] = [];

function match(query: string, item: SlashItem): boolean {
  const q = query.toLowerCase();
  return !q || item.label.toLowerCase().includes(q) || item.keywords.includes(q) || item.id.includes(q);
}

export const SlashMenu = Extension.create<{ items: SlashItem[] }>({
  name: "slashMenu",
  addOptions() { return { items: [] as SlashItem[] }; },
  addProseMirrorPlugins() {
    const editor = this.editor;
    const menuItems = this.options.items;
    return [new Plugin<SlashState>({
      key: slashKey,
      state: {
        init: () => null,
        apply: (tr, previous) => {
          const meta = tr.getMeta(slashKey);
          if (meta === null && meta !== undefined) return null;
          if (typeof meta === "object" && meta !== null && "from" in meta) return meta;
          if (!previous) return previous;
          const from = tr.mapping.map(previous.from, -1);
          const { selection, doc } = tr;
          if (!selection.empty || !(selection instanceof TextSelection)) return null;
          const $from = selection.$from;
          if ($from.pos <= from || $from.parent.type.name !== "paragraph" || doc.textBetween(from, $from.pos, "", "").includes(" ")) return null;
          return { from, index: previous.index };
        },
      },
      props: {
        handleTextInput: (view, _from, _to, text) => {
          if (view.composing) return false;
          if (text !== "/" || slashKey.getState(view.state)) return false;
          const $from = view.state.selection.$from;
          if ($from.parent.type.name !== "paragraph" || $from.parentOffset !== 0 || !view.editable) return false;
          const pos = view.state.selection.from;
          window.setTimeout(() => { if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(slashKey, { from: pos, index: 0 })); }, 0);
          return false;
        },
        handleKeyDown: (view, event) => {
          if (event.isComposing || view.composing) return false;
          const state = slashKey.getState(view.state);
          if (!state) return false;
          const items = filtered(view, menuItems);
          if (event.key === "Escape") { view.dispatch(view.state.tr.setMeta(slashKey, null)); return true; }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            if (!items.length) return true;
            const step = event.key === "ArrowDown" ? 1 : -1;
            const current = Math.min(state.index, items.length - 1);
            const index = ((current + step) % items.length + items.length) % items.length;
            view.dispatch(view.state.tr.setMeta(slashKey, { from: state.from, index }));
            return true;
          }
          if (event.key === "Enter") {
            const item = items[Math.min(state.index, items.length - 1)];
            if (!item) return true;
            const $from = view.state.selection.$from;
            view.dispatch(closeHistory(view.state.tr.delete(state.from, $from.pos).setMeta(slashKey, null)));
            item.run(editor);
            return true;
          }
          if (event.key === " ") { view.dispatch(view.state.tr.setMeta(slashKey, null)); return false; }
          return false;
        },
        decorations: (state) => {
          const active = slashKey.getState(state);
          if (!active) return null;
          const query = state.doc.textBetween(active.from + 1, state.selection.$from.pos, "", "");
          return DecorationSet.create(state.doc, [Decoration.widget(state.selection.$from.pos, (view) => {
            const items = filtered(view, menuItems);
            const menu = document.createElement("div");
            menu.className = "slash-menu"; menu.contentEditable = "false";
            menu.setAttribute("role", "dialog"); menu.setAttribute("aria-label", "斜杠命令");
            // Anchor to the slash character, not the widget's own boundary.
            // On redraw coordsAtPos at that boundary can measure the previous
            // fixed-position menu instead of the text caret.
            {
              const coords = view.coordsAtPos(active.from);
              menu.style.left = `${Math.max(8, Math.min(coords.left, innerWidth - 200))}px`;
              menu.style.top = `${coords.bottom + 4}px`;
            }
            if (!items.length) { const empty = document.createElement("div"); empty.className = "slash-item slash-empty"; empty.textContent = "无匹配命令"; menu.appendChild(empty); return menu; }
            const activeIndex = Math.min(slashKey.getState(view.state)?.index ?? 0, items.length - 1);
            items.forEach((item, index) => {
              const row = document.createElement("button");
              row.type = "button";
              row.className = `slash-item${index === activeIndex ? " active" : ""}`;
              row.textContent = item.label;
              row.onmousedown = event => event.preventDefault();
              row.onclick = () => {
                const st = slashKey.getState(view.state); if (!st) return;
                view.dispatch(closeHistory(view.state.tr.delete(st.from, view.state.selection.$from.pos).setMeta(slashKey, null)));
                item.run(editor);
              };
              menu.appendChild(row);
            });
            // Widgets are constructed before attachment. Measure after mount
            // and scroll only this menu, preserving the editor/page position.
            requestAnimationFrame(() => {
              if (!menu.isConnected) return;
              const selected = menu.querySelector<HTMLElement>(".slash-item.active");
              if (!selected) return;
              const top = selected.offsetTop, bottom = top + selected.offsetHeight;
              if (top < menu.scrollTop) menu.scrollTop = top;
              else if (bottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = bottom - menu.clientHeight;
            });
            return menu;
          }, { side: 1, key: `slash-${active.from}-${query}-${active.index}`, ignoreSelection: true, stopEvent: () => true })]);
        },
      },
    })];
  },
});

function filtered(view: EditorView, items: SlashItem[]): SlashItem[] {
  const state = slashKey.getState(view.state);
  if (!state) return [];
  const query = view.state.doc.textBetween(state.from + 1, view.state.selection.$from.pos, "", "");
  return items.filter(item => match(query, item));
}
