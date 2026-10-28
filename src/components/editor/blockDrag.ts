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
    let frame = 0;
    let pointerY = 0;
    let currentView: EditorView;
    const cancel = () => { active = undefined; guide?.remove(); guide = undefined; cancelAnimationFrame(frame); frame = 0; };
    const locate = (view: EditorView, y: number) => {
      let target = view.state.doc.content.size;
      let top = view.dom.getBoundingClientRect().top;
      let found = false;
      view.state.doc.forEach((node, pos) => {
        if (found) return;
        const element = view.nodeDOM(pos);
        if (!(element instanceof HTMLElement)) return;
        const rect = element.getBoundingClientRect();
        if (y < rect.top + rect.height / 2) { target = pos; top = rect.top; found = true; }
        else { target = pos + node.nodeSize; top = rect.bottom; }
      });
      if (active) active.target = target;
      if (guide) {
        const rect = view.dom.getBoundingClientRect();
        guide.style.cssText = `left:${rect.left + 28}px;top:${top}px;width:${Math.max(0, rect.width - 56)}px`;
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
          state.doc.forEach((node, pos) => {
            decorations.push(Decoration.widget(pos, (view, getPos) => {
              const wrapper = document.createElement("span");
              wrapper.className = "block-drag-anchor";
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
            }, { side: -1, key: `block-drag-${pos}-${node.type.name}`, stopEvent: () => true, ignoreSelection: true }));
          });
          return DecorationSet.create(state.doc, decorations);
        },
      },
      view(view) {
        currentView = view;
        const move = (event: PointerEvent) => {
          if (!active || event.pointerId !== active.pointer) return;
          if (!view.editable || !active.doc.eq(view.state.doc)) { cancel(); return; }
          if (!active.moved && Math.hypot(event.clientX - active.x, event.clientY - active.y) < 5) return;
          event.preventDefault(); pointerY = event.clientY;
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
          update(updated) { currentView = updated; if (active && (!updated.editable || !active.doc.eq(updated.state.doc))) cancel(); },
          destroy() { cancel(); document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); document.removeEventListener("pointercancel", cancel); document.removeEventListener("keydown", key, true); window.removeEventListener("blur", cancel); },
        };
      },
    })];
  },
});
