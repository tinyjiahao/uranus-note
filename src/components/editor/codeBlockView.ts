import { getLocale, t } from "../../state/locale";
import { Extension } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { NodeSelection, Plugin, PluginKey, Selection } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { CODE_LANGUAGES, HIGHLIGHT_MAX_CHARS, highlightDecorations, looksLikeJson } from "./codeHighlight";

// Code block display features: line numbers (display only) and a fold state. Editable notes persist the fold state in the `collapsed` attribute (content schema 14);
// read-only or trashed notes cannot be modified, so there the toggle is a per-session override kept in plugin state.
export const foldKey = new PluginKey<Set<number>>("codeBlockFold");
const FOLD_MIN_LINES = 9;
const MAX_NUMBERED_LINES = 5000;
const FOLDED_PREVIEW_LINES = 9;

function deleteCodeBlock(view: EditorView, pos: number) {
  const { doc, schema } = view.state;
  const block = doc.nodeAt(pos);
  if (!view.editable || view.composing || block?.type.name !== "codeBlock") return false;
  const $pos = doc.resolve(pos);
  const index = $pos.index();
  const end = pos + block.nodeSize;
  const tr = closeHistory(view.state.tr);
  if ($pos.parent.canReplace(index, index + 1)) tr.delete(pos, end);
  else if ($pos.parent.canReplaceWith(index, index + 1, schema.nodes.paragraph!)) tr.replaceWith(pos, end, schema.nodes.paragraph!.create());
  else return false;
  tr.setSelection(Selection.near(tr.doc.resolve(pos)));
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}
const textKey = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
};

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
    const editor = this.editor;
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
        handleKeyDown(view, event) {
          if (event.isComposing || (event.key !== "Delete" && event.key !== "Backspace")) return false;
          const { selection } = view.state;
          return selection instanceof NodeSelection && deleteCodeBlock(view, selection.from);
        },
        decorations(state) {
          const collapsed = foldKey.getState(state) ?? new Set<number>();
          const decorations: Decoration[] = [];
          state.doc.descendants((node, pos) => {
            if (node.type.name !== "codeBlock") return true;
            const text = node.textContent, codeLines = text.split("\n"), lines = codeLines.length;
            const folded = lines >= FOLD_MIN_LINES && ((node.attrs.collapsed === true) !== collapsed.has(pos));
            decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: `code-numbered${folded ? " code-collapsed" : ""}` }));
            // V9-03: highlight via lowlight for registered languages; unlabeled
            // blocks that look like JSON are highlighted as JSON without
            // writing a language attribute onto the node.
            const language = (node.attrs.language ?? "").toLowerCase();
            if (!folded && text.length <= HIGHLIGHT_MAX_CHARS) {
              const target = language || (looksLikeJson(text) ? "json" : "");
              if (target) decorations.push(...highlightDecorations(target, text, pos + 1));
            }
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
                const fold = make(folded ? t("展开（共 {0} 行）", lines) : t("折叠"), "code-fold", () => {
                  const current = view.state.doc.nodeAt(pos);
                  if (!current || current.type.name !== "codeBlock") return;
                  if (!view.editable) {
                    view.dispatch(view.state.tr.setMeta(foldKey, pos).setMeta("addToHistory", false));
                    return;
                  }
                  if (view.composing) return;
                  // Persist: set the attribute to the opposite of what is shown now and drop any read-only session override for this block.
                  const tr = view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, collapsed: folded ? null : true }).setMeta("addToHistory", false).setMeta("uranus-fold-only", true);
                  if (collapsed.has(pos)) tr.setMeta(foldKey, pos);
                  const { selection } = view.state;
                  if (!folded && selection.from > pos && selection.to < pos + current.nodeSize) {
                    tr.setSelection(NodeSelection.create(tr.doc, pos));
                  }
                  view.dispatch(tr);
                  if (!folded) {
                    const pre = view.nodeDOM(pos);
                    if (pre instanceof HTMLElement) pre.scrollTop = 0;
                  }
                });
                fold.setAttribute("aria-expanded", String(!folded));
              }
              const languageOption = CODE_LANGUAGES.find(option => option.id === language);
              const languageLabel = languageOption ? t(languageOption.label) : language || t("文本");
              const lang = make(languageLabel, "code-language", button => {
                if (!view.editable) return;
                view.dom.dispatchEvent(new CustomEvent("uranus-code-language", { detail: { pos, anchor: button } }));
              });
              lang.setAttribute("aria-label", t("代码语言：{0}", languageLabel));
              lang.setAttribute("aria-haspopup", "dialog");
              lang.disabled = !view.editable;
              if (view.editable && looksLikeJson(text)) {
                make(t("格式化"), "code-format", () => {
                  const current = view.state.doc.nodeAt(pos);
                  if (!current || current.type.name !== "codeBlock") return;
                  try {
                    const formatted = JSON.stringify(JSON.parse(current.textContent), null, 2);
                    if (formatted === current.textContent) return;
                    view.dispatch(view.state.tr.insertText(formatted, pos + 1, pos + current.nodeSize - 1));
                  } catch {
                    window.dispatchEvent(new CustomEvent("uranus-editor-error", { detail: t("JSON 解析失败，无法进行格式化") }));
                  }
                });
              }
              const copy = make(t("复制"), "code-copy", button => {
                const current = view.state.doc.nodeAt(pos);
                navigator.clipboard.writeText(current?.type.name === "codeBlock" ? current.textContent : "").then(() => {
                  button.textContent = t("已复制"); setTimeout(() => { button.textContent = t("复制"); }, 1500);
                }).catch(() => window.dispatchEvent(new CustomEvent("uranus-editor-error", { detail: t("复制代码失败，请检查剪贴板权限") })));
              });
              copy.setAttribute("aria-label", t("复制代码"));
              if (view.editable) {
                make(t("选中整块"), "code-select", () => {
                  if (!view.editable || view.composing || view.state.doc.nodeAt(pos)?.type.name !== "codeBlock") return;
                  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
                  view.focus();
                });
                make(t("删除代码块"), "code-delete", () => { deleteCodeBlock(view, pos); });
              }
              return actions;
            }, { side: -2, key: `actions-${pos}-${folded ? 1 : 0}-${lines}-${text.length}-${textKey(text)}-${language}-${getLocale()}-${editor.options.editable}`, ignoreSelection: true, stopEvent: () => true }));
            if (folded || lines <= MAX_NUMBERED_LINES) {
              let offset = 0;
              (folded ? codeLines.slice(0, FOLDED_PREVIEW_LINES) : codeLines).forEach((line, index) => {
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
