import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { CellSelection, TableMap, selectedRect } from "@tiptap/pm/tables";
import { belowTable, setWidths, tableContext, tableWidths } from "./tables";

export function TablePicker({ editor, close }: { editor: Editor; close: () => void }) {
  const [rows, setRows] = useState(2); const [cols, setCols] = useState(2); const [header, setHeader] = useState(true);
  const picker = useRef<HTMLDivElement>(null);
  useEffect(() => { picker.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, []);
  const insert = (r = rows, c = cols) => { editor.chain().focus().insertTable({ rows: r, cols: c, withHeaderRow: header }).run(); close(); };
  return <div className="table-picker" ref={picker} role="group" aria-label="插入表格" onKeyDown={e => { if (e.key === "Escape") { close(); editor.commands.focus(); } }}>
    <div className="table-grid">{Array.from({ length: 36 }, (_, i) => <button key={i} aria-label={`${Math.floor(i / 6) + 1} 行 ${i % 6 + 1} 列`} onClick={() => insert(Math.floor(i / 6) + 1, i % 6 + 1)}>{Math.floor(i / 6) + 1}×{i % 6 + 1}</button>)}</div>
    <label>行 <input aria-label="表格行数" type="number" min="1" max="6" value={rows} onChange={e => setRows(Math.max(1, Math.min(6, Number(e.target.value) || 1)))} /></label>
    <label>列 <input aria-label="表格列数" type="number" min="1" max="6" value={cols} onChange={e => setCols(Math.max(1, Math.min(6, Number(e.target.value) || 1)))} /></label>
    <label><input type="checkbox" checked={header} onChange={e => setHeader(e.target.checked)} />表头</label>
    <button onClick={() => insert()}>插入</button><button onClick={close}>取消</button>
  </div>;
}
export function TableTools({ editor, readOnly }: { editor: Editor; readOnly: boolean }) {
  const [, refresh] = useState(0); const [menu, setMenu] = useState(""); const [width, setWidth] = useState(120); const [message, setMessage] = useState("");
  const popup = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<{ kind: string; anchor: HTMLElement }>).detail;
      anchor.current = detail.anchor;
      const rect = detail.anchor.getBoundingClientRect();
      setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 304)), top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 340)) });
      setWidth(tableWidths(editor)[selectedRect(editor.state).left] ?? 120); setMessage(""); setMenu(detail.kind);
    };
    editor.view.dom.addEventListener("uranus-table-menu", open);
    return () => editor.view.dom.removeEventListener("uranus-table-menu", open);
  }, [editor]);
  useLayoutEffect(() => { if (menu) popup.current?.focus({ preventScroll: true }); }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: Event) => { if (!popup.current?.contains(event.target as Node) && !anchor.current?.contains(event.target as Node)) setMenu(""); };
    const scroll = (event: Event) => { if (!popup.current?.contains(event.target as Node)) setMenu(""); };
    document.addEventListener("pointerdown", outside); window.addEventListener("scroll", scroll, true); window.addEventListener("resize", scroll);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("scroll", scroll, true); window.removeEventListener("resize", scroll); };
  }, [menu]);
  useEffect(() => { const update = () => { refresh(v => v + 1); if (!tableContext(editor)) setMenu(""); }; editor.on("transaction", update); return () => { editor.off("transaction", update); }; }, [editor]);
  useEffect(() => { if (readOnly) setMenu(""); }, [readOnly]);
  const table = tableContext(editor);
  if (!table || readOnly || !menu) return null;
  const selection = editor.state.selection;
  const map = TableMap.get(table.node);
  let cellPos = selection.$from.before(selection.$from.depth);
  for (let depth = selection.$from.depth; depth > 0; depth--) if (["tableCell", "tableHeader"].includes(selection.$from.node(depth).type.name)) { cellPos = selection.$from.before(depth); break; }
  if (selection instanceof CellSelection) cellPos = selection.$anchorCell.pos;
  const relative = cellPos - table.start;
  const index = map.map.indexOf(relative) % map.width;
  const attrs: Record<string, unknown>[] = [];
  if (selection instanceof CellSelection) selection.forEachCell(node => attrs.push({ ...node.attrs, textAlign: node.attrs.textAlign ?? node.attrs.align ?? (node.type.name === "tableHeader" ? "center" : "left") }));
  else { const cell = editor.state.doc.nodeAt(cellPos); if (cell) attrs.push({ ...cell.attrs, textAlign: cell.attrs.textAlign ?? cell.attrs.align ?? (cell.type.name === "tableHeader" ? "center" : "left") }); }
  const mixed = (key: string, fallback: string) => new Set(attrs.map(a => a[key] ?? fallback)).size > 1 ? "mixed" : String(attrs[0]?.[key] ?? fallback);
  const run = (action: () => unknown) => { action(); setMenu(""); editor.view.focus(); };
  const remove = (kind: "row" | "column" | "table") => {
    const rect = selection instanceof CellSelection ? map.rectBetween(selection.$anchorCell.pos - table.start, selection.$headCell.pos - table.start) : null;
    const all = kind === "table" || (kind === "row" && (map.height === 1 || rect && rect.bottom - rect.top === map.height)) || (kind === "column" && (map.width === 1 || rect && rect.right - rect.left === map.width));
    if (all && table.node.textContent.trim() && !confirm("删除整张非空表格？可通过撤销恢复。")) return;
    run(() => all ? editor.commands.deleteTable() : kind === "row" ? editor.commands.deleteRow() : editor.commands.deleteColumn());
    setMessage("已删除，可使用工具栏撤销");
  };
  const menuButton = (key: string, label: string) => <button aria-expanded={menu === key} onClick={() => { if (key === "more") setWidth(tableWidths(editor)[index] ?? 120); setMenu(menu === key ? "" : key); }}>{label}</button>;
  return createPortal(<div ref={popup} tabIndex={-1} style={position} className="table-context-menu" role="dialog" aria-label="表格操作" onMouseDown={e => { if ((e.target as HTMLElement).closest("button")) e.preventDefault(); }} onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setMenu(""); anchor.current?.focus(); } }}>
    <header><strong>{menu === "row" ? "行操作" : menu === "column" ? "列操作" : "表格操作"}</strong><button aria-label="关闭表格菜单" onClick={() => { setMenu(""); anchor.current?.focus(); }}>关闭</button></header>
    <div className="table-menu-tabs">{menuButton("row", "行")}{menuButton("column", "列")}{menuButton("align", "对齐")}{menuButton("more", "更多")}</div>
    <button onClick={() => run(() => belowTable(editor))}>在表格下方继续输入</button>
    {message && <span role="status">{message}</span>}
    {menu && <div className="table-menu">
      {menu === "row" && <><button onClick={() => run(() => editor.commands.addRowBefore())}>上方插行</button><button onClick={() => run(() => editor.commands.addRowAfter())}>下方插行</button><button onClick={() => remove("row")}>删除所选行</button></>}
      {menu === "column" && <><button onClick={() => run(() => editor.commands.addColumnBefore())}>左侧插列</button><button onClick={() => run(() => editor.commands.addColumnAfter())}>右侧插列</button><button onClick={() => remove("column")}>删除所选列</button></>}
      {menu === "align" && <><label>水平 <select aria-label="水平对齐" value={mixed("textAlign", "left")} onChange={e => editor.commands.setCellAttribute("textAlign", e.target.value)}><option value="mixed" disabled>混合</option><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></label><label>垂直 <select aria-label="垂直对齐" value={mixed("verticalAlign", "top")} onChange={e => editor.commands.setCellAttribute("verticalAlign", e.target.value)}><option value="mixed" disabled>混合</option><option value="top">顶部</option><option value="middle">居中</option><option value="bottom">底部</option></select></label></>}
      {menu === "more" && <>
        <label>当前列宽 <input aria-label="当前列宽" type="number" min="64" max="2000" value={width} onChange={e => setWidth(Number(e.target.value))} /></label>
        <button disabled={index < 0 || !Number.isFinite(width) || width < 64 || width > 2000} onClick={() => run(() => { const widths = tableWidths(editor); widths[index] = width; setWidths(editor, widths); })}>应用列宽</button>
        <button onClick={() => run(() => setWidths(editor, null))}>恢复自适应</button>
        <button onClick={() => run(() => setWidths(editor, tableWidths(editor)))}>按列宽显示</button>
        <button onClick={() => run(() => { const widths = tableWidths(editor); setWidths(editor, widths.map(() => Math.max(64, Math.round(widths.reduce((a, b) => a + b, 0) / widths.length)))); })}>平均分配列宽</button>
        <button onClick={() => run(() => editor.commands.toggleHeaderRow())}>表头开关</button>
        <button onClick={() => remove("row")}>删除所选行</button><button onClick={() => remove("column")}>删除所选列</button><button onClick={() => remove("table")}>删除表格</button>
      </>}
    </div>}
  </div>, document.body);
}
