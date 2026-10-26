import Highlight from "@tiptap/extension-highlight";
import TextAlign from "@tiptap/extension-text-align";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { IndentIncrease, IndentDecrease, ExternalLink, Pencil, Unlink } from "lucide-react";
import { tableExtensions, tableContext } from "./tables";
import { CellSelection } from "@tiptap/pm/tables";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { SelectionBookmark } from "@tiptap/pm/state";
import { Slice } from "@tiptap/pm/model";
import { Popup, pointAnchor, type PopupAnchor } from "../Popup";
import { TablePicker, TableTools } from "./TableTools";
import { readPreference, writePreference, useUiStore } from "../../state/ui";
import Underline from "@tiptap/extension-underline";
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type NodeViewProps } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { AlignLeft, AlignCenter, AlignRight, Bold, Braces, CaseLower, CheckSquare, Clipboard, Code, Eye, Heading1, Heading2, Highlighter, ImagePlus, Italic, Link2, List, ListOrdered, Minus, MoveHorizontal, Quote, Redo2, Search, Strikethrough, Table2, Underline as UnderlineIcon, Undo2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ContentNode, NoteDetail } from "../../../shared/dto";
import { copyAttachment, uploadAttachment } from "../../api/client";
import { SearchHighlight, searchHighlightKey, updateEditorSearch } from "./searchHighlight";
import { Extension, Mark, mergeAttributes, type Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { createPortal } from "react-dom";
import { joinNoteTitle, splitNoteTitle, titleText, updateTitle } from "./noteTitle";
import { validateAndDeriveContent } from "../../../shared/content";

const SmallText = Mark.create({
  name: "small",
  parseHTML: () => [{ tag: "small" }, { tag: "span[data-small-text]" }],
  renderHTML: ({ HTMLAttributes }) => ["small", mergeAttributes(HTMLAttributes, { "data-small-text": "" }), 0],
});

const CodeBlockControls = Extension.create({
  name: "codeBlockControls",
  addKeyboardShortcuts() {
    return {
      Tab: () => this.editor.isActive("codeBlock") && this.editor.commands.insertContent("  "),
      "Shift-Tab": () => {
        if (!this.editor.isActive("codeBlock")) return false;
        const { from } = this.editor.state.selection;
        const before = this.editor.state.doc.textBetween(Math.max(0, from - 2), from);
        const remove = before.endsWith("  ") ? 2 : before.endsWith(" ") ? 1 : 0;
        return remove ? this.editor.commands.deleteRange({ from: from - remove, to: from }) : true;
      },
      "Mod-Enter": () => {
        const { $from } = this.editor.state.selection;
        for (let depth = $from.depth; depth > 0; depth--) {
          if ($from.node(depth).type.name !== "codeBlock") continue;
          const end = $from.after(depth);
          const tr = this.editor.state.tr;
          if (tr.doc.nodeAt(end)?.type.name !== "paragraph") tr.insert(end, this.editor.schema.nodes.paragraph!.create());
          tr.setSelection(TextSelection.near(tr.doc.resolve(end + 1)));
          this.editor.view.dispatch(tr.scrollIntoView());
          return true;
        }
        return false;
      },
    };
  },
});

function safeHref(value: string) {
  try { return ["http:", "https:", "mailto:"].includes(new URL(value).protocol); } catch { return false; }
}

function externalTable(html: string): ContentNode | null {
  if (!/<table[\s>]/i.test(html)) return null;
  const document = new DOMParser().parseFromString(html, "text/html");
  const table = document.querySelector("table");
  if (!table) return null;
  if (table.querySelector("table table")) throw new Error("暂不支持粘贴嵌套表格");
  const rows = Array.from(table.rows);
  if (!rows.length || rows.length > 100) throw new Error("表格行数必须为 1—100");
  if (rows.some(row => Array.from(row.cells).some(cell => cell.rowSpan !== 1 || cell.colSpan !== 1))) throw new Error("暂不支持含合并单元格的表格，请先取消合并后重试");
  const columns = Math.max(...rows.map(row => row.cells.length));
  if (!columns || columns > 30) throw new Error("表格列数必须为 1—30");
  return { type: "table", attrs: { widthMode: "fluid" }, content: rows.map(row => ({
    type: "tableRow",
    content: Array.from({ length: columns }, (_, index) => {
      const cell = row.cells[index];
      const value = cell?.textContent?.replace(/\r\n?/g, "\n").trim() ?? "";
      return { type: cell?.tagName === "TH" ? "tableHeader" : "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [{ type: "paragraph", ...(value ? { content: [{ type: "text", text: value }] } : {}) }] };
    }),
  })) };
}

function literalRanges(value: string, query: string) {
  const ranges: Array<[number, number]> = [];
  let haystack = "", needle = "", original = 0;
  const starts: number[] = [], ends: number[] = [];
  for (const point of value) { const lowered = point.toLowerCase(); haystack += lowered; for (let index = 0; index < lowered.length; index++) { starts.push(original); ends.push(original + point.length); } original += point.length; }
  for (const point of query) needle += point.toLowerCase();
  if (!needle) return ranges;
  for (let offset = 0; (offset = haystack.indexOf(needle, offset)) >= 0; offset += Math.max(1, needle.length)) ranges.push([starts[offset] ?? offset, ends[offset + needle.length - 1] ?? offset + needle.length]);
  return ranges;
}

function repairRectangularTables(input: ContentNode) {
  const repaired = structuredClone(input), added = { count: 0 };
  const visit = (node: ContentNode) => {
    if (node.type === "table") {
      const rows = node.content ?? [];
      if (rows.some(row => row.type !== "tableRow" || (row.content ?? []).some(cell => Number(cell.attrs?.colspan ?? 1) !== 1 || Number(cell.attrs?.rowspan ?? 1) !== 1))) return false;
      const width = Math.max(0, ...rows.map(row => row.content?.length ?? 0));
      if (!width) return false;
      for (const row of rows) while ((row.content?.length ?? 0) < width) {
        row.content ??= [];
        row.content.push({ type: "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [{ type: "paragraph" }] });
        added.count++;
      }
    }
    for (const child of node.content ?? []) if (!visit(child)) return false;
    return true;
  };
  return visit(repaired) && added.count ? { content: repaired, added: added.count } : null;
}

function alignText(editor: Editor, alignment: "left" | "center" | "right") {
  if (!editor.isEditable) return false;
  const chain = editor.chain().focus().command(({ tr }) => { closeHistory(tr); return true; });
  if (editor.state.selection instanceof CellSelection) return chain.setCellAttribute("textAlign", alignment).run();
  return editor.isActive("image") ? chain.updateAttributes("image", { imageAlign: alignment }).run() : chain.setTextAlign(alignment).run();
}

function ResizableImageNode({ node, updateAttributes, editor, getPos, selected }: NodeViewProps) {
  const initial = typeof node.attrs.width === "number" ? node.attrs.width : undefined;
  const [width, setWidth] = useState<number | undefined>(initial);
  const drag = useRef<{ startX: number; startWidth: number; latest: number } | undefined>(undefined);
  const cleanup = useRef<() => void>(() => undefined);
  useEffect(() => { if (!drag.current) setWidth(typeof node.attrs.width === "number" ? node.attrs.width : undefined); }, [node.attrs.width]);
  useEffect(() => () => { drag.current = undefined; cleanup.current(); }, []);
  const openMenu = (anchor: PopupAnchor) => {
    if (!editor.isEditable) return;
    const pos = getPos(); if (typeof pos !== "number") return;
    editor.commands.setNodeSelection(pos);
    editor.view.dom.dispatchEvent(new CustomEvent("uranus-table-menu", { detail: { kind: "image", anchor } }));
  };
  return <NodeViewWrapper as="figure" className={`resizable-image${selected ? " image-selected" : ""}`} data-image-align={node.attrs.imageAlign ?? undefined} style={node.attrs.imageAlign ? { textAlign: node.attrs.imageAlign } : undefined} onContextMenu={(event: React.MouseEvent) => {
    if (!editor.isEditable) return; event.preventDefault(); event.stopPropagation(); openMenu(pointAnchor(event.currentTarget as HTMLElement, event.clientX, event.clientY));
  }}>
    <span className="image-frame" draggable data-drag-handle contentEditable={false}>
    <img src={String(node.attrs.src)} data-attachment-id={String(node.attrs.attachmentId ?? "")} alt={String(node.attrs.alt ?? "")} style={width ? { width } : undefined} onClick={() => {
      const pos = getPos(); if (typeof pos === "number") editor.commands.setNodeSelection(pos);
    }} />
    {editor.isEditable && <button className="image-resize-handle" aria-label="调整图片宽度" onPointerDown={(event) => {
      event.preventDefault(); event.stopPropagation();
      if (!editor.isEditable) return;
      const image = event.currentTarget.previousElementSibling as HTMLImageElement;
      const startWidth = image.getBoundingClientRect().width;
      drag.current = { startX: event.clientX, startWidth, latest: startWidth };
      const move = (moveEvent: PointerEvent) => {
        const current = drag.current; if (!current) return;
        if (!editor.isEditable) { drag.current = undefined; setWidth(initial); cleanup.current(); return; }
        const next = Math.min(900, Math.max(120, current.startWidth + moveEvent.clientX - current.startX));
        current.latest = next; setWidth(next);
      };
      const stop = () => {
        const current = drag.current; if (current && editor.isEditable) { editor.view.dispatch(closeHistory(editor.state.tr)); updateAttributes({ width: Math.round(current.latest) }); }
        drag.current = undefined; cleanup.current();
      };
      const cancel = () => { drag.current = undefined; setWidth(initial); cleanup.current(); };
      const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); cancel(); } };
      cleanup.current = () => {
        window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", cancel); window.removeEventListener("blur", cancel); window.removeEventListener("keydown", key);
      };
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop); window.addEventListener("pointercancel", cancel); window.addEventListener("blur", cancel); window.addEventListener("keydown", key);
    }} />}
    {editor.isEditable && selected && <button className="image-menu-button" aria-label="图片操作" aria-haspopup="dialog" onMouseDown={event => event.preventDefault()} onClick={event => openMenu(event.currentTarget)}>•••</button>}
    </span>
  </NodeViewWrapper>;
}

const AttachmentImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      attachmentId: { default: null, parseHTML: (element) => element.getAttribute("data-attachment-id"), renderHTML: (attrs) => ({ "data-attachment-id": attrs.attachmentId }) },
      width: { default: null, parseHTML: (element) => element.getAttribute("width"), renderHTML: (attrs) => attrs.width ? { width: attrs.width } : {} },
      imageAlign: { default: null, parseHTML: (element) => {
        const value = element.getAttribute("data-image-align"); return value && ["left", "center", "right"].includes(value) ? value : null;
      }, renderHTML: (attrs) => attrs.imageAlign ? { "data-image-align": attrs.imageAlign } : {} },
    };
  },
  addNodeView() { return ReactNodeViewRenderer(ResizableImageNode); },
});

export function NoteEditor({ note, onChange, onFlush, onPersistLocal = onFlush, onUploadState, readOnlyBecauseDeleted, titleHost }: { note: NoteDetail; onChange: (content: ContentNode) => void; onFlush: () => Promise<void>; onPersistLocal?: () => Promise<void>; onUploadState?: (uploading: boolean) => void; readOnlyBecauseDeleted: boolean; titleHost?: HTMLElement | null }) {
  const [initialParts] = useState(() => splitNoteTitle(note.content));
  const [structureIssue, setStructureIssue] = useState(() => {
    try { validateAndDeriveContent(note.content, note.contentSchemaVersion); return null; }
    catch (error) { return { message: (error as Error).message, repair: repairRectangularTables(note.content) }; }
  });
  const titleNode = useRef(initialParts.title);
  const [titleValue, setTitleValue] = useState(() => titleText(initialParts.title));
  const titleFieldRef = useRef<HTMLTextAreaElement>(null);
  const preferenceKey = `uranus.readOnly.${note.id}`;
  const [readOnlyPreference, setReadOnly] = useState(readPreference(preferenceKey) === "1");
  const readOnly = readOnlyBecauseDeleted || readOnlyPreference;
  const { widthMode, setWidthMode, editorFontSize } = useUiStore();
  const [tablePicker, setTablePicker] = useState<{ anchor: PopupAnchor; range?: { from: number; to: number } } | null>(null);
  const [editorError, setEditorError] = useState("");
  const [editorNotice, setEditorNotice] = useState("");
  useEffect(() => {
    if (!editorNotice) return;
    const timer = window.setTimeout(() => setEditorNotice(""), 3000);
    return () => window.clearTimeout(timer);
  }, [editorNotice]);
  const [upload, setUpload] = useState<{ file: File; busy: boolean; error: string } | null>(null);
  const uploadBookmark = useRef<SelectionBookmark | null>(null);
  const retryPaste = useRef<(() => void) | null>(null);
  const [pasteError, setPasteError] = useState("");
  const pasteHandler = useRef<(event: ClipboardEvent, slice: Slice) => boolean>(() => false);
  const [showRowNumbers, setShowRowNumbers] = useState(() => readPreference("uranus.table.rowNumbers") === "1");
  const [linkDialog, setLinkDialog] = useState<{ from: number; to: number; name: string; href: string; error: string } | null>(null);
  const [linkActions, setLinkActions] = useState<{ from: number; to: number; href: string; anchor: PopupAnchor } | null>(null);
  useEffect(() => { const handler = (event: Event) => setEditorError((event as CustomEvent<string>).detail); window.addEventListener("uranus-editor-error", handler); return () => window.removeEventListener("uranus-editor-error", handler); }, []);
  const [findOpen, setFindOpen] = useState(false);
  const [find, setFind] = useState("");
  const [findIndex, setFindIndex] = useState(0);
  const [findCount, setFindCount] = useState(0);
  const [findTitleActive, setFindTitleActive] = useState(false);
  const extensions = useMemo(() => [
    StarterKit.configure({ link: false, underline: false }), Underline, Highlight, TaskList, TaskItem.configure({ nested: true }), SmallText, CodeBlockControls,
    TextAlign.extend({ addKeyboardShortcuts() { return {
      "Mod-Shift-l": () => alignText(this.editor, "left"),
      "Mod-Shift-e": () => alignText(this.editor, "center"),
      "Mod-Shift-r": () => alignText(this.editor, "right"),
    }; } }).configure({ types: ["heading", "paragraph"], alignments: ["left", "center", "right"], defaultAlignment: null }),
    Link.configure({ openOnClick: false, autolink: true, defaultProtocol: "https", protocols: ["http", "https", "mailto"], HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" } }),
    ...tableExtensions, AttachmentImage.configure({ inline: false, allowBase64: false }), SearchHighlight,
  ], []);
  const editor = useEditor({
    extensions, content: initialParts.body, editable: !readOnly, immediatelyRender: false,
    editorProps: { attributes: { class: "prose-editor", "aria-label": "笔记正文" }, handlePaste: (_view, event, slice) => pasteHandler.current(event, slice) },
    onUpdate: ({ editor: instance }) => {
      setEditorError("");
      onChange(joinNoteTitle(titleNode.current, instance.getJSON() as ContentNode));
    },
    onBlur: () => { void onPersistLocal(); },
  });
  useEffect(() => {
    const toolbar = editor?.view.dom.closest(".editor-shell")?.querySelector<HTMLElement>(".format-toolbar");
    if (!toolbar) return;
    const update = () => {
      toolbar.dataset.overflowLeft = String(toolbar.scrollLeft > 2);
      toolbar.dataset.overflowRight = String(toolbar.scrollWidth - toolbar.clientWidth - toolbar.scrollLeft > 2);
    };
    update(); const observer = new ResizeObserver(update); observer.observe(toolbar);
    toolbar.addEventListener("scroll", update, { passive: true });
    return () => { observer.disconnect(); toolbar.removeEventListener("scroll", update); };
  }, [editor, readOnly]);
  useEffect(() => {
    if (!editor) return;
    const map = ({ transaction }: { transaction: import("@tiptap/pm/state").Transaction }) => { if (uploadBookmark.current) uploadBookmark.current = uploadBookmark.current.map(transaction.mapping); };
    editor.on("transaction", map); return () => { editor.off("transaction", map); uploadBookmark.current = null; };
  }, [editor]);
  useEffect(() => {
    if (!editor) return;
    const click = (event: MouseEvent) => {
      const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[href]");
      if (!anchor || !editor.view.dom.contains(anchor)) return;
      const href = anchor.href;
      if (readOnly || event.metaKey || event.ctrlKey) {
        event.preventDefault();
        const opened = window.open(href, "_blank", "noopener,noreferrer");
        if (opened) opened.opener = null;
        return;
      }
      event.preventDefault();
      const textNode = anchor.firstChild ?? anchor;
      const position = editor.view.posAtDOM(textNode, 0);
      editor.chain().setTextSelection(position).extendMarkRange("link").run();
      setLinkActions({ from: editor.state.selection.from, to: editor.state.selection.to, href, anchor });
    };
    editor.view.dom.addEventListener("click", click);
    return () => editor.view.dom.removeEventListener("click", click);
  }, [editor, readOnly]);
  useEffect(() => { editor?.setEditable(!readOnly, false); if (readOnly) setTablePicker(null); }, [editor, readOnly]);
  useEffect(() => {
    if (!editor) return;
    const picker = (event: Event) => { const range = (event as CustomEvent<{ from: number; to: number }>).detail; setTablePicker({ anchor: editor.view.coordsAtPos(editor.state.selection.from), range }); };
    const keyboard = (event: KeyboardEvent) => {
      if (!editor.isEditable || event.isComposing || !(event.key === "F10" && event.shiftKey)) return;
      const image = editor.state.selection instanceof NodeSelection && editor.state.selection.node.type.name === "image";
      if (!image && !tableContext(editor)) return;
      event.preventDefault();
      editor.view.dom.dispatchEvent(new CustomEvent("uranus-table-menu", { detail: { kind: image ? "image" : "cell", anchor: editor.view.coordsAtPos(editor.state.selection.from) } }));
    };
    editor.view.dom.addEventListener("uranus-table-picker", picker); editor.view.dom.addEventListener("keydown", keyboard);
    return () => { editor.view.dom.removeEventListener("uranus-table-picker", picker); editor.view.dom.removeEventListener("keydown", keyboard); };
  }, [editor]);
  useEffect(() => () => { void onFlush(); }, []);
  useEffect(() => () => onUploadState?.(false), [onUploadState]);
  useEffect(() => {
    if (!editor) return;
    const refresh = () => {
      const query = findOpen ? find : "";
      const titleRanges = literalRanges(titleValue, query);
      const bodyCount = updateEditorSearch(editor, query, -1);
      const total = titleRanges.length + bodyCount;
      const active = total ? ((findIndex % total) + total) % total : 0;
      const titleActive = total > 0 && active < titleRanges.length;
      setFindCount(total); setFindTitleActive(titleActive);
      if (titleActive) {
        updateEditorSearch(editor, query, -1);
        const range = titleRanges[active]!;
        titleFieldRef.current?.setSelectionRange(range[0], range[1]);
        titleFieldRef.current?.scrollIntoView({ block: "nearest" });
      } else if (bodyCount) updateEditorSearch(editor, query, active - titleRanges.length);
    };
    refresh();
    const transaction = ({ transaction }: { transaction: { docChanged: boolean } }) => { if (transaction.docChanged) refresh(); };
    editor.on("transaction", transaction);
    return () => { editor.off("transaction", transaction); };
  }, [editor, find, findIndex, findOpen, titleValue]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.isComposing || !(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === "f") { event.preventDefault(); setFindOpen(true); }
      if (event.altKey && event.key.toLowerCase() === "p") { event.preventDefault(); toggleReadOnly(); }
      if (event.altKey && event.key.toLowerCase() === "t" && !readOnly && editor && !tableContext(editor)) { event.preventDefault(); setTablePicker({ anchor: editor.view.coordsAtPos(editor.state.selection.from) }); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
  if (!editor) return <div className="center-message">正在加载编辑器…</div>;
  // Resolve the innermost item so mixed task/regular lists use the right command.
  let indentItem: string | null = null;
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const name = $from.node(depth).type.name;
    if (name === "listItem" || name === "taskItem") { indentItem = name; break; }
  }
  const canIndent = !readOnly && !editor.isActive("codeBlock") && !(editor.state.selection instanceof CellSelection) && !!indentItem;
  const alignmentActive = (value: string) => {
    const selection = editor.state.selection;
    if (selection instanceof CellSelection) { let active = true; selection.forEachCell(node => { if ((node.attrs.textAlign ?? (node.type.name === "tableHeader" ? "center" : "left")) !== value) active = false; }); return active; }
    return editor.isActive("image") ? editor.getAttributes("image").imageAlign === value : editor.isActive({ textAlign: value });
  };
  const alignmentDisabled = (value: string) => readOnly || (!(editor.state.selection instanceof CellSelection) && !editor.isActive("image") && !editor.can().setTextAlign(value));
  const alignmentTarget = editor.state.selection instanceof CellSelection ? "所选单元格" : editor.isActive("image") ? "图片" : "段落或标题";
  const toggleReadOnly = () => {
    if (readOnlyBecauseDeleted) return;
    const next = !readOnly;
    writePreference(preferenceKey, next ? "1" : "0");
    setReadOnly(next);
  };
  const matches = findCount || searchHighlightKey.getState(editor.state)?.ranges.length || 0;
  const copyCode = async () => {
    const { $from } = editor.state.selection;
    for (let depth = $from.depth; depth > 0; depth--) if ($from.node(depth).type.name === "codeBlock") {
      try { await navigator.clipboard.writeText($from.node(depth).textContent); setEditorNotice("代码已复制"); }
      catch { setEditorError("复制代码失败，请检查剪贴板权限"); }
      return;
    }
  };
  const exportOriginal = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(note.content, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `uranus-note-${note.id}-original.json`; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const applyStructureRepair = () => {
    if (!structureIssue?.repair) return;
    const parts = splitNoteTitle(structureIssue.repair.content);
    titleNode.current = parts.title; setTitleValue(titleText(parts.title));
    editor.commands.setContent(parts.body); onChange(structureIssue.repair.content); setStructureIssue(null);
  };
  const openLinkDialog = (range: { from: number; to: number; href: string } | null = linkActions) => {
    if (range) {
      const name = editor.state.doc.textBetween(range.from, range.to);
      setLinkDialog({ from: range.from, to: range.to, name, href: range.href, error: "" }); setLinkActions(null); return;
    }
    let { from, to, $from, $to } = editor.state.selection;
    if (!$from.sameParent($to)) { setEditorError("链接只能应用到同一个文本块，请缩小选区。"); return; }
    const href = editor.getAttributes("link").href as string | undefined;
    if (href) { editor.chain().extendMarkRange("link").run(); ({ from, to } = editor.state.selection); }
    setLinkDialog({ from, to, name: editor.state.doc.textBetween(from, to), href: href ?? "https://", error: "" });
  };
  const saveLink = () => {
    if (!linkDialog) return;
    const href = linkDialog.href.trim();
    if (!safeHref(href)) { setLinkDialog({ ...linkDialog, error: "仅允许 http、https 或 mailto 链接" }); return; }
    const name = linkDialog.name || href;
    const existing = editor.state.doc.textBetween(linkDialog.from, linkDialog.to);
    if (name === existing && linkDialog.from !== linkDialog.to) editor.chain().focus().setTextSelection({ from: linkDialog.from, to: linkDialog.to }).setLink({ href }).run();
    else {
      const marks = editor.state.doc.resolve(linkDialog.from).marks().filter(mark => mark.type.name !== "link");
      const linkMark = editor.schema.marks.link!.create({ href, target: "_blank", rel: "noopener noreferrer" });
      const tr = editor.state.tr.replaceWith(linkDialog.from, linkDialog.to, editor.schema.text(name, [...marks, linkMark]));
      editor.view.dispatch(tr.scrollIntoView()); editor.view.focus();
    }
    setLinkDialog(null);
  };
  const removeLink = (range: { from: number; to: number } | null = linkDialog) => {
    if (!range) return;
    editor.chain().focus().setTextSelection({ from: range.from, to: range.to }).unsetLink().run();
    setLinkDialog(null); setLinkActions(null);
  };
  const uploadImage = async (file: File, retry = false) => {
    if (upload?.busy || readOnly) return;
    if (!retry) uploadBookmark.current = editor.state.selection.getBookmark();
    setUpload({ file, busy: true, error: "" });
    onUploadState?.(true);
    try {
      const attachment = await uploadAttachment(note.id, file);
      if (editor.isDestroyed) return;
      if (!editor.isEditable) { setUpload({ file, busy: false, error: "当前为阅读模式，请返回编辑后重试。" }); return; }
      const selection = uploadBookmark.current?.resolve(editor.state.doc) ?? editor.state.selection;
      const inserted = editor.chain().command(({ tr }) => { tr.setSelection(selection); return true; }).insertContent({ type: "image", attrs: { src: attachment.url, attachmentId: attachment.id, alt: attachment.fileName } }).run();
      if (!inserted) throw new Error("图片已上传但未插入，请检查正文预算后重试。");
      uploadBookmark.current = null; setUpload(null); onUploadState?.(false); editor.view.focus();
    } catch (error) { if (!editor.isDestroyed) { setUpload({ file, busy: false, error: (error as Error).message }); onUploadState?.(false); } }
  };
  pasteHandler.current = (event, slice) => {
    if (readOnly) return false;
    const html = event.clipboardData?.getData("text/html") ?? "";
    try {
      const table = externalTable(html);
      if (table) {
        event.preventDefault();
        if (tableContext(editor)) throw new Error("暂不支持在单元格中嵌套粘贴表格");
        if (!editor.chain().focus().insertContent(table).run()) throw new Error("表格未能插入，请检查正文大小限制");
        return true;
      }
    } catch (error) { event.preventDefault(); setEditorError((error as Error).message); return true; }

    const files = Array.from(event.clipboardData?.files ?? []).filter(file => file.type.startsWith("image/"));
    // File-only clipboard data produces an empty Fragment, whose JSON is null.
    const json = (slice.content.toJSON() ?? []) as ContentNode[];
    let hasExternal = false;
    const currentIds = new Set<string>();
    const collect = (node: ContentNode) => { if (node.type === "image" && typeof node.attrs?.attachmentId === "string") currentIds.add(node.attrs.attachmentId); node.content?.forEach(collect); };
    collect(editor.getJSON() as ContentNode);
    const transform = async (node: ContentNode): Promise<ContentNode | null> => {
      if (node.type === "image") {
        const id = typeof node.attrs?.attachmentId === "string" ? node.attrs.attachmentId : "";
        const src = typeof node.attrs?.src === "string" ? node.attrs.src : "";
        if (id && currentIds.has(id)) return node;
        if (id && src === `/api/attachments/${id}`) {
          const attachment = await copyAttachment(id, note.id);
          return { ...node, attrs: { ...node.attrs, src: attachment.url, attachmentId: attachment.id, alt: attachment.fileName } };
        }
        hasExternal = true; return null;
      }
      if (!node.content) return node;
      const children = (await Promise.all(node.content.map(transform))).filter((child): child is ContentNode => child !== null);
      if (!children.length && !["paragraph", "tableCell", "tableHeader"].includes(node.type ?? "")) return null;
      return { ...node, content: children };
    };
    if (!files.length && !json.some(node => { let found = false; const scan = (value: ContentNode) => { if (value.type === "image") found = true; value.content?.forEach(scan); }; scan(node); return found; })) return false;
    event.preventDefault();
    uploadBookmark.current = editor.state.selection.getBookmark();
    const run = () => { void (async () => {
      onUploadState?.(true);
      let failedFile: File | undefined;
      try {
        if (files.length) {
          const stripImages = (node: ContentNode): ContentNode | null => {
            if (node.type === "image") return null;
            if (!node.content) return node;
            const children = node.content.map(stripImages).filter((child): child is ContentNode => child !== null);
            if (!children.length && !["paragraph", "tableCell", "tableHeader"].includes(node.type ?? "")) return null;
            return { ...node, content: children };
          };
          const remainder = json.map(stripImages).filter((node): node is ContentNode => node !== null);
          if (remainder.length) {
            const rest = Slice.fromJSON(editor.schema, { content: remainder, openStart: Math.min(slice.openStart, 1), openEnd: Math.min(slice.openEnd, 1) });
            const selection = uploadBookmark.current?.resolve(editor.state.doc) ?? editor.state.selection;
            editor.view.dispatch(editor.state.tr.setSelection(selection).replaceSelection(rest).scrollIntoView());
            uploadBookmark.current = editor.state.selection.getBookmark();
          }
          for (const file of files) {
            failedFile = file;
            setUpload({ file, busy: true, error: "" });
            const attachment = await uploadAttachment(note.id, file);
            if (editor.isDestroyed || !editor.isEditable) throw new Error("笔记已切换或当前不可编辑，图片没有插入正文");
            const selection = uploadBookmark.current?.resolve(editor.state.doc) ?? editor.state.selection;
            editor.chain().command(({ tr }) => { tr.setSelection(selection); return true; }).insertContent({ type: "image", attrs: { src: attachment.url, attachmentId: attachment.id, alt: attachment.fileName } }).run();
            uploadBookmark.current = editor.state.selection.getBookmark();
            failedFile = undefined;
          }
          setUpload(null);
        } else {
          const transformed = (await Promise.all(json.map(transform))).filter((node): node is ContentNode => node !== null);
          if (transformed.length) {
            const next = Slice.fromJSON(editor.schema, { content: transformed, openStart: Math.min(slice.openStart, 1), openEnd: Math.min(slice.openEnd, 1) });
            const selection = uploadBookmark.current?.resolve(editor.state.doc) ?? editor.state.selection;
            editor.view.dispatch(editor.state.tr.setSelection(selection).replaceSelection(next).scrollIntoView());
          }
          if (hasExternal) setEditorError("外部图片地址不会被自动下载；请保存图片后使用上传或直接粘贴图片文件。");
        }
        uploadBookmark.current = null; retryPaste.current = null; setPasteError(""); onUploadState?.(false); editor.view.focus();
      } catch (error) {
        const message = (error as Error).message;
        if (!failedFile) { retryPaste.current = run; setPasteError(message); }
        onUploadState?.(false); setUpload(failedFile ? { file: failedFile, busy: false, error: message } : null); setEditorError(message);
      }
    })(); };
    run();
    return true;
  };
  const titleField = <textarea ref={titleFieldRef} className={`note-header-title${findTitleActive ? " find-title-current" : ""}`} aria-label="笔记标题" placeholder="添加标题" rows={1} value={titleValue} readOnly={readOnly} title={titleValue || "添加标题"}
      onChange={event => {
        const value = event.target.value;
        titleNode.current = updateTitle(titleNode.current, value);
        setTitleValue(value);
        onChange(joinNoteTitle(titleNode.current, editor.getJSON() as ContentNode));
      }}
      onBlur={() => { void onPersistLocal(); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); editor.commands.focus("start"); }
      }} />;
  return <div className={`editor-shell width-${widthMode} font-size-${editorFontSize} ${readOnly ? "readonly" : ""} ${showRowNumbers ? "show-table-row-numbers" : ""}`}>
    {titleHost ? createPortal(<>{titleField}{readOnly && <span className="readonly-indicator" role="status" title={readOnlyBecauseDeleted ? "最近删除中的笔记不可编辑" : "用于防止误触，不是安全权限"}>只读模式</span>}</>, titleHost) : <>{titleField}{readOnly && <span className="readonly-indicator" role="status">只读模式</span>}</>}
    <div className="format-toolbar" aria-label={readOnly ? "阅读工具栏" : "格式工具栏"} onFocusCapture={event => event.target.scrollIntoView({ block: "nearest", inline: "nearest" })}>
      <Tool label="撤销" disabled={readOnly} onClick={() => editor.chain().focus().undo().run()}><Undo2 /></Tool>
      <Tool label="重做" disabled={readOnly} onClick={() => editor.chain().focus().redo().run()}><Redo2 /></Tool>
      <span className="separator" />
      <Tool label="标题 1" disabled={readOnly} active={editor.isActive("heading", { level: 1 })} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}><Heading1 /></Tool>
      <Tool label="标题 2" disabled={readOnly} active={editor.isActive("heading", { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 /></Tool>
      <Tool label="加粗" disabled={readOnly} active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}><Bold /></Tool>
      <Tool label="斜体" disabled={readOnly} active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic /></Tool>
      <Tool label="下划线" disabled={readOnly} active={editor.isActive("underline")} onClick={() => editor.chain().focus().toggleUnderline().run()}><UnderlineIcon /></Tool>
      <Tool label="删除线" disabled={readOnly} active={editor.isActive("strike")} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough /></Tool>
      <Tool label="高亮" disabled={readOnly} active={editor.isActive("highlight")} onClick={() => editor.chain().focus().toggleHighlight().run()}><Highlighter /></Tool>
      <Tool label="行内代码" disabled={readOnly} active={editor.isActive("code")} onClick={() => editor.chain().focus().toggleCode().run()}><Code /></Tool>
      <Tool label="代码块" disabled={readOnly || !editor.can().toggleCodeBlock()} active={editor.isActive("codeBlock")} onClick={() => editor.chain().focus().toggleCodeBlock().run()}><Braces /></Tool>
      <Tool label="复制代码" hint="仅在代码块内可用" disabled={!editor.isActive("codeBlock")} onClick={() => void copyCode()}><Clipboard /></Tool>
      <Tool label="小号文本" {...(editor.isActive("heading") || editor.isActive("codeBlock") || editor.isActive("code") ? { hint: "标题和代码中不可用" } : {})} disabled={readOnly || editor.isActive("heading") || editor.isActive("codeBlock") || editor.isActive("code")} active={editor.isActive("small")} onClick={() => editor.chain().focus().toggleMark("small").run()}><CaseLower /></Tool>
      <span className="separator" />
      <Tool label="靠左对齐" hint={alignmentTarget} disabled={alignmentDisabled("left")} active={alignmentActive("left")} onClick={() => alignText(editor, "left")}><AlignLeft /></Tool>
      <Tool label="居中对齐" hint={alignmentTarget} disabled={alignmentDisabled("center")} active={alignmentActive("center")} onClick={() => alignText(editor, "center")}><AlignCenter /></Tool>
      <Tool label="靠右对齐" hint={alignmentTarget} disabled={alignmentDisabled("right")} active={alignmentActive("right")} onClick={() => alignText(editor, "right")}><AlignRight /></Tool>
      <span className="separator" />
      <Tool label="无序列表" disabled={readOnly} active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()}><List /></Tool>
      <Tool label="有序列表" disabled={readOnly} active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered /></Tool>
      <Tool label="待办" disabled={readOnly} active={editor.isActive("taskList")} onClick={() => editor.chain().focus().toggleTaskList().run()}><CheckSquare /></Tool>
      <Tool label="增加缩进" hint="将列表项缩进一级" disabled={!canIndent || !editor.can().sinkListItem(indentItem!)} onClick={() => { if (indentItem) editor.chain().focus().sinkListItem(indentItem).run(); }}><IndentIncrease /></Tool>
      <Tool label="减少缩进" hint="将列表项提升一级；最外层退出列表" disabled={!canIndent || !editor.can().liftListItem(indentItem!)} onClick={() => { if (indentItem) editor.chain().focus().liftListItem(indentItem).run(); }}><IndentDecrease /></Tool>
      <Tool label="引用" disabled={readOnly} active={editor.isActive("blockquote")} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote /></Tool>
      <Tool label="分隔线" disabled={readOnly} onClick={() => editor.chain().focus().setHorizontalRule().run()}><Minus /></Tool>
      <Tool label="链接" disabled={readOnly} active={editor.isActive("link")} onClick={() => openLinkDialog()}><Link2 /></Tool>
      <Tool label="表格" hint={tableContext(editor) ? "暂不支持嵌套表格" : "插入表格"} disabled={readOnly || !!tableContext(editor)} onClick={() => setTablePicker(v => v ? null : { anchor: editor.view.dom.closest(".editor-shell")!.querySelector<HTMLElement>('[aria-label="表格"]')! })}><Table2 /></Tool>
      <label className={`file-tool ${readOnly || upload?.busy ? "disabled" : ""}`} title="上传图片" aria-label="上传图片"><ImagePlus /><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={readOnly || upload?.busy} onChange={async (event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        await uploadImage(file);
      }} /></label>
      {readOnly && <Tool label="在笔记中查找" onClick={() => setFindOpen(true)}><Search /></Tool>}
      <span className="spacer" />
      <Tool label={widthMode === "fluid" ? "切换舒适阅读" : "切换自适应宽版"} active={widthMode === "reading"} onClick={() => setWidthMode(widthMode === "fluid" ? "reading" : "fluid")}><MoveHorizontal /></Tool>
      {!readOnlyBecauseDeleted && <Tool label={readOnly ? "退出只读" : "只读模式"} active={readOnly} onClick={toggleReadOnly}><Eye /></Tool>}
    </div>
    {editorError && <div className="error-banner" role="alert">{editorError}</div>}
    {editorNotice && <div className="editor-notice" role="status">{editorNotice}<button aria-label="关闭提示" onClick={() => setEditorNotice("")}>×</button></div>}
    {structureIssue && <div className="draft-banner structure-warning" role="alert"><span>检测到原始正文结构异常：{structureIssue.message}。服务器原文尚未改写。</span><button onClick={exportOriginal}>导出原始 JSON</button>{structureIssue.repair && <details><summary>预览修复</summary><pre>{JSON.stringify(structureIssue.repair.content, null, 2).slice(0, 10_000)}{JSON.stringify(structureIssue.repair.content).length > 10_000 ? "\n…预览已截断" : ""}</pre><button disabled={readOnly} onClick={applyStructureRepair}>补齐 {structureIssue.repair.added} 个空单元格并应用</button></details>}</div>}
    {upload && <div className="draft-banner" role="status"><span>{upload.busy ? "正在上传图片：" : "图片上传未完成："}{upload.file.name}{upload.error && " · " + upload.error}</span>{!upload.busy && <><button disabled={readOnly} onClick={() => void uploadImage(upload.file, true)}>重试上传</button><button onClick={() => { uploadBookmark.current = null; setUpload(null); }}>取消上传</button></>}</div>}
    {pasteError && <div className="draft-banner" role="alert"><span>图片粘贴未完成：{pasteError}</span><button disabled={readOnly} onClick={() => retryPaste.current?.()}>重试粘贴</button><button onClick={() => { retryPaste.current = null; uploadBookmark.current = null; setPasteError(""); }}>取消</button></div>}
    {tablePicker && !readOnly && <TablePicker editor={editor} anchor={tablePicker.anchor} range={tablePicker.range} close={() => setTablePicker(null)} />}
    <TableTools editor={editor} readOnly={readOnly} showRowNumbers={showRowNumbers} onShowRowNumbers={(value) => { setShowRowNumbers(value); writePreference("uranus.table.rowNumbers", value ? "1" : "0"); }} />
    {findOpen && <div className="find-bar"><input autoFocus placeholder="在笔记中查找" value={find} onChange={(event) => { setFind(event.target.value); setFindIndex(0); }} onKeyDown={(event) => { if (event.nativeEvent.isComposing) return; if (event.key === "Enter" && matches) { event.preventDefault(); setFindIndex((value) => event.shiftKey ? value - 1 : value + 1); } if (event.key === "Escape") { setFind(""); setFindOpen(false); editor.commands.focus(); } }} /><span>{findTitleActive ? "标题 · " : ""}{find ? matches ? `${(findIndex % matches + matches) % matches + 1}/${matches}` : "0/0" : "0/0"}</span><button aria-label="上一个匹配" disabled={!matches} onClick={() => setFindIndex(value => value - 1)}>↑</button><button aria-label="下一个匹配" disabled={!matches} onClick={() => setFindIndex(value => value + 1)}>↓</button><button onClick={() => { setFind(""); setFindOpen(false); editor.commands.focus(); }}>完成</button></div>}
    {linkActions && <Popup className="link-actions-popup" anchor={linkActions.anchor} title="链接操作" close={() => setLinkActions(null)} restoreFocus={() => editor.view.focus()}>
      <button onClick={() => { const opened = window.open(linkActions.href, "_blank", "noopener,noreferrer"); if (opened) opened.opener = null; }}><ExternalLink aria-hidden="true" /><span>打开链接</span></button>
      <button onClick={() => openLinkDialog(linkActions)}><Pencil aria-hidden="true" /><span>编辑链接</span></button>
      <button className="link-actions-remove" onClick={() => removeLink(linkActions)}><Unlink aria-hidden="true" /><span>移除链接</span></button>
    </Popup>}
    {linkDialog && <div className="link-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setLinkDialog(null); }}><form className="link-dialog" role="dialog" aria-modal="true" aria-labelledby="link-dialog-title" onSubmit={(event) => { event.preventDefault(); saveLink(); }} onKeyDown={(event) => { if (event.nativeEvent.isComposing) return; if (event.key === "Escape") { event.preventDefault(); setLinkDialog(null); editor.view.focus(); } }}><h2 id="link-dialog-title">{linkDialog.from === linkDialog.to ? "插入链接" : "编辑链接"}</h2><label>显示名称<input autoFocus value={linkDialog.name} onChange={event => setLinkDialog({ ...linkDialog, name: event.target.value })} /></label><label>链接地址<input value={linkDialog.href} aria-invalid={Boolean(linkDialog.error)} onChange={event => setLinkDialog({ ...linkDialog, href: event.target.value, error: "" })} /></label>{linkDialog.error && <p role="alert">{linkDialog.error}</p>}<div><button type="button" onClick={() => { setLinkDialog(null); editor.view.focus(); }}>取消</button>{linkDialog.from !== linkDialog.to && <button type="button" onClick={() => removeLink()}>移除链接</button>}<button className="primary" type="submit">{linkDialog.from === linkDialog.to ? "插入" : "保存"}</button></div></form></div>}
    <EditorContent className="editor-content" editor={editor} onClick={(event) => {
      if (event.target === event.currentTarget && !readOnly) editor.commands.focus("end");
    }} />
  </div>;
}

function Tool({ label, hint, active, disabled, onClick, children }: { label: string; hint?: string; active?: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" title={hint ? label + " · " + hint : label} aria-label={label} aria-description={hint} aria-pressed={active} className={active ? "active" : ""} disabled={disabled} onMouseDown={(event) => { event.preventDefault(); }} onClick={onClick}>{children}</button>;
}
