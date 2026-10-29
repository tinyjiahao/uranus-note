import { Node, type Editor } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { closeHistory } from "@tiptap/pm/history";
import { NodeSelection, TextSelection, type Selection } from "@tiptap/pm/state";
import { Fragment } from "@tiptap/pm/model";
import { useEffect, useRef, useState } from "react";
import { pointAnchor, type PopupAnchor } from "../Popup";
import { ImagePreview } from "./ImagePreview";
import { INLINE_IMAGE_MAX_WIDTH, INLINE_IMAGE_MIN_WIDTH } from "../../../shared/inlineImage";
import type { AttachmentDto } from "../../api/client";

const validWidth = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= INLINE_IMAGE_MIN_WIDTH && value <= INLINE_IMAGE_MAX_WIDTH ? value : null;

function InlineImageView({ node, editor, getPos, selected, updateAttributes }: NodeViewProps) {
  const [preview, setPreview] = useState(false);
  const [width, setWidth] = useState<number | null>(validWidth(node.attrs.width));
  const drag = useRef<{ startX: number; startWidth: number; latest: number } | undefined>(undefined);
  const cleanup = useRef<() => void>(() => undefined);
  useEffect(() => { if (!drag.current) setWidth(validWidth(node.attrs.width)); }, [node.attrs.width]);
  useEffect(() => () => { drag.current = undefined; cleanup.current(); }, []);
  const select = () => { const pos = getPos(); if (typeof pos === "number" && editor.isEditable) editor.commands.setNodeSelection(pos); };
  const openMenu = (anchor: PopupAnchor) => {
    if (!editor.isEditable) return;
    select();
    editor.view.dom.dispatchEvent(new CustomEvent("uranus-table-menu", { detail: { kind: "image", anchor } }));
  };
  return <NodeViewWrapper as="span" className={`inline-image${selected ? " image-selected" : ""}`} onContextMenu={(event: React.MouseEvent) => {
    if (!editor.isEditable) return; event.preventDefault(); event.stopPropagation(); openMenu(pointAnchor(event.currentTarget as HTMLElement, event.clientX, event.clientY));
  }}>
    {editor.isEditable && <span className="inline-drag-handle" data-drag-handle="" contentEditable={false} aria-hidden="true" title="拖动调整位置" />}
    <img data-drag-handle="" draggable={false} loading="lazy" decoding="async" src={String(node.attrs.src)} data-attachment-id={String(node.attrs.attachmentId ?? "")} alt={String(node.attrs.alt ?? "")} style={width ? { width, height: "auto" } : undefined} title="双击放大图片" onClick={select}
      onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); setPreview(true); }} />
    {editor.isEditable && <button className="image-resize-handle" aria-label="调整图片宽度" onPointerDown={event => {
      event.preventDefault(); event.stopPropagation();
      const image = event.currentTarget.previousElementSibling as HTMLImageElement;
      const startWidth = image.getBoundingClientRect().width;
      drag.current = { startX: event.clientX, startWidth, latest: startWidth };
      const move = (moveEvent: PointerEvent) => {
        const current = drag.current; if (!current) return;
        if (!editor.isEditable) { cancel(); return; }
        const next = Math.min(INLINE_IMAGE_MAX_WIDTH, Math.max(INLINE_IMAGE_MIN_WIDTH, current.startWidth + moveEvent.clientX - current.startX));
        current.latest = next; setWidth(Math.round(next));
      };
      const stop = () => {
        const current = drag.current;
        if (current && editor.isEditable) { editor.view.dispatch(closeHistory(editor.state.tr)); updateAttributes({ width: Math.round(current.latest) }); }
        drag.current = undefined; cleanup.current();
      };
      const cancel = () => { drag.current = undefined; setWidth(validWidth(node.attrs.width)); cleanup.current(); };
      const key = (keyEvent: KeyboardEvent) => { if (keyEvent.key === "Escape") { keyEvent.preventDefault(); cancel(); } };
      cleanup.current = () => {
        window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", cancel); window.removeEventListener("blur", cancel); window.removeEventListener("keydown", key);
      };
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop); window.addEventListener("pointercancel", cancel); window.addEventListener("blur", cancel); window.addEventListener("keydown", key);
    }} />}
    {preview && <ImagePreview src={String(node.attrs.src)} alt={String(node.attrs.alt ?? "")} close={() => setPreview(false)} />}
  </NodeViewWrapper>;
}

export const InlineImage = Node.create({
  name: "inlineImage",
  group: "inline",
  inline: true,
  atom: true,
  draggable: true,
  marks: "",
  addAttributes() {
    return {
      attachmentId: { default: null, parseHTML: element => element.getAttribute("data-attachment-id"), renderHTML: attrs => ({ "data-attachment-id": attrs.attachmentId }) },
      src: { default: null },
      alt: { default: null },
      width: { default: null, parseHTML: element => validWidth(Number(element.getAttribute("width"))), renderHTML: attrs => validWidth(attrs.width) ? { width: attrs.width } : {} },
    };
  },
  parseHTML() { return [{ tag: "img[data-inline-image]", priority: 60 }]; },
  renderHTML({ HTMLAttributes }) { return ["img", { ...HTMLAttributes, "data-inline-image": "" }]; },
  addNodeView() { return ReactNodeViewRenderer(InlineImageView); },
});

/** True when the caret sits in a paragraph, where an inline image can be inserted directly. */
export function insertsInline(selection: Selection) {
  return selection instanceof TextSelection && selection.empty && selection.$from.parent.type.name === "paragraph";
}

