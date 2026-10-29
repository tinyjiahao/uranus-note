import { supportsSchema } from "../../shared/schemaVersion";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { History, ChevronDown, ChevronLeft, FilePlus2, FileUp, Folder, FolderPlus, LayoutPanelLeft, List, LogOut, Moon, MoreHorizontal, PanelLeftClose, Pin, Search, Settings as SettingsIcon, Star, Sun, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import type { NoteDetail, NoteListItem } from "../../shared/dto";
import { SaveSignals } from "../state/saveSignals";
import { SaveFeedback } from "../components/SaveFeedback";
import { toMarkdown, safeFileName } from "../../shared/markdownExport";
import { ExportPopup } from "../components/ExportPopup";
import { NoteInfo } from "../components/NoteInfo";
import { FolderDialog, type FolderDialogState } from "../components/FolderDialog";
import { AccountSwitcher } from "../components/AccountSwitcher";
import { getSession, login, switchAccount } from "../api/client";
import { Popup, closePopups, pointAnchor, type PopupAnchor } from "../components/Popup";
import { patchNote, type NotePatch } from "../api/client";
import { createFolder, createNote, createNoteWithContent, deleteFolder, emptyTrash, getNote, hardDeleteNote, importMarkdown, listFolders, listNotes, logout, removeNote, renameFolder, restoreNote, type ApiClientError, type NoteFilters } from "../api/client";
import { clearDrafts, deleteDraftIfSequence, getDraft, type Draft } from "../state/drafts";
import { NoteSaveQueue } from "../state/saveQueue";
import { activateIdentity, notifyAccountChange } from "../state/identity";
import { noteTime, useUiStore } from "../state/ui";
import { Settings, SortControls } from "../components/Settings";
import { NoteEditor } from "../components/editor/NoteEditor";
import { VersionPanel } from "../components/VersionPanel";
import { validateAndDeriveContent } from "../../shared/content";
import { getMaintenanceJob, retryMaintenanceJob } from "../api/client";

type Scope = { kind: "none" | "all" | "starred" | "trash" | "folder"; folderId?: number };

export function Workspace({ user, defaultDataOwner }: { user: import("../../shared/account").AccountIdentity; defaultDataOwner: boolean }) {
  const params = useParams();
  const selectedId = params.id ? Number(params.id) : undefined;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { layout: preferredLayout, setLayout, theme, setTheme, sort, syncIntervalSeconds } = useUiStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [noteMenu, setNoteMenu] = useState<{ note: NoteListItem; anchor: PopupAnchor; workspace?: boolean } | null>(null);
  const [appMenu, setAppMenu] = useState<HTMLElement | null>(null);
  const [accountMenu, setAccountMenu] = useState<PopupAnchor | null>(null);
  const [switching, setSwitching] = useState(false);
  const [exportNote, setExportNote] = useState<{ noteId: number; folderId: number; anchor: PopupAnchor } | null>(null);
  const [infoNote, setInfoNote] = useState<{ note: NoteListItem; anchor: PopupAnchor } | null>(null);
  const [folderDialog, setFolderDialog] = useState<FolderDialogState | null>(null);
  const [moveMenu, setMoveMenu] = useState(false);
  const [menuBusy, setMenuBusy] = useState(false);
  const undoReturnId = useRef<number | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const [deletedNote, setDeletedNote] = useState<NoteDetail>();
  const [notice, setNotice] = useState("");
  const [jobId, setJobId] = useState<string>();
  const job = useQuery({ queryKey: ["user", user.id, "maintenance-job", jobId], enabled: Boolean(jobId), queryFn: () => getMaintenanceJob(jobId!), refetchInterval: query => ["succeeded", "failed"].includes(query.state.data?.status ?? "") ? false : 5000 });
  useEffect(() => { if (job.data?.status === "succeeded") { setNotice("永久删除任务已完成"); void queryClient.invalidateQueries({ queryKey: ["user", user.id, "notes"] }); } else if (job.data?.status === "failed") setNotice("删除任务失败，可重试；未完成的资源保留在后台任务中"); }, [job.data?.status, queryClient]);
  const listRef = useRef<HTMLDivElement>(null);
  const listPositions = useRef(new Map<string, { id: string; offset: number; scrollTop: number }>());
  const [scope, setScope] = useState<Scope>({ kind: "none" });
  const layout = scope.kind === "none" && !selectedId ? "three" : preferredLayout;
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [saveSignals] = useState(() => new SaveSignals());
  const [copyText, setCopyText] = useState("");
  const selectedIdRef = useRef(selectedId); selectedIdRef.current = selectedId;
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [draftCandidate, setDraftCandidate] = useState<Draft>();
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [titleHost, setTitleHost] = useState<HTMLDivElement | null>(null);
  const [modeHost, setModeHost] = useState<HTMLSpanElement | null>(null);
  const [conflictLatest, setConflictLatest] = useState<NoteDetail>();
  const queues = useRef(new Map<number, NoteSaveQueue>());
  const [locked, setLocked] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  useEffect(() => () => { for (const queue of queues.current.values()) queue.dispose(); queues.current.clear(); closePopups(); }, []);
  const beforeSensitiveChange = async () => {
    if (![...queues.current.values()].some(queue => queue.hasUnsaved())) return;
    if (confirm("有未同步修改。确定先同步再继续？取消后可选择放弃或返回。")) {
      for (const queue of queues.current.values()) await queue.flush();
      if ([...queues.current.values()].some(queue => queue.hasUnsaved())) throw new Error("同步未完成，请先处理保存问题");
    } else {
      if (!confirm("放弃当前未同步修改并继续？取消则返回编辑。")) throw new Error("已取消");
      for (const [id, queue] of queues.current) { queue.resolveWithServer(queryClient.getQueryData<NoteDetail>(["user", user.id, "note", id])?.revision ?? 0); queue.dispose(); }
      queues.current.clear();
      await clearDrafts(user.id);
    }
  };
  const exitAccount = async () => {
    try {
      if (!locked) { await beforeSensitiveChange(); for (const queue of queues.current.values()) queue.dispose(); activateIdentity(null); setLocked(true); }
      await logout();
    } catch (error) { setLogoutError((error as Error).message); }
  };
  const confirmSwitchedAccount = async () => {
    try {
      const session = await getSession();
      notifyAccountChange();
      await queryClient.cancelQueries();
      queryClient.clear();
      queryClient.setQueryData(["session"], session);
      navigate(session.authenticated ? "/" : "/login", { replace: true });
      // Switching back to the same user may keep this Workspace mounted.
      queues.current.clear(); setLocked(false); setSwitching(false); setAccountMenu(null); setLogoutError("");
    } catch (error) { setLogoutError((error as Error).message); }
  };
  const changeAccount = async (target: { userId: string; switchToken: string } | { email: string; password: string }) => {
    await beforeSensitiveChange();
    for (const queue of queues.current.values()) queue.dispose();
    activateIdentity(null); setSwitching(true); setLocked(true); setLogoutError("");
    await queryClient.cancelQueries();
    try {
      if ("userId" in target) await switchAccount(target.userId, target.switchToken);
      else await login(target.email, target.password);
      await confirmSwitchedAccount();
    } catch (error) {
      // The server may have changed Cookie before a response was lost. Never
      // restore the old editor on assumption; re-read authoritative identity.
      setLogoutError((error as Error).message);
    }
  };
  useEffect(() => { for (const queue of queues.current.values()) queue.setSyncInterval(syncIntervalSeconds * 1000); }, [syncIntervalSeconds]);
  useEffect(() => {
    const online = () => { for (const queue of queues.current.values()) queue.retryOnline(); };
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, []);
  useEffect(() => { setCopyText(""); }, [selectedId]);

  useEffect(() => { const timer = window.setTimeout(() => setDebouncedSearch(search), 300); return () => window.clearTimeout(timer); }, [search]);
  const filters = useMemo<NoteFilters>(() => ({
    folderId: scope.kind === "folder" ? scope.folderId : undefined,
    starred: scope.kind === "starred",
    deleted: scope.kind === "trash",
    q: debouncedSearch,
    sortBy: sort.by,
    sortDir: sort.dir,
  }), [scope, debouncedSearch, sort]);
  const folders = useQuery({ queryKey: ["user", user.id, "folders"], queryFn: listFolders });
  const notes = useInfiniteQuery({ queryKey: ["user", user.id, "notes", filters], enabled: scope.kind !== "none", initialPageParam: 1, queryFn: ({ pageParam, signal }) => listNotes(filters, pageParam, signal), getNextPageParam: page => page.hasMore ? page.page + 1 : undefined });
  const noteItems = scope.kind === "none" ? [] : [...new Map(notes.data?.pages.flatMap(page => page.items).map(note => [note.id, note]) ?? []).values()];
  const listKey = JSON.stringify(filters);
  const rememberList = () => {
    const list = listRef.current; if (!list || list.clientHeight === 0) return;
    const top = list.getBoundingClientRect().top;
    const row = Array.from(list.querySelectorAll<HTMLElement>("[data-note-id]")).find(item => item.getBoundingClientRect().bottom > top);
    if (row) listPositions.current.set(listKey, { id: row.dataset.noteId!, offset: row.getBoundingClientRect().top - top, scrollTop: list.scrollTop });
  };
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const list = listRef.current; if (!list || !list.clientHeight) return;
      const saved = listPositions.current.get(listKey);
      const row = saved && list.querySelector<HTMLElement>('[data-note-id="' + saved.id + '"]');
      list.scrollTop = row && saved ? list.scrollTop + row.getBoundingClientRect().top - list.getBoundingClientRect().top - saved.offset : saved?.scrollTop ?? 0;
    });
    return () => cancelAnimationFrame(frame);
  }, [listKey, selectedId, layout, notes.data]);
  useEffect(() => { closePopups(); setNoteMenu(null); setMoveMenu(false); }, [selectedId]);
  const selected = useQuery({ queryKey: ["user", user.id, "note", selectedId], queryFn: () => getNote(selectedId!), enabled: Number.isSafeInteger(selectedId) });
  const selectedNote = selected.data;
  useEffect(() => {
    if (selected.data) { try { localStorage.setItem("uranus.lastNote." + user.id, String(selected.data.id)); } catch { /* optional preference */ } }
  }, [selected.data?.id, user.id]);
  useEffect(() => {
    // Direct note URLs establish their notebook; the home page never restores a stale selection.
    if (scope.kind === "none" && selectedNote) setScope(selectedNote.deletedAt ? { kind: "trash" } : { kind: "folder", folderId: selectedNote.folderId });
  }, [scope.kind, selectedNote]);
  useEffect(() => {
    setDraftCandidate(undefined);
    let cancelled = false;
    if (selected.data) void getDraft(selected.data.id, user.id).then(async draft => draft ?? (defaultDataOwner ? await getDraft(selected.data!.id, user.id, true) : undefined)).then(draft => { if (!cancelled) setDraftCandidate(draft); }).catch((error: Error) => { if (!cancelled) saveSignals.update(selected.data!.id, { error: `无法读取本地草稿：${error.message}` }); });
    return () => { cancelled = true; };
  }, [selected.data?.id]);

  const queueFor = (note: NoteDetail) => {
    let queue = queues.current.get(note.id);
    if (!queue) {
      queue = new NoteSaveQueue(note.id, note.revision, (status, saved, error, info) => {
        saveSignals.update(note.id, { status, error: error?.message ?? "", info: info ?? { localSaved: false } });
        if (status === "conflict") setConflictLatest((error as ApiClientError | undefined)?.body?.error.latest);
        if (saved) queryClient.setQueryData(["user", user.id, "note", saved.id], saved);
        if (status === "saved") {
          void queryClient.invalidateQueries({ queryKey: ["user", user.id, "notes"] });
          void queryClient.invalidateQueries({ queryKey: ["user", user.id, "folders"] });
        }
      });
      queues.current.set(note.id, queue);
    }
    queue.updateRevision(note.revision);
    queue.setSyncInterval(useUiStore.getState().syncIntervalSeconds * 1000);
    return queue;
  };

  const createMutation = useMutation({
    mutationFn: () => createNote(scope.kind === "folder" ? scope.folderId : undefined),
    onError: error => setNotice(`新建失败：${error.message}`),
    onSuccess: async (note) => { await Promise.all([queryClient.invalidateQueries({ queryKey: ["user", user.id, "notes"] }), queryClient.invalidateQueries({ queryKey: ["user", user.id, "folders"] })]); navigate(`/notes/${note.id}`); },
  });
  const restoreMutation = useMutation({
    mutationFn: (note: NoteDetail) => restoreNote(note.id, note.revision),
    onSuccess: async (note) => { queryClient.setQueryData(["user", user.id, "note", note.id], note); setDeletedNote(undefined); setNotice("笔记已恢复"); if (undoReturnId.current === note.id && !selectedIdRef.current) navigate(`/notes/${note.id}`); undoReturnId.current = null; await queryClient.invalidateQueries(); },
    onError: error => setNotice(`恢复失败：${error.message}`),
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
    const beforeUnload = (event: BeforeUnloadEvent) => { if ([...queues.current.values()].some(queue => queue.hasUnsaved())) { for (const queue of queues.current.values()) void queue.flush(true); event.preventDefault(); } };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("beforeunload", beforeUnload);
    return () => { document.removeEventListener("visibilitychange", visibility); window.removeEventListener("beforeunload", beforeUnload); };
  }, []);
  useEffect(() => {
    const save = (event: KeyboardEvent) => {
      if (event.isComposing || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s" || !selectedNote || selectedNote.deletedAt || document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      if (!["saving", "saved", "idle", "conflict"].includes(saveSignals.get(selectedNote.id).status)) void queueFor(selectedNote).flush();
    };
    window.addEventListener("keydown", save);
    return () => window.removeEventListener("keydown", save);
  }, [selectedNote]);

  const chooseScope = (next: Scope) => { if (selectedNote) void queueFor(selectedNote).flush(); rememberList(); setSearch(""); setDebouncedSearch(""); setScope(next); setVersionsOpen(false); navigate("/"); if (layout === "focus") setLayout("three"); };
  const openNoteMenu = (note: NoteListItem, anchor: PopupAnchor, workspace = false) => { setNoteMenu({ note, anchor, workspace }); setMoveMenu(false); };
  const manageNote = async (patch: NotePatch | "delete" | "restore" | "permanent") => {
    if (!noteMenu || menuBusy) return;
    const target = noteMenu.note; setMenuBusy(true);
    try {
      const existingQueue = queues.current.get(target.id);
      if (existingQueue) { await existingQueue.flush(); if (existingQueue.hasUnsaved()) throw new Error("请先解决目标笔记的保存问题"); }
      if (patch === "permanent" && !confirm("永久删除这篇笔记及其历史附件？此操作不能撤销。")) return;
      const current = queryClient.getQueryData<NoteDetail>(["user", user.id, "note", target.id]);
      const revision = existingQueue && current ? current.revision : target.revision;
      if (patch === "delete") { const deleted = await removeNote(target.id, revision); setDeletedNote(deleted); undoReturnId.current = selectedIdRef.current === target.id ? target.id : null; setNotice("已移入最近删除"); if (selectedIdRef.current === target.id) navigate("/"); }
      else if (patch === "restore") { const restored = await restoreNote(target.id, revision); queryClient.setQueryData(["user", user.id, "note", target.id], restored); setNotice("笔记已恢复"); }
      else if (patch === "permanent") { const job = await hardDeleteNote(target.id, revision); setJobId(job.job_id); setNotice("永久删除任务已入队，正在处理中"); if (selectedIdRef.current === target.id) navigate("/"); }
      else if (existingQueue || selectedIdRef.current === target.id) {
        const detail = current ?? await getNote(target.id); const queue = queueFor(detail); queue.enqueue(patch, 0); await queue.flush(); if (queue.hasUnsaved()) throw new Error("修改尚未同步，请检查保存状态");
      } else { const result = await patchNote(target.id, revision, patch); queryClient.setQueryData(["user", user.id, "note", target.id], result.note); }
      setNoteMenu(null); await queryClient.invalidateQueries({ queryKey: ["user", user.id, "notes"] }); await queryClient.invalidateQueries({ queryKey: ["user", user.id, "folders"] });
    } catch (error) { setNotice("操作失败：" + (error as Error).message); }
    finally { setMenuBusy(false); }
  };
  if (locked) return <main className="center-message"><p>{switching ? "正在切换账号；确认账号前暂停编辑。" : "界面已锁定；仅在服务器确认后完成退出。"}</p><p role="alert">{logoutError}</p>{switching ? logoutError && <button onClick={() => void confirmSwitchedAccount()}>重新确认账号</button> : <button onClick={() => void exitAccount()}>重试退出</button>}</main>;
  const importMarkdownFile = async (file: File) => {
    try { const note = await importMarkdown(await file.text(), scope.kind === "folder" ? scope.folderId : undefined); await queryClient.invalidateQueries(); navigate(`/notes/${note.id}`); }
    catch (error) { alert((error as Error).message); }
  };
  const closeAppActions = () => { setNoteMenu(null); setAppMenu(null); };
  const appActions = <div className="workspace-menu-actions">
    <button title="设置" onClick={() => { closeAppActions(); setSettingsOpen(true); }}><SettingsIcon />设置</button>
    <button className="mobile-only-action" title="导入 Markdown" onClick={() => { closeAppActions(); importInput.current?.click(); }}><FileUp />导入 Markdown</button>
    <button title="切换账号" onClick={() => {
      const anchor = document.querySelector<HTMLElement>(".note-more, .workspace-more");
      closeAppActions(); if (anchor) setAccountMenu(anchor);
    }}><LogOut />切换账号</button>
    <button title="切换主题" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? <Sun /> : <Moon />}切换主题</button>
    <button title="退出" onClick={() => { closeAppActions(); void exitAccount(); }}><LogOut />退出</button>
  </div>;
  return <main className={`workspace layout-${layout}`}>
    <input ref={importInput} type="file" accept=".md,text/markdown,text/plain" hidden aria-hidden="true" tabIndex={-1} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importMarkdownFile(file); }} />
    {layout === "three" && <aside className="sidebar">
      <div className="brand"><img src="/icon.svg" alt="" /><strong>Uranus</strong></div>
      <nav aria-label="笔记范围">
        <ScopeButton active={scope.kind === "all"} icon={<List />} label="全部笔记" onClick={() => chooseScope({ kind: "all" })} />
        <ScopeButton active={scope.kind === "starred"} icon={<Star />} label="已加星标" onClick={() => chooseScope({ kind: "starred" })} />
        <ScopeButton active={scope.kind === "trash"} icon={<Trash2 />} label="最近删除" onClick={() => chooseScope({ kind: "trash" })} />
        <div className="nav-heading"><span>文件夹</span><button aria-label="新建文件夹" onClick={() => setFolderDialog({ kind: "create" })}><FolderPlus /></button></div>
        {folders.data?.map((folder) => <div className="folder-row" key={folder.id}><ScopeButton active={scope.kind === "folder" && scope.folderId === folder.id} icon={<Folder />} label={`${folder.name} (${folder.noteCount})`} onClick={() => chooseScope({ kind: "folder", folderId: folder.id })} /><button className="folder-menu" aria-label={`管理 ${folder.name}`} aria-haspopup="dialog" onClick={() => setFolderDialog({ kind: "manage", folder })}><MoreHorizontal /></button></div>)}
      </nav>
    </aside>}

    {layout !== "focus" && <section className="note-list-panel">
      <div className="mobile-notebook-bar">
        <Folder aria-hidden="true" />
        <div className="mobile-select"><select aria-label="选择笔记本" value={scope.kind === "folder" ? `folder:${scope.folderId}` : scope.kind} onChange={event => {
          const value = event.target.value;
          if (value.startsWith("folder:")) chooseScope({ kind: "folder", folderId: Number(value.slice(7)) });
          else if (value === "all" || value === "starred" || value === "trash") chooseScope({ kind: value });
        }}>
          <option value="none" disabled>请选择笔记本</option>
          <option value="all">全部笔记</option>
          <option value="starred">已加星标</option>
          <option value="trash">最近删除</option>
          {folders.data?.map(folder => <option key={folder.id} value={`folder:${folder.id}`}>{folder.name} ({folder.noteCount})</option>)}
        </select><ChevronDown aria-hidden="true" /></div>
      </div>
      {folders.error && <div className="mobile-notebook-error" role="alert">笔记本加载失败 <button onClick={() => void folders.refetch()}>重试</button></div>}
      <header className="list-header">
        {layout === "two" && <button aria-label="展开侧栏" onClick={() => setLayout("three")}><ChevronLeft /></button>}
        <div className="search-box"><Search /><input id="global-search" aria-label="搜索标题和正文" placeholder="搜索标题和正文" value={search} onChange={(event) => setSearch(event.target.value)} />{search && <button aria-label="清空搜索" onClick={() => setSearch("")}>×</button>}</div>
        {scope.kind === "trash" && <button title="清空回收站" onClick={async () => { try { const all = await listNotes({ deleted: true }); if (confirm(`永久删除最近删除中的全部 ${all.totalCount ?? all.items.length} 篇笔记及历史附件？无法恢复，不限于当前搜索结果。`)) { const task = await emptyTrash(); setJobId(task.job_id); setNotice("清空回收站已入队，正在处理中"); await queryClient.invalidateQueries({ queryKey: ["user", user.id, "notes"] }); } } catch (error) { setNotice(`清空失败：${(error as Error).message}`); } }}><Trash2 /></button>}
        <label className="import-button" title="导入 Markdown"><input type="file" accept=".md,text/markdown,text/plain" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importMarkdownFile(file); }} />导入 Markdown</label>
        <button className="icon-primary" aria-label="新建笔记" title="新建笔记 (⌘N)" onClick={() => createMutation.mutate()}><FilePlus2 /></button>
      </header>
      <div className="list-options"><SortControls /></div>
      {search && scope.kind !== "none" && <div className="search-feedback" role="status">范围：{scope.kind === "folder" ? folders.data?.find(f => f.id === scope.folderId)?.name : ({ all: "全部笔记", starred: "已加星标", trash: "最近删除" })[scope.kind]} · {search !== debouncedSearch || notes.isFetching ? "正在搜索…" : notes.error ? "搜索失败" : noteItems.length ? "匹配 " + (notes.data?.pages[0]?.totalCount ?? noteItems.length) + " 篇" : "无匹配结果"}</div>}
      <div className="note-list" ref={listRef} onScroll={rememberList} aria-busy={notes.isLoading || search !== debouncedSearch}>
        {scope.kind === "none" && <div className="empty-state">请选择笔记本或“全部笔记”查看内容。</div>}
        {scope.kind !== "none" && notes.isLoading && <div className="empty-state" role="status">正在加载笔记…</div>}
        {(search === debouncedSearch ? noteItems : []).map((note) => <div key={note.id} className="note-row-wrapper" data-note-id={note.id} onContextMenu={event => { event.preventDefault(); openNoteMenu(note, pointAnchor(event.currentTarget, event.clientX, event.clientY)); }} onKeyDown={event => { if (!event.nativeEvent.isComposing && event.shiftKey && event.key === "F10") { event.preventDefault(); openNoteMenu(note, event.currentTarget.querySelector<HTMLElement>(".note-row-more")!); } }}>
          <button className={`note-row ${selectedId === note.id ? "active" : ""}`} onClick={() => { rememberList(); navigate(`/notes/${note.id}`); }}>
          <div><strong>{note.title || "未命名笔记"}</strong>{note.pinned && <Pin className="tiny" />}{note.starred && <Star className="tiny filled" />}</div>
          {note.searchMatch ? <p><SearchSnippet match={note.searchMatch} /></p> : note.snippet.trim() !== note.title.trim() ? <p>{note.snippet || "暂无内容"}</p> : !note.title && <p>暂无内容</p>}<time title={new Date(sort.by === "created_at" ? note.createdAt : note.updatedAt).toLocaleString()}>{sort.by === "created_at" ? "创建" : "更新"} · {noteTime(sort.by === "created_at" ? note.createdAt : note.updatedAt)}</time>
          </button><button className="note-row-more" aria-label={`管理笔记：${note.title || "未命名笔记"}`} aria-haspopup="dialog" aria-expanded={noteMenu?.note.id === note.id} onClick={event => openNoteMenu(note, event.currentTarget)}><MoreHorizontal /></button>
        </div>)}
        {scope.kind !== "none" && notes.hasNextPage && <button className="load-more" disabled={notes.isFetchingNextPage} onClick={() => void notes.fetchNextPage()}>加载更多笔记</button>}
        {scope.kind !== "none" && notes.error && <div role="alert">列表加载失败 <button onClick={() => void notes.refetch()}>重试</button></div>}
        {scope.kind !== "none" && !notes.isLoading && !notes.error && noteItems.length === 0 && search === debouncedSearch && <div className="empty-state">{search ? "没有匹配的笔记，试试其他关键词或范围。" : "这里还没有笔记"}</div>}
      </div>
    </section>}

    <section className="editor-panel">
      {selectedNote ? <>
        <header className="editor-meta">
          <button className="back-to-list" aria-label="返回笔记列表" onClick={() => { void queueFor(selectedNote).flush(); if (layout === "focus") setLayout("two"); navigate("/"); }}><ChevronLeft /></button>
          {layout !== "three" && <button aria-label="三栏视图" onClick={() => setLayout("three")}><LayoutPanelLeft /></button>}
          {layout === "three" && <button aria-label="收起侧栏" onClick={() => setLayout("two")}><PanelLeftClose /></button>}
          <div className="note-identity"><div ref={setTitleHost} className="note-title-host" /><SaveFeedback signals={saveSignals} id={selectedNote.id} /></div>
          <span ref={setModeHost} className="mode-host" />
          <button className={selectedNote.pinned ? "active" : ""} title="置顶" onClick={() => queueFor(selectedNote).enqueue({ pinned: !selectedNote.pinned }, 0)}><Pin /></button>
          <button className={selectedNote.starred ? "active" : ""} title="星标" aria-pressed={selectedNote.starred} onClick={() => queueFor(selectedNote).enqueue({ starred: !selectedNote.starred }, 0)}><Star fill={selectedNote.starred ? "currentColor" : "none"} /></button>
          {!selectedNote.deletedAt && <select className="folder-select" aria-label="移动到文件夹" value={selectedNote.folderId} onChange={(event) => queueFor(selectedNote).enqueue({ folder_id: Number(event.target.value) }, 0)}>{folders.data?.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select>}
          <button title="版本历史" aria-label="版本历史" aria-expanded={versionsOpen} onClick={() => setVersionsOpen((value) => !value)}><History /></button>
          <button className="note-more" aria-label="笔记更多" aria-haspopup="dialog" onClick={event => openNoteMenu(selectedNote, event.currentTarget, true)}><MoreHorizontal /></button>
        </header>
        <SaveFeedback banner signals={saveSignals} id={selectedNote.id} retry={() => void queueFor(selectedNote).flush()} copy={() => { const value = JSON.stringify(queueFor(selectedNote).localContent() ?? selectedNote.content, null, 2); void navigator.clipboard.writeText(value).then(() => setNotice("已复制未保存正文 JSON"), () => setCopyText(value)); }} />
        {copyText && <div className="draft-banner"><label>请手工选择并复制<textarea aria-label="未保存内容" readOnly value={copyText} onFocus={e => e.currentTarget.select()} /></label><button onClick={() => setCopyText("")}>关闭</button></div>}
        {draftCandidate && <div className="draft-banner"><span>发现 {new Date(draftCandidate.updatedAt).toLocaleString()} 的本机未提交草稿{draftCandidate.baseRevision !== selectedNote.revision ? "；服务器版本已改变" : ""}。</span><button onClick={() => {
          try { if (!supportsSchema(draftCandidate.contentSchemaVersion)) throw new Error("草稿版本不受支持，请升级应用"); validateAndDeriveContent(draftCandidate.content, draftCandidate.contentSchemaVersion); } catch (error) { setNotice((error as Error).message); return; }
          if (draftCandidate.baseRevision !== selectedNote.revision) { setNotice("服务器版本已改变，请先保留或复制本机草稿，不能直接覆盖服务器"); setCopyText(JSON.stringify(draftCandidate.content, null, 2)); return; }
          const local = { ...selectedNote, content: draftCandidate.content };
          queryClient.setQueryData(["user", user.id, "note", selectedNote.id], local);
          queueFor(selectedNote).enqueue({ content: draftCandidate.content as Record<string, unknown> }, 0);
          setDraftCandidate(undefined); setEditorEpoch((value) => value + 1);
        }}>加载本地草稿</button><button onClick={() => { void deleteDraftIfSequence(draftCandidate.noteId, draftCandidate.editSequence, user.id, draftCandidate.legacy); setDraftCandidate(undefined); }}>使用服务器版</button></div>}
        {conflictLatest?.id === selectedNote.id && <div className="draft-banner conflict-banner"><span>此笔记已在其他标签页或设备更新。选择服务器版会放弃本机未提交内容；也可把本机内容复制成新笔记。</span><button onClick={() => {
          queueFor(selectedNote).resolveWithServer(conflictLatest.revision); queryClient.setQueryData(["user", user.id, "note", selectedNote.id], conflictLatest); setConflictLatest(undefined); setEditorEpoch((value) => value + 1);
        }}>使用服务器版</button><button onClick={async () => {
          const queue = queueFor(selectedNote); const content = queue.localContent(); if (!content) return;
          const copy = await createNoteWithContent(selectedNote.folderId, content as Record<string, unknown>);
          queue.resolveWithServer(conflictLatest.revision); queryClient.setQueryData(["user", user.id, "note", selectedNote.id], conflictLatest); setConflictLatest(undefined); await queryClient.invalidateQueries(); navigate(`/notes/${copy.id}`);
        }}>复制本机内容</button></div>}
        <NoteEditor key={`${selectedNote.id}-${editorEpoch}`} note={selectedNote} titleHost={titleHost} modeHost={modeHost} readOnlyBecauseDeleted={selectedNote.deletedAt !== null} onUploadState={uploading => saveSignals.update(selectedNote.id, { uploading })} onChange={(content) => queueFor(selectedNote).enqueue({ content: content as Record<string, unknown> })} onFlush={() => queueFor(selectedNote).flush()} onPersistLocal={() => queueFor(selectedNote).persistLocal()} />
        {versionsOpen && <VersionPanel userId={user.id} note={selectedNote} beforeAction={async () => { const queue = queueFor(selectedNote); await queue.flush(); if (queue.hasUnsaved()) throw new Error("请先解决正文保存问题"); }} onClose={() => setVersionsOpen(false)} onRestored={async (restored) => { queues.current.delete(restored.id); queryClient.setQueryData(["user", user.id, "note", restored.id], restored); setEditorEpoch(value => value + 1); await queryClient.invalidateQueries({ queryKey: ["user", user.id, "notes"] }); setVersionsOpen(false); }} />}
      </> : selected.error ? <div className="empty-editor"><h2>笔记不存在或无权访问</h2></div> : null}
    </section>
    {notice && <div className="notice" role="status">{notice}{job.data?.status === "failed" && <button onClick={async () => { try { await retryMaintenanceJob(jobId!); setNotice("重试任务已入队，正在处理中"); await job.refetch(); } catch (error) { setNotice((error as Error).message); } }}>重试删除任务</button>}{deletedNote && <button onClick={() => restoreMutation.mutate(deletedNote)} disabled={restoreMutation.isPending}>撤销</button>}<button aria-label="关闭提示" onClick={() => { setNotice(""); setDeletedNote(undefined); }}>×</button></div>}
    {!selectedNote && <button className="workspace-more" aria-label="更多" aria-haspopup="dialog" onClick={event => setAppMenu(event.currentTarget)}><MoreHorizontal /></button>}
    {appMenu && <Popup anchor={appMenu} title="更多" close={() => setAppMenu(null)}>{appActions}</Popup>}
    {settingsOpen && <Settings user={user} beforeSensitiveChange={beforeSensitiveChange} onClose={() => setSettingsOpen(false)} />}
    {accountMenu && <AccountSwitcher anchor={accountMenu} close={() => setAccountMenu(null)} change={changeAccount} />}
    {folderDialog && <FolderDialog state={folderDialog} onClose={() => setFolderDialog(null)}
      onSave={async name => { if (folderDialog.kind === "create") await createFolder(name); else await renameFolder(folderDialog.folder.id, name); await queryClient.invalidateQueries({ queryKey: ["user", user.id, "folders"] }); }}
      onDelete={async folder => { await deleteFolder(folder.id); if (scope.folderId === folder.id) setScope({ kind: "trash" }); await queryClient.invalidateQueries(); }} />}
    {infoNote && <NoteInfo userId={user.id} note={infoNote.note} folder={folders.data?.find(folder => folder.id === infoNote.note.folderId)} localContent={() => queues.current.get(infoNote.note.id)?.localContent()} anchor={infoNote.anchor} close={() => setInfoNote(null)} />}
    {exportNote && <ExportPopup {...exportNote} localContent={id => queues.current.get(id)?.localContent()} close={() => setExportNote(null)} />}
    {noteMenu && <Popup anchor={noteMenu.anchor} title={noteMenu.note.title || "未命名笔记"} close={() => setNoteMenu(null)} back={moveMenu ? () => setMoveMenu(false) : undefined}>
      {noteMenu.note.deletedAt ? <><button onClick={() => { setInfoNote({ note: noteMenu.note, anchor: noteMenu.anchor }); setNoteMenu(null); }}>笔记信息</button><button disabled={menuBusy} onClick={() => void manageNote("restore")}>恢复笔记</button><hr /><button className="danger" disabled={menuBusy} onClick={() => void manageNote("permanent")}>永久删除…</button></> : moveMenu ? folders.data?.map(folder => <button key={folder.id} disabled={menuBusy} aria-pressed={folder.id === noteMenu.note.folderId} onClick={() => void manageNote({ folder_id: folder.id })}>{folder.name}</button>) : <>
        <button disabled={menuBusy} onClick={() => void manageNote({ pinned: !noteMenu.note.pinned })}>{noteMenu.note.pinned ? "取消置顶" : "置顶"}</button>
        <button disabled={menuBusy} onClick={() => void manageNote({ starred: !noteMenu.note.starred })}>{noteMenu.note.starred ? "取消星标" : "加星标"}</button>
        <button aria-haspopup="true" disabled={menuBusy} onClick={() => setMoveMenu(true)}>移动到文件夹 ›</button>
        <button onClick={() => { setInfoNote({ note: noteMenu.note, anchor: noteMenu.anchor }); setNoteMenu(null); }}>笔记信息</button>
        {selectedId === noteMenu.note.id && <button onClick={() => { setVersionsOpen(true); setNoteMenu(null); }}>版本历史</button>}
        <button onClick={async () => {
          try {
            const note = await getNote(noteMenu.note.id), content = queues.current.get(note.id)?.localContent() ?? note.content;
            const url = URL.createObjectURL(new Blob([toMarkdown(content)], { type: "text/markdown;charset=utf-8" }));
            const link = document.createElement("a"); link.href = url; link.download = safeFileName(validateAndDeriveContent(content).title, `uranus-note-${note.id}`) + ".md"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
            setNoteMenu(null); setNotice("已导出 Markdown；图片和文件仅保留相对路径，未包含附件字节。样式转换不保证往返无损。");
          } catch (error) { setNotice(`导出失败：${(error as Error).message}`); }
        }}>导出 Markdown</button>
        <button onClick={() => { setExportNote({ noteId: noteMenu.note.id, folderId: noteMenu.note.folderId, anchor: noteMenu.anchor }); setNoteMenu(null); }}>导出 ZIP（含附件）</button>
        {selectedId === noteMenu.note.id && <button onClick={() => { setNoteMenu(null); window.dispatchEvent(new Event("uranus-print-note")); }}>打印 / 保存为 PDF</button>}
        <hr /><button className="danger" disabled={menuBusy} onClick={() => void manageNote("delete")}>移入最近删除</button>
      </>}
      {noteMenu.workspace && !moveMenu && <><hr />{appActions}</>}
    </Popup>}
  </main>;
}

function SearchSnippet({ match }: { match: NonNullable<NoteListItem["searchMatch"]> }) {
  const points = Array.from(match.text);
  const valid = match.normalized === true && match.ranges.every(([start, end], i) => Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= points.length && (i === 0 || start >= match.ranges[i - 1]![1]));
  const parts: React.ReactNode[] = []; let cursor = 0;
  if (valid) for (const [start, end] of match.ranges) { parts.push(points.slice(cursor, start).join(""), <mark key={start}>{points.slice(start, end).join("")}</mark>); cursor = end; }
  parts.push(points.slice(cursor).join(""));
  return <>{match.source === "title" ? "标题" : "正文"}：{match.before ? "…" : ""}{parts}{match.after ? "…" : ""}</>;
}

function ScopeButton({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return <button className={`scope-button ${active ? "active" : ""}`} onClick={onClick}>{icon}<span>{label}</span></button>;
}
