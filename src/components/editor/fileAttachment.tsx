import { Extension, Node, type Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { Fragment } from "@tiptap/pm/model";
import { GapCursor } from "@tiptap/pm/gapcursor";
import { NodeSelection, Plugin, TextSelection, type Selection } from "@tiptap/pm/state";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { Download, Eye, FileText, FileArchive, File as FileIcon, Minus, PanelTop, Rows3, TextCursorInput } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Popup } from "../Popup";
import { fileAttachmentAttributes, inlineFileAttributes, isPreviewable, MIME_EXTENSIONS } from "../../../shared/files";
import { openAttachmentPreview } from "../AttachmentPreview";
import type { AttachmentDto } from "../../api/client";

export const attachmentNode = (file: AttachmentDto) => file.mime.startsWith("image/")
  ? { type: "image", attrs: { attachmentId: file.id, src: file.url, alt: file.fileName } }
  : { type: "fileAttachment", attrs: { attachmentId: file.id, fileName: file.fileName, size: file.size, mime: file.mime } };
export const fileAccept = [...Object.entries(MIME_EXTENSIONS).filter(([mime]) => !mime.startsWith("image/")).flatMap(([mime, ext]) => [mime, `.${ext}`]), ".yaml"].join(",");
// Some browsers omit MIME for Markdown/CSV. The server still validates all bytes.
export function fileWithMime(file: File) {
  const extension = file.name.split(".").at(-1)?.toLowerCase();
  // Browsers report .json/.yml/.yaml as text/yaml, application/x-yaml, text/x-yaml or nothing; the server whitelist uses canonical types.
  if (extension === "json" || extension === "yml" || extension === "yaml") return new File([file], file.name, { type: extension === "json" ? "application/json" : "application/yaml" });
  if (file.type) return file;
  const mime = Object.entries(MIME_EXTENSIONS).find(([, ext]) => ext === extension)?.[0];
  return mime ? new File([file], file.name, { type: mime }) : file;
}
function FileCard({ node, selected, editor, getPos }: NodeViewProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  // Close the actions popup as soon as the caret/selection moves elsewhere (arrow keys, clicks) or the document changes.
  useEffect(() => {
    if (!anchor) return;
    const dismiss = () => { if (editor.isEditable) setAnchor(null); };
    editor.on("selectionUpdate", dismiss); editor.on("update", dismiss);
    return () => { editor.off("selectionUpdate", dismiss); editor.off("update", dismiss); };
  }, [anchor, editor]);
  const subscribe = useMemo(() => (listener: () => void) => {
    editor.on("transaction", listener);
    return () => { editor.off("transaction", listener); };
  }, [editor]);
  const editable = useSyncExternalStore(subscribe, () => editor.isEditable);
  const display = node.attrs.display === "card" ? "card" : "compact";
  const mime = String(node.attrs.mime);
  const Icon = mime === "application/pdf" ? FileText : mime === "application/zip" ? FileArchive : FileIcon;
  const changeDisplay = (value: "compact" | "card") => {
    if (!editor.isEditable || editor.isDestroyed) return;
    const pos = getPos();
    if (typeof pos !== "number") return;
    const current = editor.state.doc.nodeAt(pos);
    if (current?.type.name !== "fileAttachment" || current.attrs.attachmentId !== node.attrs.attachmentId) return;
    // Hot updates can replace this UI while an existing Editor still owns the
    // previous schema. ProseMirror silently drops attributes unknown to it.
    if (!Object.prototype.hasOwnProperty.call(current.attrs, "display")) {
      window.dispatchEvent(new CustomEvent("uranus-editor-error", { detail: "编辑器尚未加载附件样式更新，请先保存笔记，再刷新页面后切换。" }));
      return;
    }
    // Target the node's current position, not a selection lost when the popup takes focus.
    if (current.attrs.display !== value) editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, display: value }));
  };
  return <NodeViewWrapper data-drag-handle="" className={`file-attachment file-attachment--${display}${selected || anchor ? " ProseMirror-selectednode" : ""}`} contentEditable={false}>
    <button type="button" className={`file-attachment-link${mime === "application/pdf" ? " file-attachment-pdf" : ""}`} aria-label={`附件操作：${String(node.attrs.fileName)}`} aria-haspopup="dialog" aria-expanded={Boolean(anchor)} onClick={event => {
      event.stopPropagation();
      const pos = getPos();
      if (editor.isEditable && typeof pos === "number") editor.commands.setNodeSelection(pos);
      // Mouse: keep focus in the editor so Left/Right keep moving the caret. Keyboard (Enter/Space): move focus into the popup.
      const byKeyboard = event.detail === 0;
      if (!byKeyboard && editor.isEditable) editor.view.focus();
      setKeyboardOpen(byKeyboard);
      setAnchor(anchor ? null : event.currentTarget);
    }}>
      <Icon aria-hidden="true" /><span><strong title={String(node.attrs.fileName)}>{String(node.attrs.fileName)}</strong>{display === "card" && <small>{(Number(node.attrs.size) / 1024).toFixed(1)} KB</small>}</span>
    </button>
    {anchor && <Popup anchor={anchor} title="附件操作" autoFocus={keyboardOpen} positionAnchor={anchor.closest<HTMLElement>(".file-attachment")} placement="top" className="attachment-actions-popup" close={() => setAnchor(null)}>
      <div className="attachment-actions" role="group" aria-label="附件操作工具栏">
        <a className="attachment-action" aria-label="下载附件" title="下载附件" data-file-download href={`/api/attachments/${encodeURIComponent(String(node.attrs.attachmentId))}`} download={String(node.attrs.fileName)}><Download aria-hidden="true" /><span>下载</span></a>
        {isPreviewable(mime) && <button type="button" className="attachment-action" title="预览附件" aria-label={`预览附件：${String(node.attrs.fileName)}`} onClick={() => { setAnchor(null); openAttachmentPreview({ id: String(node.attrs.attachmentId), name: String(node.attrs.fileName), mime, size: Number(node.attrs.size) }); }}><Eye aria-hidden="true" /><span>预览</span></button>}
        {editable && <><span className="attachment-action-divider" aria-hidden="true" />
          <button type="button" className="attachment-action" title="转为行内附件（可与文字同行）" aria-label="转为行内附件" onClick={() => { const pos = getPos(); setAnchor(null); if (typeof pos === "number") { editor.commands.setNodeSelection(pos); fileToInline(editor); } }}><TextCursorInput aria-hidden="true" /><span>行内</span></button>
          <button type="button" className="attachment-action" title="紧凑样式" aria-label="紧凑样式" aria-pressed={display === "compact"} onClick={() => changeDisplay("compact")}><Minus aria-hidden="true" /><span>紧凑</span></button>
          <button type="button" className="attachment-action" title="卡片样式" aria-label="卡片样式" aria-pressed={display === "card"} onClick={() => changeDisplay("card")}><PanelTop aria-hidden="true" /><span>卡片</span></button>
        </>}
      </div>
    </Popup>}
  </NodeViewWrapper>;
}
export const FileAttachment = Node.create({
  name: "fileAttachment", group: "block", atom: true, draggable: true, marks: "",
  addAttributes: () => ({ attachmentId: { default: "" }, fileName: { default: "" }, size: { default: 0 }, mime: { default: "" }, display: { default: "compact" } }),
  parseHTML: () => [{ tag: 'div[data-file-attachment="1"]', getAttrs: element => {
    const result = fileAttachmentAttributes.safeParse({ attachmentId: element.getAttribute("data-id"), fileName: element.getAttribute("data-name"), size: Number(element.getAttribute("data-size")), mime: element.getAttribute("data-mime"), display: element.getAttribute("data-display") ?? "compact" });
    return result.success ? result.data : false;
  } }],
  renderHTML: ({ node }) => ["div", { "data-file-attachment": "1", "data-id": node.attrs.attachmentId, "data-name": node.attrs.fileName, "data-size": node.attrs.size, "data-mime": node.attrs.mime, "data-display": node.attrs.display }, node.attrs.fileName],
  addNodeView: () => ReactNodeViewRenderer(FileCard),
});

