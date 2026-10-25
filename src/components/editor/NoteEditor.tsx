import Highlight from "@tiptap/extension-highlight";
import TextAlign from "@tiptap/extension-text-align";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import { tableExtensions, tableContext } from "./tables";
import { CellSelection } from "@tiptap/pm/tables";
import { NodeSelection } from "@tiptap/pm/state";
import type { SelectionBookmark } from "@tiptap/pm/state";
import { pointAnchor, type PopupAnchor } from "../Popup";
import { TablePicker, TableTools } from "./TableTools";
import { readPreference, writePreference, useUiStore } from "../../state/ui";
import Underline from "@tiptap/extension-underline";
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type NodeViewProps } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { AlignLeft, AlignCenter, AlignRight, Bold, CheckSquare, Code, Eye, Heading1, Heading2, Highlighter, ImagePlus, Italic, Link2, List, ListOrdered, Minus, MoveHorizontal, Quote, Redo2, Strikethrough, Table2, Underline as UnderlineIcon, Undo2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ContentNode, NoteDetail } from "../../../shared/dto";
import { uploadAttachment } from "../../api/client";
import { SearchHighlight, searchHighlightKey, updateEditorSearch } from "./searchHighlight";
import type { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { createPortal } from "react-dom";
import { joinNoteTitle, splitNoteTitle, titleText, updateTitle } from "./noteTitle";

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
    <img src={String(node.attrs.src)} alt={String(node.attrs.alt ?? "")} style={width ? { width } : undefined} onClick={() => {
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

const slashCommands = [
  { key: "table", label: "表格", run: (editor: Editor) => editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run() },
  { key: "todo", label: "待办列表", run: (editor: Editor) => editor.chain().focus().toggleTaskList().run() },
  { key: "code", label: "代码块", run: (editor: Editor) => editor.chain().focus().toggleCodeBlock().run() },
  { key: "hr", label: "分隔线", run: (editor: Editor) => editor.chain().focus().setHorizontalRule().run() },
  { key: "h1", label: "一级标题", run: (editor: Editor) => editor.chain().focus().setHeading({ level: 1 }).run() },
  { key: "h2", label: "二级标题", run: (editor: Editor) => editor.chain().focus().setHeading({ level: 2 }).run() },
  { key: "h3", label: "三级标题", run: (editor: Editor) => editor.chain().focus().setHeading({ level: 3 }).run() },
  { key: "quote", label: "引用", run: (editor: Editor) => editor.chain().focus().toggleBlockquote().run() },
];

function executeSlash(editor: Editor, query: string, command: (typeof slashCommands)[number]) {
  const to = editor.state.selection.from;
  if (command.key === "table") {
    if (!tableContext(editor)) editor.view.dom.dispatchEvent(new CustomEvent("uranus-table-picker", { detail: { from: Math.max(0, to - query.length - 1), to } }));
    return;
  }
  editor.chain().focus().deleteRange({ from: Math.max(0, to - query.length - 1), to }).run();
  command.run(editor);
}

export function NoteEditor({ note, onChange, onFlush, readOnlyBecauseDeleted, titleHost }: { note: NoteDetail; onChange: (content: ContentNode) => void; onFlush: () => Promise<void>; readOnlyBecauseDeleted: boolean; titleHost?: HTMLElement | null }) {
  const [initialParts] = useState(() => splitNoteTitle(note.content));
  const titleNode = useRef(initialParts.title);
  const [titleValue, setTitleValue] = useState(() => titleText(initialParts.title));
  const preferenceKey = `uranus.readOnly.${note.id}`;
  const [readOnlyPreference, setReadOnly] = useState(readPreference(preferenceKey) === "1");
  const readOnly = readOnlyBecauseDeleted || readOnlyPreference;
  const { widthMode, setWidthMode, editorFontSize } = useUiStore();
  const [tablePicker, setTablePicker] = useState<{ anchor: PopupAnchor; range?: { from: number; to: number } } | null>(null);
  const [editorError, setEditorError] = useState("");
  const [upload, setUpload] = useState<{ file: File; busy: boolean; error: string } | null>(null);
  const uploadBookmark = useRef<SelectionBookmark | null>(null);
  useEffect(() => { const handler = (event: Event) => setEditorError((event as CustomEvent<string>).detail); window.addEventListener("uranus-editor-error", handler); return () => window.removeEventListener("uranus-editor-error", handler); }, []);
  const [findOpen, setFindOpen] = useState(false);
  const [find, setFind] = useState("");
  const [findIndex, setFindIndex] = useState(0);
  const [findCount, setFindCount] = useState(0);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const slashState = useRef<{ query: string | null; index: number }>({ query: null, index: 0 });
  const editorRef = useRef<Editor | null>(null);
  const extensions = useMemo(() => [
    StarterKit.configure({ link: false, underline: false }), Underline, Highlight,
    TextAlign.extend({ addKeyboardShortcuts() { return {
      "Mod-Shift-l": () => alignText(this.editor, "left"),
      "Mod-Shift-e": () => alignText(this.editor, "center"),
      "Mod-Shift-r": () => alignText(this.editor, "right"),
    }; } }).configure({ types: ["heading", "paragraph"], alignments: ["left", "center", "right"], defaultAlignment: null }),
    Link.configure({ openOnClick: false, autolink: true, defaultProtocol: "https", protocols: ["http", "https", "mailto"] }),
    ...tableExtensions, AttachmentImage.configure({ inline: false, allowBase64: false }), SearchHighlight,
  ], []);
  const editor = useEditor({
    extensions, content: initialParts.body, editable: !readOnly, immediatelyRender: false,
    editorProps: { attributes: { class: "prose-editor", "aria-label": "笔记正文" }, handleKeyDown: (_view, event) => {
      if (event.isComposing) return false;
      const current = slashState.current; const instance = editorRef.current;
      if (current.query === null || !instance) return false;
      const filtered = slashCommands.filter((command) => `${command.key} ${command.label}`.toLocaleLowerCase().includes(current.query!.toLocaleLowerCase()));
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault(); current.index += event.key === "ArrowDown" ? 1 : -1; setSlashIndex(current.index); return true;
      }
      if (event.key === "Enter" && filtered.length) {
        event.preventDefault(); executeSlash(instance, current.query, filtered[(current.index % filtered.length + filtered.length) % filtered.length]!);
        current.query = null; setSlashQuery(null); return true;
      }
      if (event.key === "Escape") { event.preventDefault(); current.query = null; setSlashQuery(null); return true; }
      return false;
    } },
    onUpdate: ({ editor: instance }) => {
      setEditorError("");
      onChange(joinNoteTitle(titleNode.current, instance.getJSON() as ContentNode));
      const { $from } = instance.state.selection;
      const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
      const match = /^\/([^\s/]*)$/.exec(before);
      slashState.current = { query: match?.[1] ?? null, index: 0 };
      setSlashQuery(match?.[1] ?? null); setSlashIndex(0);
    },
    onBlur: () => { void onFlush(); },
  });
  editorRef.current = editor;
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
  useEffect(() => { if (editor) setFindCount(updateEditorSearch(editor, findOpen ? find : "", findIndex)); }, [editor, find, findIndex, findOpen]);
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
  const alignmentActive = (value: string) => {
    const selection = editor.state.selection;
    if (selection instanceof CellSelection) { let active = true; selection.forEachCell(node => { if ((node.attrs.textAlign ?? (node.type.name === "tableHeader" ? "center" : "left")) !== value) active = false; }); return active; }
    return editor.isActive("image") ? editor.getAttributes("image").imageAlign === value : editor.isActive({ textAlign: value });
  };
  const alignmentDisabled = (value: string) => readOnly || (!(editor.state.selection instanceof CellSelection) && !editor.isActive("image") && !editor.can().setTextAlign(value));
  const alignmentTarget = editor.state.selection instanceof CellSelection ? "所选单元格" : editor.isActive("image") ? "图片" : "段落或标题";
  const filteredSlashCommands = slashCommands.filter((command) => slashQuery !== null && `${command.key} ${command.label}`.toLocaleLowerCase().includes(slashQuery.toLocaleLowerCase()));
  const activeSlashIndex = filteredSlashCommands.length ? (slashIndex % filteredSlashCommands.length + filteredSlashCommands.length) % filteredSlashCommands.length : 0;
  const toggleReadOnly = () => {
    if (readOnlyBecauseDeleted) return;
    const next = !readOnly;
    writePreference(preferenceKey, next ? "1" : "0");
    setReadOnly(next);
  };
  const matches = findCount || searchHighlightKey.getState(editor.state)?.ranges.length || 0;
  const link = () => {
    const previous = editor.getAttributes("link").href as string | undefined;
    const href = prompt("链接（http、https 或 mailto）", previous ?? "https://");
    if (href === null) return;
    if (!/^(https?:|mailto:)/i.test(href)) return alert("仅允许 http、https 或 mailto 链接");
    editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
  };
  const uploadImage = async (file: File, retry = false) => {
    if (upload?.busy || readOnly) return;
    if (!retry) uploadBookmark.current = editor.state.selection.getBookmark();
    setUpload({ file, busy: true, error: "" });
    try {
      const attachment = await uploadAttachment(note.id, file);
      if (editor.isDestroyed) return;
      if (!editor.isEditable) { setUpload({ file, busy: false, error: "当前为阅读模式，请返回编辑后重试。" }); return; }
      const selection = uploadBookmark.current?.resolve(editor.state.doc) ?? editor.state.selection;
      const inserted = editor.chain().command(({ tr }) => { tr.setSelection(selection); return true; }).insertContent({ type: "image", attrs: { src: attachment.url, attachmentId: attachment.id, alt: attachment.fileName } }).run();
      if (!inserted) throw new Error("图片已上传但未插入，请检查正文预算后重试。");
      uploadBookmark.current = null; setUpload(null); editor.view.focus();
    } catch (error) { if (!editor.isDestroyed) setUpload({ file, busy: false, error: (error as Error).message }); }
  };
  const titleField = <textarea className="note-header-title" aria-label="笔记标题" placeholder="添加标题" rows={1} value={titleValue} readOnly={readOnly} title={titleValue || "添加标题"}
      onChange={event => {
        const value = event.target.value;
        titleNode.current = updateTitle(titleNode.current, value);
        setTitleValue(value);
        onChange(joinNoteTitle(titleNode.current, editor.getJSON() as ContentNode));
      }}
      onBlur={() => { void onFlush(); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); editor.commands.focus("start"); }
      }} />;
  return <div className={`editor-shell width-${widthMode} font-size-${editorFontSize} ${readOnly ? "readonly" : ""}`}>
    {titleHost ? createPortal(titleField, titleHost) : titleField}
    <div className="format-toolbar" aria-label={readOnly ? "阅读工具栏" : "格式工具栏"} onFocusCapture={event => event.target.scrollIntoView({ block: "nearest", inline: "nearest" })}>
      {!readOnly && <>
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
      <span className="separator" />
      <Tool label="靠左对齐" hint={alignmentTarget} disabled={alignmentDisabled("left")} active={alignmentActive("left")} onClick={() => alignText(editor, "left")}><AlignLeft /></Tool>
      <Tool label="居中对齐" hint={alignmentTarget} disabled={alignmentDisabled("center")} active={alignmentActive("center")} onClick={() => alignText(editor, "center")}><AlignCenter /></Tool>
      <Tool label="靠右对齐" hint={alignmentTarget} disabled={alignmentDisabled("right")} active={alignmentActive("right")} onClick={() => alignText(editor, "right")}><AlignRight /></Tool>
      <span className="separator" />
      <Tool label="无序列表" disabled={readOnly} active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()}><List /></Tool>
      <Tool label="有序列表" disabled={readOnly} active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered /></Tool>
      <Tool label="待办" disabled={readOnly} active={editor.isActive("taskList")} onClick={() => editor.chain().focus().toggleTaskList().run()}><CheckSquare /></Tool>
      <Tool label="引用" disabled={readOnly} active={editor.isActive("blockquote")} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote /></Tool>
      <Tool label="分隔线" disabled={readOnly} onClick={() => editor.chain().focus().setHorizontalRule().run()}><Minus /></Tool>
      <Tool label="链接" disabled={readOnly} active={editor.isActive("link")} onClick={link}><Link2 /></Tool>
      <Tool label="表格" hint={tableContext(editor) ? "暂不支持嵌套表格" : "插入表格"} disabled={readOnly || !!tableContext(editor)} onClick={() => setTablePicker(v => v ? null : { anchor: editor.view.dom.closest(".editor-shell")!.querySelector<HTMLElement>('[aria-label="表格"]')! })}><Table2 /></Tool>
      <label className={`file-tool ${readOnly || upload?.busy ? "disabled" : ""}`} title="上传图片" aria-label="上传图片"><ImagePlus /><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={readOnly || upload?.busy} onChange={async (event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        await uploadImage(file);
      }} /></label>
      </>}
      {readOnly && <button onClick={() => setFindOpen(true)}>在笔记中查找</button>}
      <span className="spacer" />
      <Tool label={widthMode === "fluid" ? "切换舒适阅读" : "切换自适应宽版"} active={widthMode === "reading"} onClick={() => setWidthMode(widthMode === "fluid" ? "reading" : "fluid")}><MoveHorizontal /></Tool>
      {!readOnlyBecauseDeleted && <Tool label={readOnly ? "退出只读" : "只读模式"} active={readOnly} onClick={toggleReadOnly}><Eye /></Tool>}
    </div>
    {editorError && <div className="error-banner" role="alert">{editorError}</div>}
    {upload && <div className="draft-banner" role="status"><span>{upload.busy ? "正在上传图片：" : "图片上传未完成："}{upload.file.name}{upload.error && " · " + upload.error}</span>{!upload.busy && <><button disabled={readOnly} onClick={() => void uploadImage(upload.file, true)}>重试上传</button><button onClick={() => { uploadBookmark.current = null; setUpload(null); }}>取消上传</button></>}</div>}
    {tablePicker && !readOnly && <TablePicker editor={editor} anchor={tablePicker.anchor} range={tablePicker.range} close={() => setTablePicker(null)} />}
    <TableTools editor={editor} readOnly={readOnly} />
    {readOnly && <div className="readonly-banner">只读模式{readOnlyBecauseDeleted ? " · 最近删除中的笔记不可编辑" : " · 用于防止误触，不是安全权限"}</div>}
    {findOpen && <div className="find-bar"><input autoFocus placeholder="在笔记中查找" value={find} onChange={(event) => { setFind(event.target.value); setFindIndex(0); }} onKeyDown={(event) => { if (event.key === "Enter" && matches) { event.preventDefault(); setFindIndex((value) => event.shiftKey ? value - 1 : value + 1); } if (event.key === "Escape") { setFind(""); setFindOpen(false); } }} /><span>{find && matches ? `${(findIndex % matches + matches) % matches + 1}/${matches}` : "无匹配"}</span><button onClick={() => { setFind(""); setFindOpen(false); }}>完成</button></div>}
    <EditorContent className="editor-content" editor={editor} onClick={(event) => {
      if (event.target === event.currentTarget && !readOnly) editor.commands.focus("end");
    }} />
    {slashQuery !== null && !readOnly && <div className="slash-menu" role="listbox" aria-label="斜杠命令">{filteredSlashCommands.map((command, index) => <button key={command.key} className={index === activeSlashIndex ? "active" : ""} onMouseDown={(event) => { event.preventDefault(); executeSlash(editor, slashQuery, command); slashState.current.query = null; setSlashQuery(null); }}><strong>/{command.key}</strong><span>{command.label}</span></button>)}</div>}
  </div>;
}

function Tool({ label, hint, active, disabled, onClick, children }: { label: string; hint?: string; active?: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" title={hint ? label + " · " + hint : label} aria-label={label} aria-description={hint} aria-pressed={active} className={active ? "active" : ""} disabled={disabled} onMouseDown={(event) => { event.preventDefault(); }} onClick={onClick}>{children}</button>;
}
