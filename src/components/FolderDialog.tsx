import { useEffect, useRef, useState } from "react";
import type { FolderDto } from "../../shared/dto";

export type FolderDialogState = { kind: "create" } | { kind: "manage"; folder: FolderDto };

export function FolderDialog({ state, onClose, onSave, onDelete }: { state: FolderDialogState; onClose: () => void; onSave: (name: string) => Promise<void>; onDelete: (folder: FolderDto) => Promise<void> }) {
  const folder = state.kind === "manage" ? state.folder : null;
  const [name, setName] = useState(folder?.name ?? "");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  const trimmed = name.trim(), length = Array.from(trimmed).length;
  const invalid = !length ? "请输入文件夹名称" : length > 128 ? "名称最多 128 个字符" : "";
  const unchanged = folder !== null && trimmed === folder.name;
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await action(); onClose(); } catch (failure) { setError((failure as Error).message); setConfirming(false); } finally { setBusy(false); }
  };
  const isDefault = folder?.systemKey === "default";
  return <div className="link-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <form className="link-dialog folder-dialog" role="dialog" aria-modal="true" aria-labelledby="folder-dialog-title" onSubmit={event => { event.preventDefault(); if (!invalid && !unchanged && !confirming) void run(() => onSave(trimmed)); }}
      onKeyDown={event => { if (event.nativeEvent.isComposing) { if (event.key === "Enter") event.preventDefault(); return; } if (event.key === "Escape") { event.preventDefault(); if (confirming) setConfirming(false); else if (!busy) onClose(); } }}>
      <h2 id="folder-dialog-title">{folder ? "管理文件夹" : "新建文件夹"}</h2>
      {confirming && folder ? <>
        <p className="folder-dialog-warning" role="alert">将删除“{folder.name}”，其中 {folder.noteCount} 篇笔记会移入“最近删除”，30 天内可在最近删除中恢复。</p>
        <div><button type="button" disabled={busy} onClick={() => setConfirming(false)}>返回</button><button type="button" className="danger" disabled={busy} autoFocus onClick={() => void run(() => onDelete(folder))}>确认删除</button></div>
      </> : <>
        <label>文件夹名称<input ref={input} value={name} maxLength={256} aria-invalid={Boolean(error || (name && invalid))} placeholder="例如：工作、读书笔记" onChange={event => { setName(event.target.value); setError(""); }} /></label>
        {(error || (name && invalid)) && <p role="alert" className="folder-dialog-error">{error || invalid}</p>}
        {folder && <p className="folder-dialog-meta">包含 {folder.noteCount} 篇笔记{isDefault ? "；默认文件夹不能删除" : ""}</p>}
        <div className="folder-dialog-actions">
          {folder && !isDefault && <button type="button" className="danger folder-dialog-delete" disabled={busy} onClick={() => setConfirming(true)}>删除文件夹…</button>}
          <button type="button" disabled={busy} onClick={onClose}>取消</button>
          <button type="submit" className="primary" disabled={busy || Boolean(invalid) || unchanged}>{folder ? "保存" : "创建"}</button>
        </div>
      </>}
    </form>
  </div>;
}
