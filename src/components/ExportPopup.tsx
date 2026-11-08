import { t, useLocale } from "../state/locale";
import { useEffect, useRef, useState } from "react";
import type { ContentNode } from "../../shared/dto";
import { attachmentFiles, safeFileName, toMarkdown } from "../../shared/markdownExport";
import { validateAndDeriveContent } from "../../shared/content";
import { StoreZip } from "../../shared/zip";
import { downloadAttachmentBytes, getNote, listNotes } from "../api/client";
import { identity, identityMatches } from "../state/identity";
import { Popup, type PopupAnchor } from "./Popup";

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function ExportPopup({ noteId, folderId, anchor, close, localContent }: { noteId: number; folderId: number; anchor: PopupAnchor; close: () => void; localContent: (id: number) => ContentNode | undefined }) {
  useLocale();
  const [scope, setScope] = useState("current"), [progress, setProgress] = useState(""), [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const run = async () => {
    const abort = new AbortController(); controller.current = abort; setBusy(true); setProgress(t("正在读取笔记列表…"));
    const expected = identity(), zip = new StoreZip();
    try {
      const ids = new Set<number>();
      if (scope === "current") ids.add(noteId);
      else for (let page = 1; ; page++) {
        const result = await listNotes(scope === "folder" ? { folderId } : {}, page, abort.signal);
        result.items.forEach(note => ids.add(note.id));
        if (ids.size > 1000) throw new Error(t("每次最多导出 1000 篇，请缩小范围"));
        if (!result.hasMore) break;
      }
      let done = 0;
      for (const id of ids) {
        abort.signal.throwIfAborted(); if (!identityMatches(expected)) throw new Error(t("账号已变化，已取消导出"));
        const note = await getNote(id, abort.signal), content = localContent(id) ?? note.content;
        const name = safeFileName(validateAndDeriveContent(content).title, `uranus-note-${id}`);
        const prefix = scope === "current" ? "" : `${name}-${id}/`;
        setProgress(t("正在导出 {0}/{1}：{2}", ++done, ids.size, name));
        zip.add(`${prefix}${name}.md`, new TextEncoder().encode(toMarkdown(content)));
        for (const [attachmentId, path] of attachmentFiles(content)) {
          try { zip.add(prefix + path, await downloadAttachmentBytes(attachmentId, abort.signal, zip.remaining)); }
          catch (error) { if (abort.signal.aborted) throw error; throw new Error(t("附件 {0} 未导出：{1}。未生成不完整的 ZIP。", path, (error as Error).message)); }
        }
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      abort.signal.throwIfAborted(); if (!identityMatches(expected)) throw new Error(t("账号已变化，已取消导出"));
      downloadBlob(zip.blob(), `uranus-${scope}-${new Date().toISOString().slice(0, 10)}.zip`);
      setProgress(t("已导出 {0} 篇笔记及其附件。Markdown 不保证格式往返无损。", ids.size));
    } catch (error) { setProgress(abort.signal.aborted ? t("已取消导出，未生成文件") : (error as Error).message); }
    finally { setBusy(false); controller.current = null; }
  };
  return <Popup anchor={anchor} title={t("导出 ZIP（含附件）")} close={close}>
    <label>{t("导出范围")}<select disabled={busy} value={scope} onChange={event => setScope(event.target.value)}><option value="current">{t("当前笔记")}</option><option value="folder">{t("当前笔记所在文件夹")}</option><option value="all">{t("全部笔记（不含最近删除）")}</option></select></label>
    <p>{t("最多 1000 篇、100 MB；包含当前正文引用的附件，不包含历史版本，不能替代运维备份。")}</p>
    {progress && <p role="status">{progress}</p>}
    {busy ? <button onClick={() => controller.current?.abort()}>{t("取消导出")}</button> : <button className="primary" onClick={() => void run()}>{t("开始导出")}</button>}
  </Popup>;
}