// Clicking the blank area of a table cell below a trailing attachment would put the caret in the paragraph before it;
// place a gap cursor after the attachment instead so text can be typed after it.
export const CellTailClick = Extension.create({
  name: "cellTailClick",
  addProseMirrorPlugins() {
    return [new Plugin({ props: { handleKeyDown: (view, event) => {
      // A selected trailing attachment stays selected on Down/End (typing would replace it); move to a gap cursor after it instead.
      const { selection } = view.state;
      if (!view.editable || !(selection instanceof NodeSelection) || selection.node.type.name !== "fileAttachment") return false;
      if (!["ArrowDown", "End"].includes(event.key) || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || selection.$to.nodeAfter) return false;
      view.dispatch(view.state.tr.setSelection(new GapCursor(selection.$to)));
      return true;
    }, handleClick: (view, _pos, event) => {
      const cell = (event.target as HTMLElement | null)?.closest?.("td, th");
      if (!view.editable || !cell || event.target !== cell) return false;
      const inside = view.state.doc.resolve(view.posAtDOM(cell, 0));
      const last = inside.parent.lastChild;
      if (!["tableCell", "tableHeader"].includes(inside.parent.type.name) || last?.type.name !== "fileAttachment") return false;
      const lastDom = view.nodeDOM(inside.end() - last.nodeSize);
      if (!(lastDom instanceof HTMLElement) || event.clientY < lastDom.getBoundingClientRect().bottom) return false;
      view.dispatch(view.state.tr.setSelection(new GapCursor(view.state.doc.resolve(inside.end()))));
      view.focus();
      return true;
    } } })];
  },
});

