import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArchiveRestore, ChevronLeft, FilePlus2, Folder, FolderPlus, LayoutPanelLeft, List, LogOut, Moon, MoreHorizontal, PanelLeftClose, Pin, Search, Settings as SettingsIcon, Star, Sun, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import type { NoteDetail } from "../../shared/dto";
import { createFolder, createNote, createNoteWithContent, deleteFolder, emptyTrash, getNote, hardDeleteNote, importMarkdown, listFolders, listNotes, logout, removeNote, renameFolder, restoreNote, type ApiClientError, type NoteFilters } from "../api/client";
import { clearDrafts, deleteDraftIfSequence, getDraft, type Draft } from "../state/drafts";
import { NoteSaveQueue, type SaveStatus, type SaveInfo } from "../state/saveQueue";
import { noteTime, useUiStore } from "../state/ui";
import { Settings, SortControls } from "../components/Settings";
import { NoteEditor } from "../components/editor/NoteEditor";
import { VersionPanel } from "../components/VersionPanel";
import { validateAndDeriveContent } from "../../shared/content";
import { getMaintenanceJob, retryMaintenanceJob } from "../api/client";

type Scope = { kind: "all" | "starred" | "trash" | "folder"; folderId?: number };
const statusText: Record<SaveStatus, string> = { idle: "", dirty: "未保存", saving: "正在保存…", saved: "已保存到服务器", error: "未同步", conflict: "发现编辑冲突" };