/** New images are always inline: inside a paragraph they flow with the text, elsewhere (headings, code blocks, a selected node) they get their own paragraph right after the current block. */
export function insertImage(editor: Editor, selection: Selection, attachment: AttachmentDto) {
  const attrs = { attachmentId: attachment.id, src: attachment.url, alt: attachment.fileName };
  if (insertsInline(selection)) return editor.chain().command(({ tr }) => { tr.setSelection(selection); return true; }).insertContent({ type: "inlineImage", attrs }).run();
  return editor.chain().command(({ tr }) => {
    const at = selection instanceof NodeSelection ? selection.to : selection.$to.depth ? selection.$to.after(selection.$to.depth) : selection.to;
    try { tr.insert(at, editor.schema.nodes.paragraph!.create(null, editor.schema.nodes.inlineImage!.create(attrs))); } catch { return false; }
    tr.setSelection(TextSelection.create(tr.doc, at + 2));
    return true;
  }).run();
}

const onlyInlineImages = (paragraph: { type: { name: string }; childCount: number; forEach: (callback: (child: { type: { name: string } }) => void) => void }) => {
  if (paragraph.type.name !== "paragraph" || !paragraph.childCount) return false;
  let only = true; paragraph.forEach(child => { if (child.type.name !== "inlineImage") only = false; });
  return only;
};

/** Width the image is currently drawn at, so conversions can pin the same display size. */
function renderedWidth(editor: Editor, pos: number) {
  const dom = editor.view.nodeDOM(pos);
  const image = dom instanceof HTMLImageElement ? dom : dom instanceof HTMLElement ? dom.querySelector("img") : null;
  const width = image?.getBoundingClientRect().width ?? 0;
  return width > 0 ? Math.round(width) : null;
}

/** Block image -> inline image; joins the previous paragraph when it already holds only inline images. */
export function imageToInline(editor: Editor) {
  const selection = editor.state.selection;
  if (!editor.isEditable || !(selection instanceof NodeSelection) || selection.node.type.name !== "image") return false;
  const type = editor.schema.nodes.inlineImage!, node = selection.node, pos = selection.from;
  const shown = renderedWidth(editor, pos);
  const attrs = { attachmentId: node.attrs.attachmentId, src: node.attrs.src, alt: typeof node.attrs.alt === "string" ? node.attrs.alt : null, width: validWidth(shown !== null ? Math.min(INLINE_IMAGE_MAX_WIDTH, Math.max(INLINE_IMAGE_MIN_WIDTH, shown)) : node.attrs.width) };
  const inline = type.create(attrs);
  const tr = editor.state.tr, before = tr.doc.resolve(pos).nodeBefore;
  if (before && onlyInlineImages(before)) {
    tr.delete(pos, pos + node.nodeSize).insert(pos - 1, inline);
    tr.setSelection(TextSelection.create(tr.doc, pos));
  } else {
    tr.replaceWith(pos, pos + node.nodeSize, editor.schema.nodes.paragraph!.create(null, inline));
    tr.setSelection(TextSelection.create(tr.doc, pos + 2));
  }
  editor.view.dispatch(closeHistory(tr).scrollIntoView());
  return true;
}

/** Inline image -> standalone block image; splits the surrounding paragraph around it. */
export function imageToBlock(editor: Editor) {
  const selection = editor.state.selection;
  if (!editor.isEditable || !(selection instanceof NodeSelection) || selection.node.type.name !== "inlineImage") return false;
  const { $from } = selection, paragraph = $from.parent;
  if (paragraph.type.name !== "paragraph") return false;
  const offset = $from.parentOffset, node = selection.node;
  const shown = renderedWidth(editor, selection.from);
  const block = editor.schema.nodes.image!.create({ attachmentId: node.attrs.attachmentId, src: node.attrs.src, alt: node.attrs.alt, width: shown ?? node.attrs.width });
  const parts = [] as ReturnType<typeof block.copy>[];
  const head = paragraph.content.cut(0, offset), tail = paragraph.content.cut(offset + node.nodeSize);
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

/** Copy the selected image to the system clipboard: PNG pixels for other apps, plus node HTML so pasting back here keeps the same attachment attributes and displayed size. */
export function copySelectedImage(editor: Editor) {
  const selection = editor.state.selection;
  if (!(selection instanceof NodeSelection) || !["image", "inlineImage"].includes(selection.node.type.name)) return;
  const node = selection.node, src = String(node.attrs.src ?? "");
  const notify = (name: string, detail: string) => window.dispatchEvent(new CustomEvent(name, { detail }));
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") { notify("uranus-editor-error", "当前浏览器不支持复制图片，请使用快捷键复制或保存后再上传。"); return; }
  const element = document.createElement("img");
  element.setAttribute("src", src); element.setAttribute("alt", String(node.attrs.alt ?? "")); element.setAttribute("data-attachment-id", String(node.attrs.attachmentId ?? ""));
  if (node.type.name === "inlineImage") element.setAttribute("data-inline-image", "");
  if (validWidth(node.attrs.width)) element.setAttribute("width", String(node.attrs.width));
  if (node.attrs.imageAlign) element.setAttribute("data-image-align", String(node.attrs.imageAlign));
  const png = (async () => {
    const response = await fetch(src, { credentials: "same-origin" });
    if (!response.ok) throw new Error("图片读取失败");
    const blob = await response.blob();
    if (blob.type === "image/png") return blob;
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0); bitmap.close();
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error("图片转换失败")), "image/png"));
  })();
  navigator.clipboard.write([new ClipboardItem({ "image/png": png, "text/html": new Blob([element.outerHTML], { type: "text/html" }) })])
    .then(() => notify("uranus-editor-notice", "图片已复制"))
    .catch(error => notify("uranus-editor-error", `复制图片失败：${(error as Error).message || "浏览器拒绝访问剪贴板"}`));
}
