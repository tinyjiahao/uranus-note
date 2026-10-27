import { Node } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { Download, FileText, FileArchive, File as FileIcon, Minus, PanelTop } from "lucide-react";
import { useMemo, useState, useSyncExternalStore } from "react";
import { Popup } from "../Popup";
import { fileAttachmentAttributes, MIME_EXTENSIONS } from "../../../shared/files";
import type { AttachmentDto } from "../../api/client";

export const attachmentNode = (file: AttachmentDto) => file.mime.startsWith("image/")
  ? { type: "image", attrs: { attachmentId: file.id, src: file.url, alt: file.fileName } }
  : { type: "fileAttachment", attrs: { attachmentId: file.id, fileName: file.fileName, size: file.size, mime: file.mime } };
export const fileAccept = Object.entries(MIME_EXTENSIONS).filter(([mime]) => !mime.startsWith("image/")).flatMap(([mime, ext]) => [mime, `.${ext}`]).join(",");
// Some browsers omit MIME for Markdown/CSV. The server still validates all bytes.
export function fileWithMime(file: File) {
  if (file.type) return file;
  const extension = file.name.split(".").at(-1)?.toLowerCase();
  const mime = Object.entries(MIME_EXTENSIONS).find(([, ext]) => ext === extension)?.[0];
  return mime ? new File([file], file.name, { type: mime }) : file;
}
function FileCard({ node, selected, editor, getPos }: NodeViewProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
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
  return <NodeViewWrapper className={`file-attachment file-attachment--${display}${selected || anchor ? " ProseMirror-selectednode" : ""}`} contentEditable={false}>
    <button type="button" className={`file-attachment-link${mime === "application/pdf" ? " file-attachment-pdf" : ""}`} aria-label={`附件操作：${String(node.attrs.fileName)}`} aria-haspopup="dialog" aria-expanded={Boolean(anchor)} onClick={event => {
      event.stopPropagation();
      const pos = getPos();
      if (editor.isEditable && typeof pos === "number") editor.commands.setNodeSelection(pos);
      setAnchor(anchor ? null : event.currentTarget);
    }}>
      <Icon aria-hidden="true" /><span><strong title={String(node.attrs.fileName)}>{String(node.attrs.fileName)}</strong>{display === "card" && <small>{(Number(node.attrs.size) / 1024).toFixed(1)} KB</small>}</span>
    </button>
    {anchor && <Popup anchor={anchor} title="附件操作" placement="top" className="attachment-actions-popup" close={() => setAnchor(null)}>
      <div className="attachment-actions" role="group" aria-label="附件操作工具栏">
        <a className="attachment-action" aria-label="下载附件" title="下载附件" data-file-download href={`/api/attachments/${encodeURIComponent(String(node.attrs.attachmentId))}`} download={String(node.attrs.fileName)}><Download aria-hidden="true" /><span>下载</span></a>
        {editable && <><span className="attachment-action-divider" aria-hidden="true" />
          <button type="button" className="attachment-action" title="紧凑样式" aria-label="紧凑样式" aria-pressed={display === "compact"} onClick={() => changeDisplay("compact")}><Minus aria-hidden="true" /><span>紧凑</span></button>
          <button type="button" className="attachment-action" title="卡片样式" aria-label="卡片样式" aria-pressed={display === "card"} onClick={() => changeDisplay("card")}><PanelTop aria-hidden="true" /><span>卡片</span></button>
        </>}
      </div>
    </Popup>}
  </NodeViewWrapper>;
}
export const FileAttachment = Node.create({
  name: "fileAttachment", group: "block", atom: true, marks: "",
  addAttributes: () => ({ attachmentId: { default: "" }, fileName: { default: "" }, size: { default: 0 }, mime: { default: "" }, display: { default: "compact" } }),
  parseHTML: () => [{ tag: 'div[data-file-attachment="1"]', getAttrs: element => {
    const result = fileAttachmentAttributes.safeParse({ attachmentId: element.getAttribute("data-id"), fileName: element.getAttribute("data-name"), size: Number(element.getAttribute("data-size")), mime: element.getAttribute("data-mime"), display: element.getAttribute("data-display") ?? "compact" });
    return result.success ? result.data : false;
  } }],
  renderHTML: ({ node }) => ["div", { "data-file-attachment": "1", "data-id": node.attrs.attachmentId, "data-name": node.attrs.fileName, "data-size": node.attrs.size, "data-mime": node.attrs.mime, "data-display": node.attrs.display }, node.attrs.fileName],
  addNodeView: () => ReactNodeViewRenderer(FileCard),
});
