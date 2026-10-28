import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { closePopups } from "../Popup";

export function ImagePreview({ src, alt, close }: { src: string; alt: string; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
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
  return createPortal(<dialog ref={dialog} className="image-preview" aria-label="图片放大预览"
    onCancel={event => { event.preventDefault(); close(); }}
    onClick={event => { event.stopPropagation(); if (event.target === event.currentTarget) close(); }}
    onDoubleClick={event => event.stopPropagation()}
    onContextMenu={event => event.stopPropagation()}
    onKeyDown={event => event.stopPropagation()}>
    <button className="image-preview-close" aria-label="关闭图片预览" onClick={close} autoFocus><X /></button>
    <img src={src} alt={alt || "图片预览"} draggable={false} />
  </dialog>, document.body);
}
