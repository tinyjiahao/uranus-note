import { Extension } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { NodeSelection, Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node } from "@tiptap/pm/model";

const names: Record<string, string> = { paragraph: "段落", heading: "标题", bulletList: "无序列表", orderedList: "有序列表", taskList: "任务列表", blockquote: "引用", codeBlock: "代码块", table: "表格", image: "图片", fileAttachment: "附件", horizontalRule: "分隔线" };

/** Reorder whole body blocks only. Never split tables, lists, or attachment nodes. */
export function moveBlock(view: EditorView, from: number, target: number) {
  if (!view.editable || view.composing) return false;
  const node = view.state.doc.nodeAt(from);
  if (!node || target >= from && target <= from + node.nodeSize) return false;
  const tr = closeHistory(view.state.tr).delete(from, from + node.nodeSize);
  const insertion = target > from ? target - node.nodeSize : target;
  tr.insert(insertion, node).setSelection(NodeSelection.create(tr.doc, insertion));
  view.dispatch(tr.scrollIntoView());
  view.dispatch(closeHistory(view.state.tr));
  return true;
}

export const BlockDrag = Extension.create({
  name: "blockDrag",
  addProseMirrorPlugins() {
    const editor = this.editor;
    let active: { from: number; doc: Node; x: number; y: number; pointer: number; target: number; moved: boolean } | undefined;
    let guide: HTMLDivElement | undefined;
    let pointerX = 0;
    let frame = 0;
    let pointerY = 0;
    let currentView: EditorView;
    let alignFrame = 0;
    const alignHandles = (view: EditorView) => {
      alignFrame = 0;
      const anchors = [...view.dom.querySelectorAll<HTMLElement>(":scope > .block-drag-anchor")];
      const tops = anchors.map(anchor => {
        const next = anchor.nextElementSibling;
        const handle = anchor.firstElementChild;
        if (!(next instanceof HTMLElement) || !(handle instanceof HTMLElement) || next.classList.contains("block-drag-anchor")) return undefined;
        // Attachments are laid out inline: the handle becomes a small corner badge on the attachment's own top-left corner instead of hanging in the gap to the previous one.
        const corner = next.matches(".node-fileAttachment");
        for (const [prop, value] of [["left", "-4px"], ["width", "18px"], ["height", "18px"]] as const) handle.style[prop] = corner ? value : "";
        if (corner) { handle.style.top = "-4px"; return undefined; }
        // Tables keep the stylesheet default so the handle does not cover the first row's menu handle.
        if (next.matches(".tableWrapper")) { handle.style.top = ""; return undefined; }
        const line = next;
        const style = getComputedStyle(line);
        const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
        const edge = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.borderTopWidth) || 0);
        return { handle, top: line.getBoundingClientRect().top - anchor.getBoundingClientRect().top + edge + lineHeight / 2 - handle.offsetHeight / 2 };
      });
      for (const item of tops) if (item) item.handle.style.top = `${Math.round(item.top)}px`;
    };
    const scheduleAlign = (view: EditorView) => { if (!alignFrame) alignFrame = requestAnimationFrame(() => alignHandles(view)); };
    const cancel = () => { active = undefined; guide?.remove(); guide = undefined; cancelAnimationFrame(frame); frame = 0; };
    // Blocks laid out inline (file attachments sit side by side) are located in two dimensions and shown with a vertical drop caret between them.
    const locate = (view: EditorView, y: number, x = pointerX) => {
      let target = view.state.doc.content.size;
      let top = view.dom.getBoundingClientRect().top;
      let caret: { left: number; top: number; height: number } | undefined;
      let found = false;
      view.state.doc.forEach((node, pos) => {
        if (found) return;
        const element = view.nodeDOM(pos);
        if (!(element instanceof HTMLElement)) return;
        const rect = element.getBoundingClientRect();
        if (element.classList.contains("node-fileAttachment")) {
          if (y < rect.top || (y <= rect.bottom && x < rect.left + rect.width / 2)) { target = pos; caret = { left: rect.left - 5, top: rect.top, height: rect.height }; found = true; }
          else { target = pos + node.nodeSize; caret = { left: rect.right + 4, top: rect.top, height: rect.height }; top = rect.bottom; }
          return;
        }
        caret = undefined;
        if (y < rect.top + rect.height / 2) { target = pos; top = rect.top; found = true; }
        else { target = pos + node.nodeSize; top = rect.bottom; }
      });
      if (active) active.target = target;
      if (guide) {
        const rect = view.dom.getBoundingClientRect();
        guide.style.cssText = caret ? `left:${caret.left}px;top:${caret.top}px;width:3px;height:${caret.height}px` : `left:${rect.left + 28}px;top:${top}px;width:${Math.max(0, rect.width - 56)}px`;
      }
    };
    const scroll = () => {
      if (!active?.moved) return;
      const container = currentView.dom.closest(".editor-content");
      if (container instanceof HTMLElement) {
        const rect = container.getBoundingClientRect();
        const delta = pointerY < rect.top + 48 ? -12 : pointerY > rect.bottom - 48 ? 12 : 0;
        if (delta) { container.scrollTop += delta; locate(currentView, pointerY); }
      }
      frame = requestAnimationFrame(scroll);
    };
    return [new Plugin({
      props: {
        decorations(state) {
          if (!editor.options.editable) return DecorationSet.empty;
          const decorations: Decoration[] = [];
          // Only the top-level block holding the caret/selection shows its handle (CSS also requires editor focus or handle focus).
          const { $head } = state.selection;
          const currentPos = $head.depth >= 1 ? $head.before(1) : state.selection.from;
          state.doc.forEach((node, pos) => {
            const current = pos === currentPos;
            decorations.push(Decoration.widget(pos, (view, getPos) => {
              const wrapper = document.createElement("span");
              wrapper.className = `block-drag-anchor${current ? " is-current" : ""}`;
              wrapper.contentEditable = "false";
              const handle = document.createElement("button");
              handle.type = "button"; handle.className = "block-drag-handle";
              handle.setAttribute("aria-label", `拖动${names[node.type.name] ?? "内容块"}`);
              handle.title = "拖动调整顺序；聚焦后按 Alt + ↑ / ↓ 移动";
              handle.onpointerdown = event => {
                if (event.button !== 0 || !view.editable || view.composing) return;
                const from = getPos(); if (typeof from !== "number") return;
                event.preventDefault(); event.stopPropagation(); cancel();
                handle.focus({ preventScroll: true });
                active = { from, doc: view.state.doc, x: event.clientX, y: event.clientY, pointer: event.pointerId, target: from, moved: false };
              };
              handle.onkeydown = event => {
                if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
                event.preventDefault(); event.stopPropagation();
                const from = getPos(); if (typeof from !== "number") return;
                const positions: number[] = []; view.state.doc.forEach((_node, offset) => positions.push(offset));
                positions.push(view.state.doc.content.size);
                const index = positions.indexOf(from);
                const target = positions[index + (event.key === "ArrowUp" ? -1 : 2)];
                if (target !== undefined) { moveBlock(view, from, target); view.focus(); }
              };
              wrapper.appendChild(handle); return wrapper;
            }, { side: -1, key: `block-drag-${pos}-${node.type.name}-${current ? "current" : "idle"}`, stopEvent: () => true, ignoreSelection: true }));
          });
          return DecorationSet.create(state.doc, decorations);
        },
      },
      view(view) {
        currentView = view;
        const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => scheduleAlign(view));
        resizeObserver?.observe(view.dom);
        scheduleAlign(view);
        // The handle follows the mouse: the top-level block whose row contains the pointer's y (left margin included) shows its handle.
        let hovered: HTMLElement | null = null, lastY: number | null = null, lastX = 0, hoverFrame = 0;
        const setHovered = (anchor: HTMLElement | null) => {
          if (hovered === anchor) return;
          hovered?.classList.remove("is-hover"); hovered = anchor; hovered?.classList.add("is-hover");
        };
        const updateHover = () => {
          hoverFrame = 0;
          if (active || lastY === null || !view.editable) return;
          let found: HTMLElement | null = null;
          for (const anchor of view.dom.querySelectorAll<HTMLElement>(":scope > .block-drag-anchor")) {
            const next = anchor.nextElementSibling;
            if (!(next instanceof HTMLElement) || next.classList.contains("block-drag-anchor")) continue;
            const rect = next.getBoundingClientRect();
            if (rect.top > lastY) break;
            // Attachments share a row: only those at or left of the pointer qualify, so the one under the pointer wins.
            if (next.classList.contains("node-fileAttachment") && lastY <= rect.bottom && lastX < rect.left - 6) continue;
            found = anchor;
          }
          setHovered(found);
        };
        const scheduleHover = () => { if (!hoverFrame) hoverFrame = requestAnimationFrame(updateHover); };
        const mouseMove = (event: MouseEvent) => { lastY = event.clientY; lastX = event.clientX; scheduleHover(); };
        const mouseLeave = () => { lastY = null; if (!active) setHovered(null); };
        const scroller = view.dom.closest(".editor-content");
        view.dom.addEventListener("mousemove", mouseMove); view.dom.addEventListener("mouseleave", mouseLeave); scroller?.addEventListener("scroll", scheduleHover, { passive: true });
        const move = (event: PointerEvent) => {
          if (!active || event.pointerId !== active.pointer) return;
          if (!view.editable || !active.doc.eq(view.state.doc)) { cancel(); return; }
          if (!active.moved && Math.hypot(event.clientX - active.x, event.clientY - active.y) < 5) return;
          event.preventDefault(); pointerY = event.clientY; pointerX = event.clientX;
          if (!active.moved) { active.moved = true; guide = document.createElement("div"); guide.className = "block-drop-guide"; document.body.appendChild(guide); frame = requestAnimationFrame(scroll); }
          locate(view, pointerY);
        };
        const up = (event: PointerEvent) => {
          if (!active || event.pointerId !== active.pointer) return;
          const drag = active; const rect = view.dom.getBoundingClientRect();
          const viewport = view.dom.closest(".editor-content")?.getBoundingClientRect() ?? rect;
          cancel();
          if (drag.moved && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= viewport.top && event.clientY <= viewport.bottom && drag.doc.eq(view.state.doc)) {
            moveBlock(view, drag.from, drag.target); view.focus();
          }
        };
        const key = (event: KeyboardEvent) => { if (active && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); } };
        document.addEventListener("pointermove", move, { passive: false }); document.addEventListener("pointerup", up);
        document.addEventListener("pointercancel", cancel); document.addEventListener("keydown", key, true); window.addEventListener("blur", cancel);
        return {
          update(updated) { currentView = updated; scheduleAlign(updated); if (active && (!updated.editable || !active.doc.eq(updated.state.doc))) cancel(); },
          destroy() { cancel(); cancelAnimationFrame(hoverFrame); view.dom.removeEventListener("mousemove", mouseMove); view.dom.removeEventListener("mouseleave", mouseLeave); scroller?.removeEventListener("scroll", scheduleHover); cancelAnimationFrame(alignFrame); alignFrame = 0; resizeObserver?.disconnect(); document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); document.removeEventListener("pointercancel", cancel); document.removeEventListener("keydown", key, true); window.removeEventListener("blur", cancel); },
        };
      },
    })];
  },
});
