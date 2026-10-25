import { Table, TableCell, TableHeader, TableRow, TableView, updateColumns } from "@tiptap/extension-table";
import { Extension, findParentNode, type Editor } from "@tiptap/core";
import { CellSelection, TableMap, addRowBefore, addRowAfter, addColumnBefore, addColumnAfter, selectedRect } from "@tiptap/pm/tables";
import { closeHistory } from "@tiptap/pm/history";
import type { Command } from "@tiptap/pm/state";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { validateAndDeriveContent } from "../../../shared/content";
import { pointAnchor } from "../Popup";

export const tableContext = (editor: Editor) => findParentNode(node => node.type.name === "table")(editor.state.selection);
export function tableWidths(editor: Editor): number[] {
  const context = tableContext(editor); if (!context) return [];
  const dom = editor.view.nodeDOM(context.pos) as HTMLElement | null;
  const cells = dom?.querySelector("tr")?.children;
  return Array.from({ length: context.node.firstChild?.childCount ?? 0 }, (_, i) => Math.max(64, Math.min(2000, Math.round((cells?.[i] as HTMLElement | undefined)?.getBoundingClientRect().width ?? 120))));
}
export function setWidths(editor: Editor, widths: number[] | null, tablePos = tableContext(editor)?.pos) {
  if (tablePos === undefined || !editor.isEditable) return;
  const node = editor.state.doc.nodeAt(tablePos); if (!node || node.type.name !== "table") return;
  const tr = closeHistory(editor.state.tr).setNodeMarkup(tablePos, undefined, { ...node.attrs, widthMode: widths ? "fixed" : "fluid" });
  node.forEach((row, offset) => row.forEach((cell, cellOffset, index) => {
    tr.setNodeMarkup(tablePos + 2 + offset + cellOffset, undefined, { ...cell.attrs, colwidth: widths ? [Math.max(64, Math.min(2000, widths[index] ?? 120))] : null });
  }));
  editor.view.dispatch(tr);
}
export function belowTable(editor: Editor) {
  const context = tableContext(editor); if (!context) return;
  const end = context.pos + context.node.nodeSize;
  const tr = editor.state.tr;
  if (tr.doc.nodeAt(end)?.type.name !== "paragraph") tr.insert(end, editor.schema.nodes.paragraph!.create());
  tr.setSelection(TextSelection.create(tr.doc, end + 1)); editor.view.dispatch(tr); editor.view.focus();
}
export function beforeTable(editor: Editor) {
  const context = tableContext(editor); if (!context) return;
  const tr = closeHistory(editor.state.tr), previous = tr.doc.resolve(context.pos).nodeBefore;
  let pos = context.pos + 1;
  if (previous?.type.name === "paragraph") pos = context.pos - 1;
  else tr.insert(context.pos, editor.schema.nodes.paragraph!.create());
  tr.setSelection(TextSelection.create(tr.doc, pos)); editor.view.dispatch(tr); editor.view.focus();
}
export function clearCells(editor: Editor, axis?: "row" | "column") {
  if (!tableContext(editor)) return;
  const rect = selectedRect(editor.state);
  const cells: { pos: number; node: PMNode }[] = [];
  for (let row = axis === "column" ? 0 : rect.top; row < (axis === "column" ? rect.map.height : rect.bottom); row++) {
    for (let col = axis === "row" ? 0 : rect.left; col < (axis === "row" ? rect.map.width : rect.right); col++) {
      const offset = rect.map.map[row * rect.map.width + col]!;
      cells.push({ pos: rect.tableStart + offset, node: rect.table.nodeAt(offset)! });
    }
  }
  const tr = closeHistory(editor.state.tr);
  for (const { pos, node } of cells.sort((a, b) => b.pos - a.pos)) tr.replaceWith(pos + 1, pos + node.nodeSize - 1, editor.schema.nodes.paragraph!.create());
  editor.view.dispatch(tr);
}
function cellAttributes() {
  return {
    textAlign: { default: null, parseHTML: (el: HTMLElement) => ["left", "center", "right"].includes(el.style.textAlign) ? el.style.textAlign : null,
      renderHTML: (attrs: Record<string, unknown>) => attrs.textAlign ? { style: `text-align: ${attrs.textAlign}` } : {} },
    verticalAlign: { default: null, parseHTML: (el: HTMLElement) => ["top", "middle", "bottom"].includes(el.style.verticalAlign) ? el.style.verticalAlign : null,
      renderHTML: (attrs: Record<string, unknown>) => attrs.verticalAlign ? { style: `vertical-align: ${attrs.verticalAlign}` } : {} },
  };
}
const Cell = TableCell.extend({ content: "(paragraph | image)+", addAttributes() { return { ...this.parent?.(), ...cellAttributes() }; } });
const Header = TableHeader.extend({ content: "(paragraph | image)+", addAttributes() { return { ...this.parent?.(), ...cellAttributes() }; } });

