import { useSyncExternalStore } from "react";
import type { SaveSignals } from "../state/saveSignals";
const text = { idle: "已保存", dirty: "未保存", saving: "正在保存…", saved: "已保存到服务器", error: "未同步", conflict: "发现编辑冲突" };
export function SaveFeedback({ signals, id, retry, copy, banner = false }: { signals: SaveSignals; id: number; retry?: () => void; copy?: () => void; banner?: boolean }) {
  const { status, info, error, uploading } = useSyncExternalStore(signals.subscribe, () => signals.get(id));
  if (banner) return status === "error" || error ? <div className="draft-banner"><span>{info.localSaved ? "本机草稿尚未同步到服务器。" : "服务器保存和本机暂存均未确认，请保留内容。"}</span><button onClick={retry}>重试保存</button><button onClick={copy}>复制未保存内容</button></div> : null;
  const local = info.localSaved ? "已存本机 · 待同步" : info.localError ? "本机暂存失败 · 待同步" : "正在暂存本机…";
  return <span role="status" className={`save-state status-${status}`} title={status === "dirty" ? local : info.confirmedAt ? `最近服务器确认：${new Date(info.confirmedAt).toLocaleString()}` : undefined}>{uploading ? "附件上传中…" : status === "dirty" ? local : status === "error" ? (info.localSaved ? "未同步，草稿已暂存此浏览器" : "内容尚未安全保存") : text[status]}{error ? `：${error}` : ""}</span>;
}
