import Highlight from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import { tableExtensions } from "./tables";
import { TablePicker, TableTools } from "./TableTools";
import { readPreference, writePreference, useUiStore } from "../../state/ui";
import Underline from "@tiptap/extension-underline";
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type NodeViewProps } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Bold, CheckSquare, Code, Eye, Heading1, Heading2, Highlighter, ImagePlus, Italic, Link2, List, ListOrdered, Minus, MoveHorizontal, Quote, Redo2, Strikethrough, Table2, Underline as UnderlineIcon, Undo2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ContentNode, NoteDetail } from "../../../shared/dto";
import { uploadAttachment } from "../../api/client";
import { SearchHighlight, searchHighlightKey, updateEditorSearch } from "./searchHighlight";
import type { Editor } from "@tiptap/core";

function ResizableImageNode({ node, updateAttributes, editor }: NodeViewProps) {
  const initial = typeof node.attrs.width === "number" ? node.attrs.width : undefined;
  const [width, setWidth] = useState<number | undefined>(initial);
  const drag = useRef<{ startX: number; startWidth: number; latest: number } | undefined>(undefined);
  const cleanup = useRef<() => void>(() => undefined);
  useEffect(() => () => { const current = drag.current; if (current) updateAttributes({ width: Math.round(current.latest) }); cleanup.current(); }, []);
  return <NodeViewWrapper as="figure" className="resizable-image" draggable data-drag-handle>
    <img src={String(node.attrs.src)} alt={String(node.attrs.alt ?? "")} style={width ? { width } : undefined} />
    {editor.isEditable && <button className="image-resize-handle" aria-label="调整图片宽度" onPointerDown={(event) => {
      event.preventDefault(); event.stopPropagation();
      const image = event.currentTarget.previousElementSibling as HTMLImageElement;
      const startWidth = image.getBoundingClientRect().width;
      drag.current = { startX: event.clientX, startWidth, latest: startWidth };
      const move = (moveEvent: PointerEvent) => {
        const current = drag.current; if (!current) return;
        const next = Math.min(900, Math.max(120, current.startWidth + moveEvent.clientX - current.startX));
        current.latest = next; setWidth(next);
      };
      const stop = () => {
        const current = drag.current; if (current) updateAttributes({ width: Math.round(current.latest) });
        drag.current = undefined; cleanup.current();
      };
      cleanup.current = () => {
        window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop); window.removeEventListener("blur", stop);
      };
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop); window.addEventListener("pointercancel", stop); window.addEventListener("blur", stop);
    }} />}
  </NodeViewWrapper>;
}

const AttachmentImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      attachmentId: { default: null, parseHTML: (element) => element.getAttribute("data-attachment-id"), renderHTML: (attrs) => ({ "data-attachment-id": attrs.attachmentId }) },
      width: { default: null, parseHTML: (element) => element.getAttribute("width"), renderHTML: (attrs) => attrs.width ? { width: attrs.width } : {} },
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
  editor.chain().focus().deleteRange({ from: Math.max(0, to - query.length - 1), to }).run();
  command.run(editor);
}

