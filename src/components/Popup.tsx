import { useLayoutEffect, useRef, useState, type ReactNode, type ClipboardEventHandler } from "react";
import { createPortal } from "react-dom";

export type PopupAnchor = HTMLElement | { left: number; top: number; bottom: number; right: number; element?: HTMLElement; originLeft?: number; originTop?: number };
export function pointAnchor(element: HTMLElement, x: number, y: number): PopupAnchor {
  const rect = element.getBoundingClientRect();
  return { element, originLeft: rect.left, originTop: rect.top, left: x, right: x, top: y, bottom: y };
}
// One root popup across editor, list and settings. Subpanels stay in the same root.
export function closePopups() { window.dispatchEvent(new Event("uranus-close-popups")); }
export function Popup({ anchor, title, close, children, back, restoreFocus, className = "", placement = "bottom", onCopy, autoFocus = true, positionAnchor }: {
  anchor: PopupAnchor; title: string; close: () => void; children: ReactNode; back?: (() => void) | undefined; restoreFocus?: (() => void) | undefined; className?: string;
  placement?: "top" | "bottom";
  onCopy?: ClipboardEventHandler<HTMLDivElement>;
  /** Set false for popups attached to editor content so the editor keeps focus and arrow keys keep moving the caret. */
  autoFocus?: boolean;
  /** Element whose rectangle is used for placement while `anchor` keeps focus/outside-click semantics (e.g. the whole card instead of its inner button). */
  positionAnchor?: HTMLElement | null;
}) {
  const root = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef(close); closeRef.current = close;
  const backRef = useRef(back); backRef.current = back;
  const restoreRef = useRef(restoreFocus); restoreRef.current = restoreFocus;
  const focusTrigger = () => {
    if (anchor instanceof HTMLElement && anchor.isConnected) anchor.focus();
    else if (restoreRef.current) restoreRef.current();
    else if (triggerRef.current?.isConnected) triggerRef.current.focus();
  };
  const [position, setPosition] = useState({ left: 8, top: 8 });
  useLayoutEffect(() => {
    closePopups();
    const dismiss = () => closeRef.current();
    window.addEventListener("uranus-close-popups", dismiss);
    const trigger = document.activeElement as HTMLElement | null;
    triggerRef.current = trigger;
    const panel = root.current!;
    const anchorElement = anchor instanceof HTMLElement ? anchor : anchor.element;
    const owner = anchorElement?.closest(".tableWrapper");
    owner?.classList.add("popup-owner");
    const narrow = matchMedia("(max-width: 767px)").matches;
    const oldOverflow = document.body.style.overflow;
    if (narrow) document.body.style.overflow = "hidden";
    const place = () => {
      const viewport = window.visualViewport;
      const width = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight;
      const x = viewport?.offsetLeft ?? 0, y = viewport?.offsetTop ?? 0;
      panel.style.setProperty("--popup-height", `${height}px`);
      panel.style.setProperty("--popup-bottom", `${Math.max(0, innerHeight - height - y)}px`);
      let rect = anchor instanceof HTMLElement ? (positionAnchor ?? anchor).getBoundingClientRect() : anchor;
      const targetRect = anchorElement?.getBoundingClientRect();
      if (!(anchor instanceof HTMLElement) && targetRect) {
        const dx = targetRect.left - (anchor.originLeft ?? targetRect.left), dy = targetRect.top - (anchor.originTop ?? targetRect.top);
        rect = { left: anchor.left + dx, right: anchor.right + dx, top: anchor.top + dy, bottom: anchor.bottom + dy };
      }
      if (anchorElement && targetRect && (!anchorElement.isConnected || targetRect.bottom < y || targetRect.top > y + height || targetRect.right < x || targetRect.left > x + width)) { dismiss(); return; }
      const top = placement === "top" && rect.top - panel.offsetHeight - 6 >= y + 8 ? rect.top - panel.offsetHeight - 6 : rect.bottom + 6;
      setPosition({ left: Math.max(x + 8, Math.min(rect.left, x + width - panel.offsetWidth - 8)), top: Math.max(y + 8, Math.min(top, y + height - panel.offsetHeight - 8)) });
    };
    place();
    if (autoFocus) (panel.querySelector<HTMLElement>("[data-initial-focus]") ?? panel.querySelector<HTMLElement>("button:not(:disabled),input,select"))?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (!panel.contains(event.target as Node) && !(anchor instanceof HTMLElement && anchor.contains(event.target as Node))) dismiss(); };
    const key = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation();
        if (backRef.current) { backRef.current(); return; }
        dismiss(); focusTrigger();
      }
    };
    document.addEventListener("pointerdown", outside); panel.addEventListener("keydown", key);
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place); window.visualViewport?.addEventListener("scroll", place);
    const observer = new ResizeObserver(place); observer.observe(panel);
    return () => {
      observer.disconnect(); document.body.style.overflow = oldOverflow;
      owner?.classList.remove("popup-owner");
      window.removeEventListener("uranus-close-popups", dismiss);
      document.removeEventListener("pointerdown", outside); panel.removeEventListener("keydown", key);
      window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place); window.visualViewport?.removeEventListener("scroll", place);
    };
  }, [anchor, placement]);
  useLayoutEffect(() => {
    const panel = root.current;
    // A subpanel can remove the focused input/button. Keep keyboard navigation
    // inside the surviving popup instead of leaving focus on document.body.
    if (autoFocus && panel && !panel.contains(document.activeElement) && !(className === "toolbar-more-popup" && document.activeElement?.closest(".prose-editor"))) {
      (panel.querySelector<HTMLElement>("[data-initial-focus]") ?? panel.querySelector<HTMLElement>(".object-popup-content button:not(:disabled),.object-popup-content input"))?.focus({ preventScroll: true });
    }
  });
  return createPortal(<><div className="popup-backdrop" aria-hidden="true" onClick={close} /><div className={`object-popup ${className}`} ref={root} role="dialog" aria-label={title} style={position} onCopy={onCopy} onKeyDown={event => {
    if (event.nativeEvent.isComposing) return;
    const target = event.target as HTMLElement;
    if (event.key === "Tab" && matchMedia("(max-width: 767px)").matches) {
      const controls = Array.from(root.current!.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex='0']")).filter(el => el.tabIndex >= 0);
      if (event.shiftKey && target === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
      else if (!event.shiftKey && target === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
    }
    if (target.matches("input,select,textarea") || target.closest('[role="grid"]')) return;
    const buttons = Array.from(root.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
    const index = buttons.indexOf(target as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus(); }
    if (event.key === "ArrowLeft" && back) { event.preventDefault(); back(); }
    if (event.key === "ArrowRight" && target.getAttribute("aria-haspopup") === "true") { event.preventDefault(); target.click(); }
  }}>
    <header>{back && <button aria-label="返回上一级" onClick={back}>‹</button>}<strong>{title}</strong><button aria-label="关闭菜单" onClick={() => { close(); focusTrigger(); }}>×</button></header>
    <div className="object-popup-content">{children}</div>
  </div></>, anchor instanceof HTMLElement ? anchor.closest("dialog") ?? document.body : document.body);
}
