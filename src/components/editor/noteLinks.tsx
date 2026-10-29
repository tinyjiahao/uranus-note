import { Node, type Editor } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { useEffect, useState } from "react";
import { noteLinkAttributes } from "../../../shared/noteLink";
import { normalizeSearch } from "../../../shared/content";
import type { NoteListItem } from "../../../shared/dto";
import { getNote, listNotes } from "../../api/client";
import { identity } from "../../state/identity";
import { Popup, type PopupAnchor } from "../Popup";

function NoteLinkView({ node }: NodeViewProps) {
  const navigate = useNavigate(), id = Number(node.attrs.noteId);
  const target = useQuery({ queryKey: ["user", identity().userId, "note", id], queryFn: ({ signal }) => getNote(id, signal), retry: false, staleTime: 30_000 });
  const missing = target.isError || Boolean(target.data?.deletedAt);
  return <NodeViewWrapper as="span" contentEditable={false} data-drag-handle="" className={`note-link${missing ? " note-link-missing" : ""}`}>
    <a data-note-link href={`/notes/${id}`} title={missing ? "目标笔记不可用" : "打开笔记"} aria-disabled={missing} onClick={event => { event.preventDefault(); if (!missing) navigate(`/notes/${id}`); }}>{target.data && !missing ? target.data.title || "未命名笔记" : String(node.attrs.title || "未命名笔记")}{missing && "（不可用）"}</a>
  </NodeViewWrapper>;
}
export const NoteLinkNode = Node.create({
  name: "noteLink", group: "inline", inline: true, atom: true, draggable: true, marks: "",
  addAttributes: () => ({ noteId: { default: 0 }, title: { default: "" } }),
  parseHTML: () => [{ tag: 'span[data-note-link="1"]', getAttrs: element => {
    const parsed = noteLinkAttributes.safeParse({ noteId: Number(element.getAttribute("data-id")), title: element.getAttribute("data-title") });
    return parsed.success ? parsed.data : false;
  } }],
  renderHTML: ({ node }) => ["span", { "data-note-link": "1", "data-id": node.attrs.noteId, "data-title": node.attrs.title }, node.attrs.title || "未命名笔记"],
  addNodeView: () => ReactNodeViewRenderer(NoteLinkView),
});
export function NoteLinkPopup({ editor, anchor, close }: { editor: Editor; anchor: PopupAnchor; close: () => void }) {
  const [query, setQuery] = useState(""), [items, setItems] = useState<NoteListItem[]>([]), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); setBusy(true); setError(""); setItems([]);
    const timer = setTimeout(() => { void (async () => {
      const found: NoteListItem[] = [];
      // The existing API searches title and body; filter its paginated results by title.
      for (let page = 1; ; page++) {
        const result = await listNotes({ q: query }, page, controller.signal);
        found.push(...result.items.filter(note => normalizeSearch(note.title).includes(normalizeSearch(query.trim()))));
        if (!result.hasMore || found.length >= 50) break;
      }
      if (!controller.signal.aborted) setItems(found.slice(0, 50));
    })().catch(error => { if (!controller.signal.aborted) setError((error as Error).message); }).finally(() => { if (!controller.signal.aborted) setBusy(false); }); }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);
  return <Popup title="插入笔记链接" anchor={anchor} close={close} restoreFocus={() => editor.view.focus()}>
    <input data-initial-focus aria-label="搜索笔记标题" placeholder="搜索当前空间的笔记标题" maxLength={100} value={query} onChange={event => setQuery(event.target.value)} />
    {busy && <p role="status">正在搜索…</p>}{error && <p role="alert">{error}</p>}
    {!busy && !error && !items.length && <p>未找到笔记</p>}
    {items.map(note => <button key={note.id} onClick={() => { if (editor.view.composing || !editor.isEditable) return; editor.chain().focus().insertContent({ type: "noteLink", attrs: { noteId: note.id, title: note.title.replace(/[\p{Cc}]/gu, " ") } }).run(); close(); }}>{note.title || "未命名笔记"}</button>)}
  </Popup>;
}
