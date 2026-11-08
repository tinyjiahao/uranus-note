import { t, useLocale } from "../../state/locale";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Copy, X, ZoomIn, ZoomOut } from "lucide-react";
import { closePopups } from "../Popup";
import { copyImageToClipboard } from "./inlineImage";

export function ImagePreview({ src, alt, close }: { src: string; alt: string; close: () => void }) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const [zoom, setZoom] = useState(100);
  const [size, setSize] = useState<{ width: number; height: number }>();
  const [copying, setCopying] = useState(false);
  const [status, setStatus] = useState("");
  const copy = async () => {
    setCopying(true);
    setStatus("");
    try { await copyImageToClipboard(src); setStatus(t("图片已复制")); }
    catch (error) { setStatus(t("复制失败：{0}", (error as Error).message || t("浏览器拒绝访问剪贴板"))); }
    finally { setCopying(false); }
  };
  useEffect(() => {
    closePopups();
    const panel = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    panel.showModal();
    return () => {
      panel.close();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(<dialog ref={dialog} className="image-preview" aria-label={t("图片放大预览")}
    onCancel={event => { event.preventDefault(); close(); }}
    onClick={event => { event.stopPropagation(); if (event.target === event.currentTarget) close(); }}
    onDoubleClick={event => event.stopPropagation()}
    onContextMenu={event => event.stopPropagation()}
    onKeyDown={event => event.stopPropagation()}>
    <header className="image-preview-header">
      <span className="image-preview-title">{alt || t("图片预览")}</span>
      <div className="image-preview-toolbar">
        <button aria-label={t("关闭图片预览")} title={t("关闭图片预览")} onClick={close} autoFocus><X /></button>
      </div>
    </header>
    {status && <div className="image-preview-status" role="status">{status}</div>}
    <div className="image-preview-stage" onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <img src={src} alt={alt || t("图片预览")} draggable={false}
        onLoad={({ currentTarget }) => setSize({ width: currentTarget.naturalWidth, height: currentTarget.naturalHeight })}
        onError={() => setStatus(t("图片加载失败"))}
        style={size ? { width: `calc(min(${size.width}px, 100cqw, ${100 * size.width / size.height}cqh) * ${zoom / 100})` } : undefined} />
    </div>
    <footer className="image-preview-footer">
      <div className="image-preview-toolbar" role="group" aria-label={t("图片预览操作")}>
        <button aria-label={t("缩小")} title={t("缩小")} onClick={() => setZoom(value => Math.max(50, value - 25))} disabled={!size || zoom <= 50}><ZoomOut /></button>
        <button aria-label={t("放大")} title={t("放大")} onClick={() => setZoom(value => Math.min(400, value + 25))} disabled={!size || zoom >= 400}><ZoomIn /></button>
        <button aria-label={t("复制")} title={t("复制图片")} onClick={() => void copy()} disabled={!size || copying}><Copy /></button>
      </div>
      <button className="image-preview-scale" aria-label={t("恢复适合屏幕大小")} title={t("恢复适合屏幕大小")} onClick={() => setZoom(100)} disabled={!size}>{zoom}%</button>
    </footer>
  </dialog>, document.body);
}
