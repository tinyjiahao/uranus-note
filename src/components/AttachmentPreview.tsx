import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, X } from "lucide-react";
import { downloadAttachmentBytes } from "../api/client";
import { closePopups } from "./Popup";

const MAX_TEXT_CHARS = 1_000_000;
const MAX_BYTES = 10_000_000;

export function AttachmentPreview({ id, name, mime, size, close }: { id: string; name: string; mime: string; size: number; close: () => void }) {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; message: string } | { kind: "text"; text: string; note: string } | { kind: "pdf"; url: string }>({ kind: "loading" });
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closePopups();
    const previous = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = "";
    void downloadAttachmentBytes(id, controller.signal, MAX_BYTES).then(bytes => {
      if (controller.signal.aborted) return;
      if (mime === "application/pdf") {
        objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
        setState({ kind: "pdf", url: objectUrl });
        return;
      }
      let text = new TextDecoder("utf-8").decode(bytes), note = "";
      if (mime === "application/json") { try { text = JSON.stringify(JSON.parse(text), null, 2); note = "已格式化显示"; } catch { note = "不是合法 JSON，按原文显示"; } }
      if (text.length > MAX_TEXT_CHARS) { text = text.slice(0, MAX_TEXT_CHARS); note = `仅显示前 ${MAX_TEXT_CHARS.toLocaleString()} 个字符，完整内容请下载`; }
      setState({ kind: "text", text, note });
    }).catch(error => { if (!controller.signal.aborted) setState({ kind: "error", message: (error as Error).message || "预览失败" }); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [id, mime]);
  return createPortal(<aside className="attachment-preview" role="dialog" aria-label={`附件预览：${name}`} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}>
    <header>
      <div><strong title={name}>{name}</strong><small>{(size / 1024).toFixed(1)} KB</small></div>
      <a className="attachment-action" href={`/api/attachments/${encodeURIComponent(id)}`} download={name} aria-label="下载附件" title="下载附件"><Download aria-hidden="true" /></a>
      <button ref={closeButton} type="button" aria-label="关闭预览" title="关闭预览" onClick={close}><X aria-hidden="true" /></button>
    </header>
    <div className="attachment-preview-body">
      {state.kind === "loading" && <p role="status">正在加载…</p>}
      {state.kind === "error" && <p role="alert">无法预览：{state.message}。可以下载后查看。</p>}
      {state.kind === "text" && <>{state.note && <p className="attachment-preview-note">{state.note}</p>}<pre>{state.text || "（空文件）"}</pre></>}
      {state.kind === "pdf" && <iframe title={`PDF 预览：${name}`} src={state.url} />}
    </div>
  </aside>, document.body);
}

export type AttachmentPreviewTarget = { id: string; name: string; mime: string; size: number };

/** One shared preview panel: opening another attachment replaces the current one instead of stacking panels. */
export function openAttachmentPreview(target: AttachmentPreviewTarget) {
  window.dispatchEvent(new CustomEvent<AttachmentPreviewTarget>("uranus-preview-attachment", { detail: target }));
}

export function AttachmentPreviewHost() {
  const [target, setTarget] = useState<AttachmentPreviewTarget | null>(null);
  useEffect(() => {
    const open = (event: Event) => setTarget((event as CustomEvent<AttachmentPreviewTarget>).detail);
    window.addEventListener("uranus-preview-attachment", open);
    return () => window.removeEventListener("uranus-preview-attachment", open);
  }, []);
  return target ? <AttachmentPreview key={target.id} {...target} close={() => setTarget(null)} /> : null;
}
