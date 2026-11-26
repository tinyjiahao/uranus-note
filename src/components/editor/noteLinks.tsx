import { Search, FileText, CornerDownLeft, ArrowUpRight, Copy, Scissors, Trash2 } from "lucide-react";
import { t, useLocale } from "../../state/locale";
import { Node, type Editor } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, useEditorState, type NodeViewProps } from "@tiptap/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { useEffect, useState, useRef, type MouseEvent } from "react";
import { noteLinkAttributes } from "../../../shared/noteLink";
import { normalizeSearch } from "../../../shared/content";
import { filterTitles, loadTitleIndex, resolveLinkTitles, titleIndexKey, TITLE_STALE_TIME, type NoteTitle, type TitleIndex } from "../../state/noteTitles";
import { listNotes } from "../../api/client";
import { identity } from "../../state/identity";
import { Popup, pointAnchor, type PopupAnchor } from "../Popup";

// Every node view observes the same immutable document; scan it only once.
const documentLinks = new WeakMap<Editor["state"]["doc"], string>();
function linkIds(editor: Editor) {
  const doc = editor.state.doc, cached = documentLinks.get(doc);
  if (cached !== undefined) return cached;
  const found = new Set<number>();
  doc.descendants(node => { if (node.type.name === "noteLink") found.add(Number(node.attrs.noteId)); });
  const ids = [...found].sort((a, b) => a - b).join(",");
  documentLinks.set(doc, ids); return ids;
}
function NoteLinkView({ node, editor, getPos, selected }: NodeViewProps) {
  useLocale();
  const navigate = useNavigate(), id = Number(node.attrs.noteId);
  const client = useQueryClient();
  const [menu, setMenu] = useState<PopupAnchor | null>(null);
  const [clipboardError, setClipboardError] = useState("");
  const ids = useEditorState({ editor, selector: ({ editor }) => linkIds(editor) });
  const target = useQuery({ queryKey: ["user", identity().userId, "notes", "link-titles", ids], queryFn: ({ signal }) => {
    const cached = client.getQueryState<TitleIndex>(titleIndexKey(identity().userId));
    const index = cached && !cached.isInvalidated && Date.now() - cached.dataUpdatedAt < TITLE_STALE_TIME ? cached.data : undefined;
    return resolveLinkTitles(ids.split(",").filter(Boolean).map(Number), signal, index);
  }, retry: false, staleTime: 0, refetchOnWindowFocus: false });
  const title = target.data?.find(item => item.id === id)?.title;
  const missing = target.isError || (target.isSuccess && title === undefined);
  const select = () => {
    if (editor.view.composing) return;
    const position = getPos();
    if (typeof position === "number") editor.chain().focus().setNodeSelection(position).run();
  };
  const open = () => { if (!missing && !editor.view.composing) navigate(`/notes/${id}`); };
  const clipboard = (action: "copy" | "cut") => {
    if (editor.view.composing || (action === "cut" && !editor.isEditable)) return;
    const position = getPos();
    if (typeof position !== "number") return;
    select();
    // Dispatch the browser clipboard event to ProseMirror, preserving its rich
    // slice serialization and normal cut transaction/save/undo behavior.
    try {
      if (!document.execCommand(action)) throw new Error("Clipboard unavailable");
      setMenu(null);
    } catch { setClipboardError(t("剪贴板操作失败，请使用键盘快捷键重试")); }
  };
  return <NodeViewWrapper as="span" contentEditable={false} data-drag-handle="" className={`note-link${selected ? " ProseMirror-selectednode" : ""}${missing ? " note-link-missing" : ""}`} onContextMenu={(event: MouseEvent<HTMLSpanElement>) => {
    event.preventDefault(); event.stopPropagation();
    if (editor.view.composing) return;
    select(); setClipboardError(""); setMenu(pointAnchor(event.currentTarget, event.clientX, event.clientY));
  }}>
    <a data-note-link href={`/notes/${id}`} title={missing ? t("目标笔记不可用") : editor.isEditable ? t("单击显示笔记链接操作") : t("打开笔记")} aria-disabled={missing} onClick={event => {
      event.preventDefault();
      if (event.detail === 0 || !editor.isEditable || event.metaKey || event.ctrlKey) open();
      else {
        if (editor.view.composing) return;
        select(); setClipboardError(""); setMenu(event.currentTarget);
      }
    }} onDoubleClick={event => { event.preventDefault(); open(); }}>{title !== undefined && !missing ? title || t("未命名笔记") : String(node.attrs.title || t("未命名笔记"))}{missing && t("（不可用）")}</a>
    {menu && <Popup autoFocus={false} className="link-actions-popup note-link-actions" title={t("笔记链接")} anchor={menu} close={() => setMenu(null)} restoreFocus={() => editor.view.focus()}>
      <button disabled={missing} onClick={() => { setMenu(null); open(); }}><ArrowUpRight aria-hidden="true" /><span>{t("打开笔记")}</span></button>
      <button onClick={() => clipboard("copy")}><Copy aria-hidden="true" /><span>{t("复制")}</span></button>
      {editor.isEditable && <button onClick={() => clipboard("cut")}><Scissors aria-hidden="true" /><span>{t("剪切")}</span></button>}
      {editor.isEditable && <button className="link-actions-remove" onClick={() => { if (editor.view.composing || typeof getPos() !== "number") return; select(); editor.commands.deleteSelection(); setMenu(null); }}><Trash2 aria-hidden="true" /><span>{t("删除")}</span></button>}
      {clipboardError && <p role="alert">{clipboardError}</p>}
    </Popup>}
  </NodeViewWrapper>;
}
export const NoteLinkNode = Node.create({
  name: "noteLink", group: "inline", inline: true, atom: true, draggable: true, marks: "",
  addAttributes: () => ({ noteId: { default: 0 }, title: { default: "" } }),
  parseHTML: () => [{ tag: 'span[data-note-link="1"]', getAttrs: element => {
    const parsed = noteLinkAttributes.safeParse({ noteId: Number(element.getAttribute("data-id")), title: element.getAttribute("data-title") });
    return parsed.success ? parsed.data : false;
  } }],
  renderHTML: ({ node }) => ["span", { "data-note-link": "1", "data-id": node.attrs.noteId, "data-title": node.attrs.title }, node.attrs.title || t("未命名笔记")],
  renderText: ({ node }) => String(node.attrs.title || t("未命名笔记")),
  addNodeView: () => ReactNodeViewRenderer(NoteLinkView),
});
export function NoteLinkPopup({ editor, noteId, anchor, close }: { editor: Editor; noteId: number; anchor: PopupAnchor; close: () => void }) {
  useLocale();
  const [query, setQuery] = useState(""), [items, setItems] = useState<NoteTitle[]>([]), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const candidates = useRef<HTMLDivElement>(null);
  const index = useQuery({ queryKey: titleIndexKey(identity().userId), queryFn: ({ signal }) => loadTitleIndex(signal), staleTime: TITLE_STALE_TIME, gcTime: TITLE_STALE_TIME, retry: false, refetchOnWindowFocus: false });
  useEffect(() => {
    if (!index.data || index.data.complete) return;
    const controller = new AbortController(); setBusy(true); setError(""); setItems([]);
    const timer = setTimeout(() => { void (async () => {
      const found: NoteTitle[] = [];
      // The existing API searches title and body; filter its paginated results by title.
      for (let page = 1; ; page++) {
        const result = await listNotes({ q: query }, page, controller.signal);
        found.push(...result.items.filter(note => note.id !== noteId && normalizeSearch(note.title).includes(normalizeSearch(query.trim()))));
        if (!result.hasMore || found.length >= 50) break;
      }
      if (!controller.signal.aborted) setItems(found.slice(0, 50));
    })().catch(error => { if (!controller.signal.aborted) setError((error as Error).message); }).finally(() => { if (!controller.signal.aborted) setBusy(false); }); }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, index.data, noteId]);
  const shown = index.data?.complete ? filterTitles(index.data.items, query, noteId) : items.filter(note => note.id !== noteId);
  const loading = index.isPending || (!index.data?.complete && busy);
  const failure = index.error?.message || error;
  return <Popup className="note-link-popup" title={t("插入笔记链接")} anchor={anchor} close={close} restoreFocus={() => editor.view.focus()}>
    <div className="note-link-search"><Search aria-hidden="true" /><input data-initial-focus aria-label={t("搜索笔记标题")} placeholder={t("搜索当前空间的笔记标题")} maxLength={100} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (!event.nativeEvent.isComposing && event.key === "ArrowDown") { event.preventDefault(); candidates.current?.querySelector<HTMLButtonElement>("button")?.focus(); } }} /></div>
    {loading && <p role="status">{t("正在搜索…")}</p>}{failure && <p role="alert">{failure}</p>}
    {!loading && !failure && !shown.length && <p>{t("未找到笔记")}</p>}
    <div className="note-link-candidates" ref={candidates}>{shown.map(note => <button key={note.id} title={note.title || t("未命名笔记")} onFocus={event => event.currentTarget.scrollIntoView({ block: "nearest" })} onClick={() => { if (note.id === noteId || editor.view.composing || !editor.isEditable) return; editor.chain().focus().insertContent({ type: "noteLink", attrs: { noteId: note.id, title: note.title.replace(/[\p{Cc}]/gu, " ") } }).run(); close(); }}><FileText className="note-link-item-icon" aria-hidden="true" /><span>{note.title || t("未命名笔记")}</span><CornerDownLeft className="note-link-enter" aria-hidden="true" /></button>)}</div>
  </Popup>;
}