class UranusTableView extends TableView {
  private cancelDrag: (() => void) | undefined;
  private appendRow: HTMLButtonElement;
  private appendColumn: HTMLButtonElement;
  private stage: HTMLDivElement;
  private handles: HTMLDivElement;
  private observer: ResizeObserver;
  private frame = 0;
  constructor(node: PMNode, private editor: Editor, private getPos: () => number | undefined, view: EditorView) {
    super(node, 64, view);
    this.stage = document.createElement("div"); this.stage.className = "table-stage";
    this.dom.appendChild(this.stage); this.stage.appendChild(this.table);
    this.handles = document.createElement("div"); this.handles.className = "table-handles"; this.handles.contentEditable = "false";
    this.stage.appendChild(this.handles);
    const add = (label: string, kind: "row" | "column") => {
      const button = document.createElement("button"); button.type = "button"; button.contentEditable = "false";
      button.textContent = "+"; button.title = label; button.setAttribute("aria-label", label); button.className = `table-add-${kind}`;
      button.onmousedown = event => event.preventDefault();
      button.onclick = () => {
        const pos = this.getPos(); if (pos === undefined || !editor.isEditable) return;
        const map = TableMap.get(this.node); const cell = map.map[map.map.length - 1]; if (cell === undefined) return;
        editor.commands.setTextSelection(pos + 3 + cell);
        if (kind === "row") editor.commands.addRowAfter(); else editor.commands.addColumnAfter();
        editor.view.focus();
      };
      this.stage.appendChild(button); return button;
    };
    this.appendRow = add("在表格底部追加一行", "row"); this.appendColumn = add("在表格右侧追加一列", "column");
    this.table.addEventListener("pointermove", this.hover);
    this.table.addEventListener("pointerdown", this.startDrag);
    this.table.addEventListener("contextmenu", this.contextMenu);
    this.dom.addEventListener("scroll", this.overflow);
    editor.on("selectionUpdate", this.active);
    this.observer = new ResizeObserver(() => this.layoutHandles());
    this.observer.observe(this.table);
    this.update(node);
    this.active();
  }
  private active = () => {
    const active = this.editor.isEditable && tableContext(this.editor)?.pos === this.getPos();
    this.dom.dataset.active = String(active);
    if (active && this.editor.state.selection instanceof CellSelection) {
      const rect = selectedRect(this.editor.state);
      this.dom.dataset.selectionLabel = "已选 " + (rect.bottom - rect.top) * (rect.right - rect.left) + " 个单元格";
    } else delete this.dom.dataset.selectionLabel;
  };
  private layoutHandles = () => {
    if (!this.editor.isEditable) { this.handles.replaceChildren(); delete this.handles.dataset.shape; return; }
    const rows = Array.from(this.table.rows); const cells = Array.from(rows[0]?.cells ?? []);
    const shape = `${rows.length}:${cells.length}`;
    if (this.handles.dataset.shape !== shape) {
      this.handles.dataset.shape = shape; this.handles.replaceChildren();
      const button = (label: string, className: string, action: () => void) => {
        const el = document.createElement("button"); el.type = "button"; el.className = className;
        el.title = label; el.setAttribute("aria-label", label);
        if (className.includes("insert") || className.includes("handle")) el.tabIndex = -1;
        el.innerHTML = className.includes("insert")
          ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>'
          : '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>';
        el.onmousedown = e => e.preventDefault(); el.onclick = action; this.handles.appendChild(el); return el;
      };
      const select = (axis: "row" | "column", index: number) => {
        const pos = this.getPos(); if (pos === undefined || !this.editor.isEditable) return false;
        const map = TableMap.get(this.node); const offset = map.map[axis === "row" ? index * map.width : index];
        if (offset === undefined) return false;
        const $cell = this.editor.state.doc.resolve(pos + 1 + offset);
        const selection = axis === "row" ? CellSelection.rowSelection($cell) : CellSelection.colSelection($cell);
        this.editor.view.dispatch(this.editor.state.tr.setSelection(selection)); return true;
      };
      const open = (kind: string, anchor: HTMLElement) => this.editor.view.dom.dispatchEvent(new CustomEvent("uranus-table-menu", { detail: { kind, anchor } }));
      const corner = button("表格菜单", "table-corner", () => {
        const pos = this.getPos(); if (pos === undefined || !this.editor.isEditable) return;
        if (tableContext(this.editor)?.pos !== pos) this.editor.commands.setTextSelection(pos + 3);
        open("more", corner);
      }); corner.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18M3 15h18"/></svg>';
      const cellMenu = button("单元格操作", "table-cell-menu", () => {
        const pos = this.getPos(); if (pos === undefined || !this.editor.isEditable) return;
        if (tableContext(this.editor)?.pos !== pos) this.editor.commands.setTextSelection(pos + 3);
        open("cell", cellMenu);
      }); cellMenu.textContent = "单元格";
      for (const axis of ["row", "column"] as const) {
        const count = axis === "row" ? rows.length : cells.length;
        for (let i = 0; i < count; i++) {
          const handle = button(`第 ${i + 1} ${axis === "row" ? "行" : "列"}菜单`, `table-${axis}-handle`, () => { if (select(axis, i)) open(axis, handle); });
          handle.dataset.index = String(i);
        }
        for (let i = 0; i <= count; i++) {
          const insert = button(`在第 ${i + 1} ${axis === "row" ? "行" : "列"}位置插入`, `table-insert-${axis}`, () => {
            if (!select(axis, Math.max(0, i - 1))) return;
            if (axis === "row") { if (i === 0) this.editor.commands.addRowBefore(); else this.editor.commands.addRowAfter(); }
            else { if (i === 0) this.editor.commands.addColumnBefore(); else this.editor.commands.addColumnAfter(); }
            this.editor.view.focus();
          }); insert.dataset.index = String(i);
        }
      }
    }
    this.handles.style.setProperty("--table-width", `${this.table.offsetWidth}px`);
    this.handles.style.setProperty("--table-height", `${this.table.offsetHeight}px`);
    this.handles.querySelectorAll<HTMLElement>("[data-index]").forEach(el => {
      const i = Number(el.dataset.index); const row = el.className.includes("row"); const items = row ? rows : cells;
      const item = items[i]; const last = items.at(-1); if (!last) return;
      const start = item ? (row ? item.offsetTop : item.offsetLeft) : (row ? last.offsetTop + last.offsetHeight : last.offsetLeft + last.offsetWidth);
      const center = el.className.includes("handle") && item ? (row ? item.offsetHeight : item.offsetWidth) / 2 : 0;
      el.style[row ? "top" : "left"] = `${start + center}px`;
    });
    this.overflow();
    this.active();
  };
  private overflow = () => {
    this.dom.dataset.overflowLeft = String(this.dom.scrollLeft > 2);
    this.dom.dataset.overflowRight = String(this.dom.scrollWidth - this.dom.clientWidth - this.dom.scrollLeft > 2);
  };
  private contextMenu = (event: MouseEvent) => {
    if (!this.editor.isEditable || (event.target as HTMLElement).closest(".resizable-image")) return;
    const cell = (event.target as HTMLElement).closest("td,th");
    if (!cell) return;
    const pos = this.editor.view.posAtDOM(cell, 0) - 1;
    const selection = this.editor.state.selection;
    let included = false;
    if (selection instanceof CellSelection) selection.forEachCell((_node, cellPos) => { if (cellPos === pos) included = true; });
    if (!included) this.editor.view.dispatch(this.editor.state.tr.setSelection(CellSelection.create(this.editor.state.doc, pos)));
    event.preventDefault();
    // Cell DOM can be replaced by setNodeMarkup (width/alignment). The table
    // node view is stable, so parameter subpanels survive their own updates.
    this.editor.view.dom.dispatchEvent(new CustomEvent("uranus-table-menu", { detail: { kind: "cell", anchor: pointAnchor(this.table, event.clientX, event.clientY) } }));
  };
  private boundary = (event: PointerEvent) => {
    const cell = (event.target as HTMLElement).closest("td,th") as HTMLTableCellElement | null;
    if (!cell || !this.table.contains(cell)) return null;
    const rect = cell.getBoundingClientRect();
    if (Math.abs(event.clientX - rect.right) <= 7) return cell.cellIndex;
    if (cell.cellIndex > 0 && Math.abs(event.clientX - rect.left) <= 7) return cell.cellIndex - 1;
    return null;
  };
  private hover = (event: PointerEvent) => { this.table.classList.toggle("resize-cursor", this.editor.isEditable && this.boundary(event) !== null); };
  private startDrag = (event: PointerEvent) => {
    const index = this.boundary(event); const pos = this.getPos();
    if (index === null || pos === undefined || !this.editor.isEditable || event.button !== 0 || event.pointerType === "touch") return;
    event.preventDefault(); this.cancelDrag?.();
    const widths = Array.from(this.table.rows[0]?.cells ?? []).map(cell => Math.max(64, Math.round(cell.getBoundingClientRect().width)));
    const start = widths[index] ?? 120; const startX = event.clientX;
    const hint = document.createElement("output"); hint.className = "column-width-hint"; document.body.appendChild(hint);
    const move = (e: PointerEvent) => {
      widths[index] = Math.max(64, Math.min(2000, Math.round(start + e.clientX - startX)));
      for (let i = 0; i < widths.length; i++) (this.colgroup.children[i] as HTMLElement).style.width = `${widths[i]}px`;
      this.table.style.width = `${widths.reduce((a, b) => a + b, 0)}px`;
      hint.textContent = widths[index] + " px"; hint.style.left = Math.min(innerWidth - 90, e.clientX + 12) + "px"; hint.style.top = Math.max(8, e.clientY - 32) + "px";
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", commit);
      window.removeEventListener("pointercancel", cancel); window.removeEventListener("blur", cancel); window.removeEventListener("keydown", key);
      this.cancelDrag = undefined;
      hint.remove();
    };
    const cancel = () => { cleanup(); this.update(this.node); };
    const commit = () => { cleanup(); setWidths(this.editor, widths, pos); this.update(this.node); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") cancel(); };
    this.cancelDrag = cancel;
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", commit);
    window.addEventListener("pointercancel", cancel); window.addEventListener("blur", cancel); window.addEventListener("keydown", key);
  };
  override update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    this.node = node; updateColumns(node, this.colgroup, this.table, 64);
    const count = node.firstChild?.childCount ?? 1;
    this.table.style.minWidth = `${count * 64}px`;
    if (node.attrs.widthMode !== "fixed") this.table.style.width = "100%";
    this.stage.style.width = node.attrs.widthMode === "fixed" ? this.table.style.width : "100%";
    this.appendRow.hidden = this.appendColumn.hidden = !this.editor.isEditable;
    cancelAnimationFrame(this.frame); this.frame = requestAnimationFrame(this.layoutHandles);
    return true;
  }
  stopEvent(event: Event) { return (event.target as HTMLElement).closest("button") !== null; }
  destroy() { cancelAnimationFrame(this.frame); this.observer.disconnect(); this.cancelDrag?.(); this.editor.off("selectionUpdate", this.active); this.table.removeEventListener("pointermove", this.hover); this.table.removeEventListener("pointerdown", this.startDrag); this.table.removeEventListener("contextmenu", this.contextMenu); this.dom.removeEventListener("scroll", this.overflow); }
}
const UranusTable = Table.extend({
  addAttributes() { return { widthMode: { default: "fluid", parseHTML: (el: HTMLElement) => el.dataset.widthMode === "fixed" ? "fixed" : "fluid", renderHTML: (attrs: Record<string, unknown>) => ({ "data-width-mode": attrs.widthMode }) } }; },
  addNodeView() { return ({ node, editor, getPos, view }) => new UranusTableView(node, editor, getPos, view); },
  addCommands() {
    const insert = (command: Command, axis: "row" | "column", after: boolean): Command => (state, dispatch) => {
      const context = findParentNode(node => node.type.name === "table")(state.selection); if (!context) return false;
      const rect = selectedRect(state);
      const insertion = axis === "row" ? (after ? rect.bottom : rect.top) : (after ? rect.right : rect.left);
      return command(state, dispatch ? tr => {
        const next = tr.doc.nodeAt(context.pos); if (!next) return;
        const newMap = TableMap.get(next);
        const oldMap = TableMap.get(context.node);
        const length = axis === "row" ? newMap.width : newMap.height;
        for (let i = 0; i < length; i++) {
          const row = axis === "row" ? insertion : i; const col = axis === "column" ? insertion : i;
          const sourceRow = axis === "row" ? Math.max(0, Math.min(oldMap.height - 1, insertion - 1)) : row;
          const sourceCol = axis === "column" ? Math.max(0, Math.min(oldMap.width - 1, insertion - 1)) : col;
          const source = context.node.nodeAt(oldMap.map[sourceRow * oldMap.width + sourceCol]!);
          const target = newMap.map[row * newMap.width + col];
          if (!source || target === undefined) continue;
          const attrs = { ...source.attrs };
          if (axis === "row" && source.type.name === "tableHeader") { attrs.textAlign = null; attrs.align = null; }
          tr.setNodeMarkup(context.start + target, axis === "row" ? state.schema.nodes.tableCell : source.type, attrs);
        }
        dispatch(tr);
      } : undefined);
    };
    return { ...this.parent?.(),
      addRowBefore: () => ({ state, dispatch }) => insert(addRowBefore, "row", false)(state, dispatch),
      addRowAfter: () => ({ state, dispatch }) => insert(addRowAfter, "row", true)(state, dispatch),
      addColumnBefore: () => ({ state, dispatch }) => insert(addColumnBefore, "column", false)(state, dispatch),
      addColumnAfter: () => ({ state, dispatch }) => insert(addColumnAfter, "column", true)(state, dispatch),
    };
  },
  addKeyboardShortcuts() {
    const clear = () => {
      if (!(this.editor.state.selection instanceof CellSelection)) return false;
      const tr = closeHistory(this.editor.state.tr); const cells: { pos: number; node: PMNode }[] = [];
      this.editor.state.selection.forEachCell((node, pos) => cells.push({ pos, node }));
      for (const { node, pos } of cells.reverse()) tr.replaceWith(pos + 1, pos + node.nodeSize - 1, this.editor.schema.nodes.paragraph!.create());
      this.editor.view.dispatch(tr); return true;
    };
    return { ...this.parent?.(), Delete: clear, Backspace: clear, "Mod-Delete": clear, "Mod-Backspace": clear };
  },
}).configure({ resizable: false, cellMinWidth: 64, renderWrapper: true });
const Budget = Extension.create({
  name: "contentBudget",
  addProseMirrorPlugins() { return [new Plugin({ filterTransaction: tr => {
    if (!tr.docChanged) return true;
    try { validateAndDeriveContent(tr.doc.toJSON()); return true; }
    catch (error) { window.dispatchEvent(new CustomEvent("uranus-editor-error", { detail: (error as Error).message })); return false; }
  } })]; },
});
export const tableExtensions = [UranusTable, TableRow, Cell, Header, Budget];
