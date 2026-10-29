import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

// Code block display features: line numbers (display only) and a fold state. Editable notes persist the fold state in the `collapsed` attribute (content schema 14);
// read-only or trashed notes cannot be modified, so there the toggle is a per-session override kept in plugin state.
export const foldKey = new PluginKey<Set<number>>("codeBlockFold");
const FOLD_MIN_LINES = 9;
const MAX_NUMBERED_LINES = 5000;

const lineNumber = (n: number) => () => {
  const span = document.createElement("span");
  span.className = "code-line-no"; span.contentEditable = "false"; span.setAttribute("aria-hidden", "true"); span.textContent = String(n);
  return span;
};

export const CodeBlockView = Extension.create({
  name: "codeBlockView",
  addGlobalAttributes() {
    return [{
      types: ["codeBlock"],
      attributes: { collapsed: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-collapsed") === "true" ? true : null,
        renderHTML: (attrs: Record<string, unknown>) => attrs.collapsed === true ? { "data-collapsed": "true" } : {},
      } },
    }];
  },
  addProseMirrorPlugins() {
    return [new Plugin<Set<number>>({
      key: foldKey,
      state: {
        init: () => new Set<number>(),
        apply(tr, collapsed) {
          let next = tr.docChanged ? new Set([...collapsed].map(pos => tr.mapping.map(pos))) : collapsed;
          const toggle = tr.getMeta(foldKey) as number | undefined;
          if (toggle !== undefined) { next = new Set(next); if (!next.delete(toggle)) next.add(toggle); }
          const reveal = tr.getMeta("uranus-reveal-code") as number | undefined;
          if (reveal !== undefined) {
            next = new Set(next);
            if (tr.doc.nodeAt(reveal)?.attrs.collapsed === true) next.add(reveal);
            else next.delete(reveal);
          }
          return next;
        },
      },
      props: {
        decorations(state) {
          const collapsed = foldKey.getState(state) ?? new Set<number>();
          const decorations: Decoration[] = [];
          state.doc.descendants((node, pos) => {
            if (node.type.name !== "codeBlock") return true;
            const text = node.textContent, lines = text.split("\n").length;
            const folded = lines >= FOLD_MIN_LINES && ((node.attrs.collapsed === true) !== collapsed.has(pos));
            decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: `code-numbered${folded ? " code-collapsed" : ""}` }));
            decorations.push(Decoration.widget(pos + 1, view => {
              const actions = document.createElement("span");
              actions.className = "code-actions"; actions.contentEditable = "false";
              const make = (label: string, className: string, onClick: (button: HTMLButtonElement) => void) => {
                const button = document.createElement("button");
                button.type = "button"; button.className = className; button.textContent = label;
                button.onmousedown = event => event.preventDefault();
                button.onclick = () => onClick(button);
                actions.appendChild(button); return button;
              };
              if (lines >= FOLD_MIN_LINES) {
                const fold = make(folded ? `展开（共 ${lines} 行）` : "折叠", "code-fold", () => {
                  const current = view.state.doc.nodeAt(pos);
                  if (!current || current.type.name !== "codeBlock") return;
                  if (!view.editable) { view.dispatch(view.state.tr.setMeta(foldKey, pos).setMeta("addToHistory", false)); return; }
                  // Persist: set the attribute to the opposite of what is shown now and drop any read-only session override for this block.
                  const tr = view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, collapsed: folded ? null : true }).setMeta("addToHistory", false).setMeta("uranus-fold-only", true);
                  if (collapsed.has(pos)) tr.setMeta(foldKey, pos);
                  view.dispatch(tr);
                });
                fold.setAttribute("aria-expanded", String(!folded));
              }
              const copy = make("复制", "code-copy", button => {
                navigator.clipboard.writeText(text).then(() => {
                  button.textContent = "已复制"; setTimeout(() => { button.textContent = "复制"; }, 1500);
                }).catch(() => window.dispatchEvent(new CustomEvent("uranus-editor-error", { detail: "复制代码失败，请检查剪贴板权限" })));
              });
              copy.setAttribute("aria-label", "复制代码");
              return actions;
            }, { side: -2, key: `actions-${pos}-${folded ? 1 : 0}-${lines}-${text.length}`, ignoreSelection: true, stopEvent: () => true }));
            if (lines <= MAX_NUMBERED_LINES) {
              let offset = 0;
              text.split("\n").forEach((line, index) => {
                decorations.push(Decoration.widget(pos + 1 + offset, lineNumber(index + 1), { side: -1, key: `ln-${index + 1}`, ignoreSelection: true }));
                offset += line.length + 1;
              });
            }
            return false;
          });
          return DecorationSet.create(state.doc, decorations);
        },
      },
    })];
  },
});