export function Workspace() {
  const params = useParams();
  const selectedId = params.id ? Number(params.id) : undefined;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { layout, setLayout, theme, setTheme, sort } = useUiStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deletedNote, setDeletedNote] = useState<NoteDetail>();
  const [notice, setNotice] = useState("");
  const [jobId, setJobId] = useState<string>();
  const job = useQuery({ queryKey: ["maintenance-job", jobId], enabled: Boolean(jobId), queryFn: () => getMaintenanceJob(jobId!), refetchInterval: query => ["succeeded", "failed"].includes(query.state.data?.status ?? "") ? false : 5000 });
  useEffect(() => { if (job.data?.status === "succeeded") { setNotice("永久删除任务已完成"); void queryClient.invalidateQueries({ queryKey: ["notes"] }); } else if (job.data?.status === "failed") setNotice("删除任务失败，可重试；未完成的资源保留在后台任务中"); }, [job.data?.status, queryClient]);
  const listRef = useRef<HTMLDivElement>(null);
  const [scope, setScope] = useState<Scope>({ kind: "all" });
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveError, setSaveError] = useState("");
  const [saveInfo, setSaveInfo] = useState<SaveInfo>({ localSaved: false });
  const [copyText, setCopyText] = useState("");
  const selectedIdRef = useRef(selectedId); selectedIdRef.current = selectedId;
  useEffect(() => { const expired = () => { queryClient.clear(); navigate("/login", { replace: true }); }; window.addEventListener("uranus-session-expired", expired); return () => window.removeEventListener("uranus-session-expired", expired); }, [navigate, queryClient]);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [draftCandidate, setDraftCandidate] = useState<Draft>();
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [conflictLatest, setConflictLatest] = useState<NoteDetail>();
  const queues = useRef(new Map<number, NoteSaveQueue>());
  useEffect(() => { const queue = selectedId ? queues.current.get(selectedId) : undefined; if (queue) queue.notify(); else { setSaveStatus("idle"); setSaveError(""); setSaveInfo({ localSaved: false }); } setCopyText(""); }, [selectedId]);

  useEffect(() => { const timer = window.setTimeout(() => setDebouncedSearch(search), 300); return () => window.clearTimeout(timer); }, [search]);
  const filters = useMemo<NoteFilters>(() => ({
    folderId: scope.kind === "folder" ? scope.folderId : undefined,
    starred: scope.kind === "starred",
    deleted: scope.kind === "trash",
    q: debouncedSearch,
    sortBy: sort.by,
    sortDir: sort.dir,
  }), [scope, debouncedSearch, sort]);
  const folders = useQuery({ queryKey: ["folders"], queryFn: listFolders });
  const notes = useInfiniteQuery({ queryKey: ["notes", filters], initialPageParam: 1, queryFn: ({ pageParam, signal }) => listNotes(filters, pageParam, signal), getNextPageParam: page => page.hasMore ? page.page + 1 : undefined });
  const noteItems = [...new Map(notes.data?.pages.flatMap(page => page.items).map(note => [note.id, note]) ?? []).values()];
  useEffect(() => { listRef.current?.scrollTo(0, 0); }, [filters]);
  const selected = useQuery({ queryKey: ["note", selectedId], queryFn: () => getNote(selectedId!), enabled: Number.isSafeInteger(selectedId) });
  useEffect(() => {
    setDraftCandidate(undefined);
    let cancelled = false;
    if (selected.data) void getDraft(selected.data.id).then(draft => { if (!cancelled) setDraftCandidate(draft); }).catch((error: Error) => setSaveError(`无法读取本地草稿：${error.message}`));
    return () => { cancelled = true; };
  }, [selected.data?.id]);

  const queueFor = (note: NoteDetail) => {
    let queue = queues.current.get(note.id);
    if (!queue) {
      queue = new NoteSaveQueue(note.id, note.revision, (status, saved, error, info) => {
        if (selectedIdRef.current === note.id) { setSaveStatus(status); setSaveError(error?.message ?? ""); setSaveInfo(info ?? { localSaved: false }); }
        if (status === "conflict") setConflictLatest((error as ApiClientError | undefined)?.body?.error.latest);
        if (saved) queryClient.setQueryData(["note", saved.id], saved);
        if (status === "saved") {
          void queryClient.invalidateQueries({ queryKey: ["notes"] });
          void queryClient.invalidateQueries({ queryKey: ["folders"] });
        }
      });
      queues.current.set(note.id, queue);
    }
    queue.updateRevision(note.revision);
    return queue;
  };

  const createMutation = useMutation({
    mutationFn: () => createNote(scope.kind === "folder" ? scope.folderId : undefined),
    onError: error => setNotice(`新建失败：${error.message}`),
    onSuccess: async (note) => { await Promise.all([queryClient.invalidateQueries({ queryKey: ["notes"] }), queryClient.invalidateQueries({ queryKey: ["folders"] })]); navigate(`/notes/${note.id}`); },
  });
  const deleteMutation = useMutation({
    mutationFn: async (note: NoteDetail) => { const queue = queueFor(note); await queue.flush(); if (queue.hasUnsaved()) throw new Error("正文尚未同步，请先重试保存"); const latest = await getNote(note.id); return removeNote(latest.id, latest.revision); },
    onSuccess: async (note) => { setDeletedNote(note); setNotice("已移到最近删除"); navigate("/"); await queryClient.invalidateQueries(); },
    onError: error => setNotice(`删除失败：${error.message}`),
  });
  const restoreMutation = useMutation({
    mutationFn: (note: NoteDetail) => restoreNote(note.id, note.revision),
    onSuccess: async (note) => { queryClient.setQueryData(["note", note.id], note); setDeletedNote(undefined); setNotice("笔记已恢复"); await queryClient.invalidateQueries(); navigate(`/notes/${note.id}`); setScope({ kind: "all" }); },
    onError: error => setNotice(`恢复失败：${error.message}`),
  });
  const hardDeleteMutation = useMutation({
    mutationFn: (note: NoteDetail) => hardDeleteNote(note.id, note.revision),
    onSuccess: async (result) => { setJobId(result.job_id); setNotice("永久删除任务已入队，正在处理中"); navigate("/"); await queryClient.invalidateQueries(); },
    onError: error => setNotice(`永久删除失败：${error.message}`),
  });

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === "n") { event.preventDefault(); createMutation.mutate(); }
      if (event.altKey && ["1", "2", "3"].includes(event.key)) { event.preventDefault(); setLayout(event.key === "1" ? "three" : event.key === "2" ? "two" : "focus"); }
      if (event.shiftKey && event.key.toLowerCase() === "f") { event.preventDefault(); document.getElementById("global-search")?.focus(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [createMutation, setLayout]);
  useEffect(() => {
    const visibility = () => { if (document.visibilityState === "hidden") for (const queue of queues.current.values()) void queue.flush(true); };
    const beforeUnload = (event: BeforeUnloadEvent) => { if (["dirty", "saving", "error", "conflict"].includes(saveStatus)) { for (const queue of queues.current.values()) void queue.flush(true); event.preventDefault(); } };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("beforeunload", beforeUnload);
    return () => { document.removeEventListener("visibilitychange", visibility); window.removeEventListener("beforeunload", beforeUnload); };
  }, [saveStatus]);

  const chooseScope = (next: Scope) => { setScope(next); if (layout === "focus") setLayout("three"); };
  const selectedNote = selected.data;
  return <main className={`workspace layout-${layout}`}>
    {layout === "three" && <aside className="sidebar">
      <div className="brand"><img src="/icon.svg" alt="" /><strong>Uranus</strong></div>
      <nav aria-label="笔记范围">
        <ScopeButton active={scope.kind === "all"} icon={<List />} label="全部笔记" onClick={() => chooseScope({ kind: "all" })} />
        <ScopeButton active={scope.kind === "starred"} icon={<Star />} label="已加星标" onClick={() => chooseScope({ kind: "starred" })} />
        <ScopeButton active={scope.kind === "trash"} icon={<Trash2 />} label="最近删除" onClick={() => chooseScope({ kind: "trash" })} />
        <div className="nav-heading"><span>文件夹</span><button aria-label="新建文件夹" onClick={async () => { const name = prompt("文件夹名称"); if (name?.trim()) { await createFolder(name.trim()); await queryClient.invalidateQueries({ queryKey: ["folders"] }); } }}><FolderPlus /></button></div>
        {folders.data?.map((folder) => <div className="folder-row" key={folder.id}><ScopeButton active={scope.kind === "folder" && scope.folderId === folder.id} icon={<Folder />} label={`${folder.name} (${folder.noteCount})`} onClick={() => chooseScope({ kind: "folder", folderId: folder.id })} /><button className="folder-menu" aria-label={`管理 ${folder.name}`} onClick={async () => {
          const action = prompt(`管理“${folder.name}”：输入新名称以重命名，输入 DELETE 删除${folder.systemKey === "default" ? "（默认文件夹不可删除）" : ""}`);
          if (!action) return;
          try {
            if (action === "DELETE") { if (folder.systemKey === "default") return alert("默认文件夹不可删除"); if (confirm(`删除“${folder.name}”并将其中笔记移到回收站？`)) await deleteFolder(folder.id); }
            else await renameFolder(folder.id, action.trim());
            if (scope.folderId === folder.id && action === "DELETE") setScope({ kind: "trash" });
            await queryClient.invalidateQueries();
          } catch (error) { alert((error as Error).message); }
        }}><MoreHorizontal /></button></div>)}
      </nav>
      <div className="sidebar-footer">
        <button title="切换主题" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? <Sun /> : <Moon />}</button>
        <button title="退出" onClick={async () => { if (confirm("退出并清除本机未提交草稿？")) { await clearDrafts(); await logout(); queryClient.clear(); navigate("/login"); } }}><LogOut /></button>
      </div>
    </aside>}

    {layout !== "focus" && <section className="note-list-panel">
      <header className="list-header">
        {layout === "two" && <button aria-label="展开侧栏" onClick={() => setLayout("three")}><ChevronLeft /></button>}
        <div className="search-box"><Search /><input id="global-search" placeholder="搜索标题和正文" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
        {scope.kind === "trash" && <button title="清空回收站" onClick={async () => { try { const all = await listNotes({ deleted: true }); if (confirm(`永久删除最近删除中的全部 ${all.totalCount ?? all.items.length} 篇笔记及历史附件？无法恢复，不限于当前搜索结果。`)) { const task = await emptyTrash(); setJobId(task.job_id); setNotice("清空回收站已入队，正在处理中"); await queryClient.invalidateQueries({ queryKey: ["notes"] }); } } catch (error) { setNotice(`清空失败：${(error as Error).message}`); } }}><Trash2 /></button>}
        <label className="import-button" title="导入 Markdown"><input type="file" accept=".md,text/markdown,text/plain" onChange={async (event) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; try { const note = await importMarkdown(await file.text(), scope.kind === "folder" ? scope.folderId : undefined); await queryClient.invalidateQueries(); navigate(`/notes/${note.id}`); } catch (error) { alert((error as Error).message); } }} />MD</label>
        <button className="icon-primary" aria-label="新建笔记" title="新建笔记 (⌘N)" onClick={() => createMutation.mutate()}><FilePlus2 /></button>
      </header>
      <div className="list-options"><SortControls /></div>
      <div className="note-list" ref={listRef} aria-busy={notes.isLoading}>
        {noteItems.map((note) => <button key={note.id} className={`note-row ${selectedId === note.id ? "active" : ""}`} onClick={() => navigate(`/notes/${note.id}`)}>
          <div><strong>{note.title || "未命名笔记"}</strong>{note.pinned && <Pin className="tiny" />}{note.starred && <Star className="tiny filled" />}</div>
          <p>{note.snippet || "暂无内容"}</p><time title={new Date(sort.by === "created_at" ? note.createdAt : note.updatedAt).toLocaleString()}>{sort.by === "created_at" ? "创建" : "更新"} · {noteTime(sort.by === "created_at" ? note.createdAt : note.updatedAt)}</time>
        </button>)}
        {notes.hasNextPage && <button className="load-more" disabled={notes.isFetchingNextPage} onClick={() => void notes.fetchNextPage()}>加载更多笔记</button>}
        {notes.error && <div role="alert">列表加载失败 <button onClick={() => void notes.refetch()}>重试</button></div>}
        {!notes.isLoading && noteItems.length === 0 && <div className="empty-state">这里还没有笔记</div>}
      </div>
    </section>}

    <section className="editor-panel">
      {selectedNote ? <>
        <header className="editor-meta">
          <button className="back-to-list" aria-label="返回笔记列表" onClick={() => { void queueFor(selectedNote).flush(); if (layout === "focus") setLayout("two"); navigate("/"); }}><ChevronLeft /></button>
          {layout !== "three" && <button aria-label="三栏视图" onClick={() => setLayout("three")}><LayoutPanelLeft /></button>}
          {layout === "three" && <button aria-label="收起侧栏" onClick={() => setLayout("two")}><PanelLeftClose /></button>}
          <span role="status" title={saveInfo.confirmedAt ? `最近服务器确认：${new Date(saveInfo.confirmedAt).toLocaleString()}` : undefined} className={`save-state status-${saveStatus}`}>{saveStatus === "error" ? (saveInfo.localSaved ? "未同步，草稿已暂存此浏览器" : "内容尚未安全保存") : statusText[saveStatus]}{saveError ? `：${saveError}` : ""}</span>
          <span className="spacer" />
          <button className={selectedNote.pinned ? "active" : ""} title="置顶" onClick={() => queueFor(selectedNote).enqueue({ pinned: !selectedNote.pinned }, 0)}><Pin /></button>
          <button className={selectedNote.starred ? "active" : ""} title="星标" onClick={() => queueFor(selectedNote).enqueue({ starred: !selectedNote.starred }, 0)}><Star /></button>
          {!selectedNote.deletedAt && <select className="folder-select" aria-label="移动到文件夹" value={selectedNote.folderId} onChange={(event) => queueFor(selectedNote).enqueue({ folder_id: Number(event.target.value) }, 0)}>{folders.data?.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select>}
          <button title="版本历史" onClick={() => setVersionsOpen((value) => !value)}><ArchiveRestore /></button>
          {selectedNote.deletedAt ? <><button title="恢复" onClick={() => restoreMutation.mutate(selectedNote)}><ArchiveRestore /></button><button title="永久删除" onClick={() => { if (confirm("永久删除这篇笔记及其历史附件？此操作不能撤销。")) hardDeleteMutation.mutate(selectedNote); }}><Trash2 /></button></> : <button title="移到最近删除" onClick={() => deleteMutation.mutate(selectedNote)}><Trash2 /></button>}
        </header>
        {(saveStatus === "error" || saveError) && <div className="draft-banner"><span>{saveInfo.localSaved ? "本机草稿尚未同步到服务器。" : "服务器保存和本机暂存均未确认，请保留内容。"}</span><button onClick={() => void queueFor(selectedNote).flush()}>重试保存</button><button onClick={async () => { const content = queueFor(selectedNote).localContent(); const value = JSON.stringify(content ?? selectedNote.content, null, 2); try { await navigator.clipboard.writeText(value); setNotice("已复制未保存正文 JSON"); } catch { setCopyText(value); } }}>复制未保存内容</button></div>}
        {copyText && <div className="draft-banner"><label>请手工选择并复制<textarea aria-label="未保存内容" readOnly value={copyText} onFocus={e => e.currentTarget.select()} /></label><button onClick={() => setCopyText("")}>关闭</button></div>}
        {draftCandidate && <div className="draft-banner"><span>发现 {new Date(draftCandidate.updatedAt).toLocaleString()} 的本机未提交草稿{draftCandidate.baseRevision !== selectedNote.revision ? "；服务器版本已改变" : ""}。</span><button onClick={() => {
          try { if (![1, 2, 3].includes(draftCandidate.contentSchemaVersion)) throw new Error("草稿版本不受支持，请升级应用"); validateAndDeriveContent(draftCandidate.content); } catch (error) { setNotice((error as Error).message); return; }
          if (draftCandidate.baseRevision !== selectedNote.revision) { setNotice("服务器版本已改变，请先保留或复制本机草稿，不能直接覆盖服务器"); setCopyText(JSON.stringify(draftCandidate.content, null, 2)); return; }
          const local = { ...selectedNote, content: draftCandidate.content };
          queryClient.setQueryData(["note", selectedNote.id], local);
          queueFor(selectedNote).enqueue({ content: draftCandidate.content as Record<string, unknown> }, 0);
          setDraftCandidate(undefined); setEditorEpoch((value) => value + 1);
        }}>加载本地草稿</button><button onClick={() => { void deleteDraftIfSequence(draftCandidate.noteId, draftCandidate.editSequence); setDraftCandidate(undefined); }}>使用服务器版</button></div>}
        {conflictLatest?.id === selectedNote.id && <div className="draft-banner conflict-banner"><span>此笔记已在其他标签页或设备更新。选择服务器版会放弃本机未提交内容；也可把本机内容复制成新笔记。</span><button onClick={() => {
          queueFor(selectedNote).resolveWithServer(conflictLatest.revision); queryClient.setQueryData(["note", selectedNote.id], conflictLatest); setConflictLatest(undefined); setEditorEpoch((value) => value + 1);
        }}>使用服务器版</button><button onClick={async () => {
          const queue = queueFor(selectedNote); const content = queue.localContent(); if (!content) return;
          const copy = await createNoteWithContent(selectedNote.folderId, content as Record<string, unknown>);
          queue.resolveWithServer(conflictLatest.revision); queryClient.setQueryData(["note", selectedNote.id], conflictLatest); setConflictLatest(undefined); await queryClient.invalidateQueries(); navigate(`/notes/${copy.id}`);
        }}>复制本机内容</button></div>}
        <NoteEditor key={`${selectedNote.id}-${editorEpoch}`} note={selectedNote} readOnlyBecauseDeleted={selectedNote.deletedAt !== null} onChange={(content) => queueFor(selectedNote).enqueue({ content: content as Record<string, unknown> })} onFlush={() => queueFor(selectedNote).flush()} />
        {versionsOpen && <VersionPanel note={selectedNote} beforeAction={async () => { const queue = queueFor(selectedNote); await queue.flush(); if (queue.hasUnsaved()) throw new Error("请先解决正文保存问题"); }} onClose={() => setVersionsOpen(false)} onRestored={async (restored) => { queues.current.delete(restored.id); queryClient.setQueryData(["note", restored.id], restored); setEditorEpoch(value => value + 1); await queryClient.invalidateQueries({ queryKey: ["notes"] }); setVersionsOpen(false); }} />}
      </> : <div className="empty-editor"><img src="/icon.svg" alt="" /><h2>选择一篇笔记</h2><p>或创建一篇新笔记开始记录。</p><button className="primary" onClick={() => createMutation.mutate()}>新建笔记</button>{layout === "focus" && <button onClick={() => setLayout("three")}>返回笔记列表</button>}</div>}
    </section>
    {notice && <div className="notice" role="status">{notice}{job.data?.status === "failed" && <button onClick={async () => { try { await retryMaintenanceJob(jobId!); setNotice("重试任务已入队，正在处理中"); await job.refetch(); } catch (error) { setNotice((error as Error).message); } }}>重试删除任务</button>}{deletedNote && <button onClick={() => restoreMutation.mutate(deletedNote)} disabled={restoreMutation.isPending}>撤销</button>}<button aria-label="关闭提示" onClick={() => { setNotice(""); setDeletedNote(undefined); }}>×</button></div>}
    <button className="settings-launcher" aria-label="设置" title="设置" aria-haspopup="dialog" onClick={() => setSettingsOpen(true)}><SettingsIcon /></button>
    {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
  </main>;
}

function ScopeButton({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return <button className={`scope-button ${active ? "active" : ""}`} onClick={onClick}>{icon}<span>{label}</span></button>;
}
