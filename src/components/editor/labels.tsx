import { Extension, Node, type Editor } from "@tiptap/core";
import { NodeSelection, Plugin } from "@tiptap/pm/state";
import { useState } from "react";
import { Check } from "lucide-react";
import { labelAttributes, type LABEL_COLORS } from "../../../shared/label";
import { Popup, type PopupAnchor } from "../Popup";

const palette: { key: typeof LABEL_COLORS[number]; name: string }[] = [
  { key: "gray", name: "灰色" }, { key: "blue", name: "蓝色" }, { key: "cyan", name: "青色" },
  { key: "green", name: "绿色" }, { key: "lime", name: "浅绿色" }, { key: "yellow", name: "黄色" },
  { key: "amber", name: "橙色" }, { key: "rose", name: "红色" }, { key: "pink", name: "粉色" }, { key: "purple", name: "紫色" },
];

// A selection left over from an earlier drag/click makes the browser drag that selection (a text node) instead of the chip under the pointer;
// clearing the native selection on mousedown lets ProseMirror start a clean node drag.
export const InlineAtomDrag = Extension.create({
  name: "inlineAtomDrag",
  addProseMirrorPlugins() {
    return [new Plugin({ props: { handleDOMEvents: { mousedown: (_view, event) => {
      if (event.button === 0 && (event.target as HTMLElement | null)?.closest?.(".label-chip, .inline-drag-handle, .note-link, .inline-file")) window.getSelection()?.removeAllRanges();
      return false;
    } } } })];
  },
});

export const LabelNode = Node.create({
  name: "label", group: "inline", inline: true, atom: true, draggable: true, marks: "",
  addAttributes: () => ({ text: { default: "" }, color: { default: "gray" } }),
  parseHTML: () => [{ tag: 'span[data-uranus-label="1"]', getAttrs: element => {
    const result = labelAttributes.safeParse({ text: element.getAttribute("data-text"), color: element.getAttribute("data-color") });
    return result.success ? result.data : false;
  } }],
  renderHTML: ({ node }) => ["span", { "data-uranus-label": "1", "data-text": node.attrs.text, "data-color": node.attrs.color, class: "label-chip" }, node.attrs.text],
  renderText: ({ node }) => String(node.attrs.text),
  addNodeView: () => ({ node }) => {
    const dom = document.createElement("span"); dom.className = "label-chip"; dom.dataset.color = String(node.attrs.color); dom.dataset.uranusLabel = "1"; dom.textContent = String(node.attrs.text);
    dom.dataset.text = String(node.attrs.text); dom.contentEditable = "false";
    return { dom, selectNode: () => dom.classList.add("ProseMirror-selectednode"), deselectNode: () => dom.classList.remove("ProseMirror-selectednode") };
  },
});

export function LabelPopup({ editor, anchor, position, close }: { editor: Editor; anchor: PopupAnchor; position?: number; close: () => void }) {
  const [existing, setExisting] = useState(() => position === undefined ? undefined : editor.state.doc.nodeAt(position));
  const [text, setText] = useState(String(existing?.attrs.text ?? ""));
  const [color, setColor] = useState(String(existing?.attrs.color ?? "gray"));
  const [error, setError] = useState("");
  const chooseColor = (next: string) => {
    if (editor.view.composing || !editor.isEditable) return;
    if (position !== undefined) {
      if (!existing || editor.state.doc.nodeAt(position) !== existing) { setError("标签位置已改变，请重新打开"); return; }
      if (existing.attrs.color !== next) {
        const tr = editor.state.tr.setNodeMarkup(position, undefined, { ...existing.attrs, color: next });
        if (editor.state.selection instanceof NodeSelection && editor.state.selection.from === position) tr.setSelection(NodeSelection.create(tr.doc, position));
        editor.view.dispatch(tr);
        setExisting(tr.doc.nodeAt(position));
      }
    }
    setColor(next);
  };
  const save = () => {
    const parsed = labelAttributes.safeParse({ text, color });
    if (!parsed.success) { setError("请输入 1–50 个字符，不含控制字符或换行"); return; }
    if (editor.view.composing || !editor.isEditable) return;
    if (position !== undefined) {
      if (editor.state.doc.nodeAt(position) !== existing) { setError("标签位置已改变，请重新打开"); return; }
      if (existing?.attrs.text !== parsed.data.text || existing?.attrs.color !== parsed.data.color) editor.view.dispatch(editor.state.tr.setNodeMarkup(position, undefined, parsed.data));
    } else editor.chain().focus().insertContent({ type: "label", attrs: parsed.data }).run();
    close(); editor.view.focus();
  };
  return <Popup className="label-popup" anchor={anchor} title={existing ? "编辑标签" : "插入标签"} close={close} restoreFocus={() => editor.view.focus()} onCopy={event => {
    if (!existing || (event.target as HTMLElement).closest("input, textarea, [contenteditable=true]")) return;
    if (position === undefined || editor.state.doc.nodeAt(position) !== existing) return;
    const { dom } = editor.view.serializeForClipboard(editor.state.doc.slice(position, position + existing.nodeSize));
    event.clipboardData.setData("text/html", dom.innerHTML);
    event.clipboardData.setData("text/plain", String(existing.attrs.text));
    event.preventDefault();
  }}>
    <label>标签文字<input autoFocus value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (!event.nativeEvent.isComposing && event.key === "Enter") { event.preventDefault(); save(); } }} /></label>
    <div className="label-palette" role="group" aria-label="标签颜色">{palette.map(({ key, name }) => <button key={key} className="label-chip" data-color={key} aria-label={name} aria-pressed={color === key} onClick={() => chooseColor(key)}>{color === key && <Check aria-hidden="true" />}</button>)}</div>
    {error && <p role="alert">{error}</p>}<button className="secondary label-confirm" onClick={save}>确认标签</button>
  </Popup>;
}