const fileIcon = (mime: string) => mime === "application/pdf" ? FileText : mime === "application/zip" ? FileArchive : FileIcon;
export const inlineFileNode = (file: AttachmentDto) => ({ type: "inlineFile", attrs: { attachmentId: file.id, fileName: file.fileName, size: file.size, mime: file.mime } });

/** New files go into the current paragraph as an inline chip; otherwise into a new paragraph after the selected/current block. */
export function insertInlineFile(editor: Editor, selection: Selection, attachment: AttachmentDto) {
  const content = inlineFileNode(attachment);
  if (selection instanceof TextSelection && selection.empty && selection.$from.parent.type.name === "paragraph") return editor.chain().command(({ tr }) => { tr.setSelection(selection); return true; }).insertContent(content).run();
  return editor.chain().command(({ tr }) => {
    const at = selection instanceof NodeSelection ? selection.to : selection.$to.depth ? selection.$to.after(selection.$to.depth) : selection.to;
    try { tr.insert(at, editor.schema.nodes.paragraph!.create(null, editor.schema.nodes.inlineFile!.create(content.attrs))); } catch { return false; }
    tr.setSelection(TextSelection.create(tr.doc, at + 2));
    return true;
  }).run();
}

/** Selected block attachment -> inline chip in its own paragraph. */
export function fileToInline(editor: Editor) {
  const selection = editor.state.selection;
  if (!editor.isEditable || !(selection instanceof NodeSelection) || selection.node.type.name !== "fileAttachment") return false;
  const { attachmentId, fileName, size, mime } = selection.node.attrs;
  const tr = editor.state.tr;
  try { tr.replaceWith(selection.from, selection.to, editor.schema.nodes.paragraph!.create(null, editor.schema.nodes.inlineFile!.create({ attachmentId, fileName, size, mime }))); } catch { return false; }
  tr.setSelection(NodeSelection.create(tr.doc, selection.from + 1));
  editor.view.dispatch(closeHistory(tr).scrollIntoView());
  return true;
}

/** Selected inline chip -> block attachment (splits the paragraph around it). */
export function inlineToFile(editor: Editor) {
  const selection = editor.state.selection;
  if (!editor.isEditable || !(selection instanceof NodeSelection) || selection.node.type.name !== "inlineFile") return false;
  const { $from } = selection, paragraph = $from.parent;
  if (paragraph.type.name !== "paragraph") return false;
  const offset = $from.parentOffset, { attachmentId, fileName, size, mime } = selection.node.attrs;
  const block = editor.schema.nodes.fileAttachment!.create({ attachmentId, fileName, size, mime, display: "compact" });
  const parts = [] as (typeof block)[];
  const head = paragraph.content.cut(0, offset), tail = paragraph.content.cut(offset + selection.node.nodeSize);
  if (head.size) parts.push(paragraph.type.create(paragraph.attrs, head));
  parts.push(block);
  if (tail.size) parts.push(paragraph.type.create(paragraph.attrs, tail));
  const start = $from.before(), end = $from.after();
  const tr = editor.state.tr;
  try { tr.replaceWith(start, end, Fragment.from(parts)); } catch { return false; }
  tr.setSelection(NodeSelection.create(tr.doc, start + (head.size ? parts[0]!.nodeSize : 0)));
  editor.view.dispatch(closeHistory(tr).scrollIntoView());
  return true;
}

