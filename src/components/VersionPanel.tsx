import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useState } from "react";
import type { ContentNode, NoteDetail } from "../../shared/dto";
import { NoteEditor } from "./editor/NoteEditor";
import { createVersion, getVersion, listVersions, restoreVersion } from "../api/client";

export function VersionPanel({ userId, note, onClose, onRestored, beforeAction }: { userId: string; note: NoteDetail; onClose: () => void; onRestored: (note: NoteDetail) => void; beforeAction: () => Promise<void> }) {
  const noteId = note.id;
  const queryClient = useQueryClient();
  const versions = useQuery({ queryKey: ["user", userId, "versions", noteId], queryFn: () => listVersions(noteId) });
  const [selected, setSelected] = useState<number>();
  const version = useQuery({ queryKey: ["user", userId, "version", noteId, selected], queryFn: () => getVersion(noteId, selected!), enabled: selected !== undefined });
  const createMutation = useMutation({ mutationFn: async () => { await beforeAction(); return createVersion(noteId); }, onSuccess: () => queryClient.invalidateQueries({ queryKey: ["user", userId, "versions", noteId] }) });
  const restoreMutation = useMutation({ mutationFn: async () => { await beforeAction(); const current = queryClient.getQueryData<NoteDetail>(["user", userId, "note", noteId]) ?? note; return restoreVersion(noteId, selected!, current.revision); }, onSuccess: onRestored });
  return <aside className="version-panel">
    <header><strong>版本历史</strong><div><button className="text-button" onClick={() => createMutation.mutate()} disabled={createMutation.isPending}>标记版本</button><button aria-label="关闭版本历史" onClick={onClose}><X /></button></div></header>
    {version.data ? <div className="version-preview"><button onClick={() => setSelected(undefined)}>← 返回列表</button><h3>{String(version.data.title || "未命名版本")}</h3><NoteEditor key={selected} note={{ ...note, content: version.data.content as ContentNode }} readOnlyBecauseDeleted onChange={() => undefined} onFlush={async () => undefined} /><button className="primary" disabled={restoreMutation.isPending} onClick={() => { if (confirm("恢复此版本？当前正文会先保存为历史版本。")) restoreMutation.mutate(); }}>{restoreMutation.isPending ? "正在恢复…" : "恢复此版本"}</button></div> : <div className="version-list">
      {versions.data?.items.map((item) => <button key={String(item.id)} onClick={() => setSelected(Number(item.id))}><strong>{String(item.title || "未命名笔记")}</strong><span>{new Date(Number(item.created_at)).toLocaleString()} · {String(item.char_count)} 字</span></button>)}
      {!versions.isLoading && versions.data?.items.length === 0 && <p className="muted">正文保存满 5 分钟间隔后会形成历史版本。</p>}
    </div>}
    {(restoreMutation.error || createMutation.error) && <p role="alert">{(restoreMutation.error || createMutation.error)?.message}</p>}
  </aside>;
}