export function NoteEditor({ note, onChange, onFlush, readOnlyBecauseDeleted }: { note: NoteDetail; onChange: (content: ContentNode) => void; onFlush: () => Promise<void>; readOnlyBecauseDeleted: boolean }) {
  const preferenceKey = `uranus.readOnly.${note.id}`;
  const [readOnlyPreference, setReadOnly] = useState(readPreference(preferenceKey) === "1");
  const readOnly = readOnlyBecauseDeleted || readOnlyPreference;
  const { widthMode, setWidthMode } = useUiStore();
  const [tablePicker, setTablePicker] = useState(false);
  const [editorError, setEditorError] = useState("");
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
    Link.configure({ openOnClick: false, autolink: true, defaultProtocol: "https", protocols: ["http", "https", "mailto"] }),
    ...tableExtensions, AttachmentImage.configure({ inline: false, allowBase64: false }), SearchHighlight,
  ], []);
  const editor = useEditor({
    extensions, content: note.content, editable: !readOnly, immediatelyRender: false,
    editorProps: { attributes: { class: "prose-editor", "aria-label": "笔记正文" }, handleKeyDown: (_view, event) => {
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
      onChange(instance.getJSON() as ContentNode);
      const { $from } = instance.state.selection;
      const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
      const match = /^\/([^\s/]*)$/.exec(before);
      slashState.current = { query: match?.[1] ?? null, index: 0 };
      setSlashQuery(match?.[1] ?? null); setSlashIndex(0);
    },
    onBlur: () => { void onFlush(); },
  });
  editorRef.current = editor;
  useEffect(() => { editor?.setEditable(!readOnly, false); }, [editor, readOnly]);
  useEffect(() => () => { void onFlush(); }, []);
  useEffect(() => { if (editor) setFindCount(updateEditorSearch(editor, findOpen ? find : "", findIndex)); }, [editor, find, findIndex, findOpen]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === "f") { event.preventDefault(); setFindOpen(true); }
      if (event.altKey && event.key.toLowerCase() === "p") { event.preventDefault(); toggleReadOnly(); }
      if (event.altKey && event.key.toLowerCase() === "t" && !readOnly) { event.preventDefault(); editor?.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
  if (!editor) return <div className="center-message">正在加载编辑器…</div>;
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
  return <div className={`editor-shell width-${widthMode} ${readOnly ? "readonly" : ""}`}>
    <div className="format-toolbar" aria-label="格式工具栏">
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
      <Tool label="无序列表" disabled={readOnly} active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()}><List /></Tool>
      <Tool label="有序列表" disabled={readOnly} active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered /></Tool>
      <Tool label="待办" disabled={readOnly} active={editor.isActive("taskList")} onClick={() => editor.chain().focus().toggleTaskList().run()}><CheckSquare /></Tool>
      <Tool label="引用" disabled={readOnly} active={editor.isActive("blockquote")} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote /></Tool>
      <Tool label="分隔线" disabled={readOnly} onClick={() => editor.chain().focus().setHorizontalRule().run()}><Minus /></Tool>
      <Tool label="链接" disabled={readOnly} active={editor.isActive("link")} onClick={link}><Link2 /></Tool>
      <Tool label="表格" disabled={readOnly} onClick={() => setTablePicker(v => !v)}><Table2 /></Tool>
      <label className={`file-tool ${readOnly ? "disabled" : ""}`} title="上传图片" aria-label="上传图片"><ImagePlus /><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={readOnly} onChange={async (event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        try {
          const attachment = await uploadAttachment(note.id, file);
          editor.chain().focus().insertContent({ type: "image", attrs: { src: attachment.url, attachmentId: attachment.id, alt: attachment.fileName } }).run();
        } catch (error) { alert((error as Error).message); }
      }} /></label>
      <span className="spacer" />
      <Tool label={widthMode === "fluid" ? "切换舒适阅读" : "切换自适应宽版"} active={widthMode === "reading"} onClick={() => setWidthMode(widthMode === "fluid" ? "reading" : "fluid")}><MoveHorizontal /></Tool>
      <Tool label={readOnly ? "退出只读" : "只读模式"} active={readOnly} disabled={readOnlyBecauseDeleted} onClick={toggleReadOnly}><Eye /></Tool>
    </div>
    {editorError && <div className="error-banner" role="alert">{editorError}</div>}
    {tablePicker && !readOnly && <TablePicker editor={editor} close={() => { setTablePicker(false); editor.commands.focus(); }} />}
    <TableTools editor={editor} readOnly={readOnly} />
    {readOnly && <div className="readonly-banner">只读模式{readOnlyBecauseDeleted ? " · 最近删除中的笔记不可编辑" : " · 用于防止误触，不是安全权限"}</div>}
    {findOpen && <div className="find-bar"><input autoFocus placeholder="在笔记中查找" value={find} onChange={(event) => { setFind(event.target.value); setFindIndex(0); }} onKeyDown={(event) => { if (event.key === "Enter" && matches) { event.preventDefault(); setFindIndex((value) => event.shiftKey ? value - 1 : value + 1); } if (event.key === "Escape") { setFind(""); setFindOpen(false); } }} /><span>{find && matches ? `${(findIndex % matches + matches) % matches + 1}/${matches}` : "无匹配"}</span><button onClick={() => { setFind(""); setFindOpen(false); }}>完成</button></div>}
    <EditorContent className="editor-content" editor={editor} onClick={(event) => {
      if (event.target === event.currentTarget && !readOnly) editor.commands.focus("end");
    }} />
    {slashQuery !== null && !readOnly && <div className="slash-menu" role="listbox" aria-label="斜杠命令">{filteredSlashCommands.map((command, index) => <button key={command.key} className={index === activeSlashIndex ? "active" : ""} onMouseDown={(event) => { event.preventDefault(); executeSlash(editor, slashQuery, command); slashState.current.query = null; setSlashQuery(null); }}><strong>/{command.key}</strong><span>{command.label}</span></button>)}</div>}
  </div>;
}

function Tool({ label, active, disabled, onClick, children }: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" title={label} aria-label={label} aria-pressed={active} className={active ? "active" : ""} disabled={disabled} onMouseDown={(event) => { event.preventDefault(); onClick(); }} onClick={event => { if (event.detail === 0) onClick(); }}>{children}</button>;
}