function InlineFileView({ node, selected, editor, getPos }: NodeViewProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  useEffect(() => {
    if (!anchor) return;
    const dismiss = () => { if (editor.isEditable) setAnchor(null); };
    editor.on("selectionUpdate", dismiss); editor.on("update", dismiss);
    return () => { editor.off("selectionUpdate", dismiss); editor.off("update", dismiss); };
  }, [anchor, editor]);
  const subscribe = useMemo(() => (listener: () => void) => { editor.on("transaction", listener); return () => { editor.off("transaction", listener); }; }, [editor]);
  const editable = useSyncExternalStore(subscribe, () => editor.isEditable);
  const mime = String(node.attrs.mime), name = String(node.attrs.fileName), Icon = fileIcon(mime);
  return <NodeViewWrapper as="span" data-drag-handle="" className={`inline-file${selected || anchor ? " ProseMirror-selectednode" : ""}`} contentEditable={false}>
    <button type="button" className="inline-file-link" aria-label={`附件操作：${name}`} aria-haspopup="dialog" aria-expanded={Boolean(anchor)} onClick={event => {
      event.stopPropagation();
      const pos = getPos();
      if (editor.isEditable && typeof pos === "number") editor.commands.setNodeSelection(pos);
      const byKeyboard = event.detail === 0;
      if (!byKeyboard && editor.isEditable) editor.view.focus();
      setKeyboardOpen(byKeyboard);
      setAnchor(anchor ? null : event.currentTarget);
    }}><Icon aria-hidden="true" /><span title={name}>{name}</span></button>
    {anchor && <Popup anchor={anchor} title="附件操作" autoFocus={keyboardOpen} placement="top" className="attachment-actions-popup" close={() => setAnchor(null)}>
      <div className="attachment-actions" role="group" aria-label="附件操作工具栏">
        <a className="attachment-action" aria-label="下载附件" title="下载附件" data-file-download href={`/api/attachments/${encodeURIComponent(String(node.attrs.attachmentId))}`} download={name}><Download aria-hidden="true" /><span>下载</span></a>
        {isPreviewable(mime) && <button type="button" className="attachment-action" title="预览附件" aria-label={`预览附件：${name}`} onClick={() => { setAnchor(null); openAttachmentPreview({ id: String(node.attrs.attachmentId), name, mime, size: Number(node.attrs.size) }); }}><Eye aria-hidden="true" /><span>预览</span></button>}
        {editable && <><span className="attachment-action-divider" aria-hidden="true" />
          <button type="button" className="attachment-action" title="转为独立附件（单独一行）" aria-label="转为独立附件" onClick={() => { const pos = getPos(); setAnchor(null); if (typeof pos === "number") { editor.commands.setNodeSelection(pos); inlineToFile(editor); } }}><Rows3 aria-hidden="true" /><span>独立</span></button>
        </>}
      </div>
    </Popup>}
  </NodeViewWrapper>;
}

export const InlineFile = Node.create({
  name: "inlineFile", group: "inline", inline: true, atom: true, draggable: true, marks: "",
  addAttributes: () => ({ attachmentId: { default: "" }, fileName: { default: "" }, size: { default: 0 }, mime: { default: "" } }),
  parseHTML: () => [{ tag: 'span[data-inline-file="1"]', getAttrs: element => {
    const result = inlineFileAttributes.safeParse({ attachmentId: element.getAttribute("data-id"), fileName: element.getAttribute("data-name"), size: Number(element.getAttribute("data-size")), mime: element.getAttribute("data-mime") });
    return result.success ? result.data : false;
  } }],
  renderHTML: ({ node }) => ["span", { "data-inline-file": "1", "data-id": node.attrs.attachmentId, "data-name": node.attrs.fileName, "data-size": node.attrs.size, "data-mime": node.attrs.mime }, node.attrs.fileName],
  renderText: ({ node }) => String(node.attrs.fileName),
  addNodeView: () => ReactNodeViewRenderer(InlineFileView),
});
