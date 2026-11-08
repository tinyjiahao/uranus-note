import { useLayoutEffect, useRef } from "react";
import { readReadingHistory, saveReadingPosition } from "../../state/readingHistory";

export function useReadingPosition(userId: string | undefined, noteId: number, ready: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const scroller = ref.current;
    if (!scroller || !userId || !ready) return;
    const body = scroller.querySelector(".prose-editor");
    if (!body) return;
    let top = readReadingHistory(userId).find(entry => entry.id === noteId)?.top ?? 0;
    let restoring = top > 0;
    let timer = 0;
    const save = () => {
      window.clearTimeout(timer);
      if (!restoring) saveReadingPosition(userId, noteId, top);
    };
    const observer = new ResizeObserver(restore);
    function restore() {
      if (!restoring) return;
      scroller!.scrollTop = top;
      // An attachment may not have its final height until it loads.
      if (Math.abs(scroller!.scrollTop - top) < 1) {
        restoring = false;
        observer.disconnect();
      }
    }
    const interrupt = () => {
      if (!restoring) return;
      restoring = false;
      top = scroller.scrollTop;
      observer.disconnect();
    };
    const scroll = () => {
      if (restoring) return;
      top = scroller.scrollTop;
      window.clearTimeout(timer);
      timer = window.setTimeout(save, 250);
    };
    restore();
    if (restoring) observer.observe(body);
    scroller.addEventListener("scroll", scroll, { passive: true });
    scroller.addEventListener("pointerdown", interrupt, { passive: true });
    scroller.addEventListener("wheel", interrupt, { passive: true });
    scroller.addEventListener("keydown", interrupt);
    window.addEventListener("pagehide", save);
    const visibility = () => { if (document.visibilityState === "hidden") save(); };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      save();
      observer.disconnect();
      scroller.removeEventListener("scroll", scroll);
      scroller.removeEventListener("pointerdown", interrupt);
      scroller.removeEventListener("wheel", interrupt);
      scroller.removeEventListener("keydown", interrupt);
      window.removeEventListener("pagehide", save);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [userId, noteId, ready]);
  return ref;
}
