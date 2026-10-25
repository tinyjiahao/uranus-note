import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { CellSelection, selectedRect } from "@tiptap/pm/tables";
import { NodeSelection } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import { belowTable, beforeTable, clearCells, setWidths, tableContext, tableWidths } from "./tables";
import { Popup, type PopupAnchor } from "../Popup";
import { validateAndDeriveContent } from "../../../shared/content";

export function TablePicker({ editor, close, anchor, range }: { editor: Editor; close: () => void; anchor: PopupAnchor; range?: { from: number; to: number } | undefined }) {
  const [rows, setRows] = useState("2"), [cols, setCols] = useState("2"), [header, setHeader] = useState(true);
  const [preview, setPreview] = useState([2, 2]), [custom, setCustom] = useState(false), [error, setError] = useState("");
  const grid = useRef<HTMLDivElement>(null);
  const committing = useRef(false);
  const closeRef = useRef(close); closeRef.current = close;
  useEffect(() => {
    const update = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (transaction.docChanged && !committing.current) { closeRef.current(); window.dispatchEvent(new CustomEvent("uranus-editor-error", { detail: "正文已变化，请重新选择表格插入位置。" })); }
    };
    editor.on("transaction", update); return () => { editor.off("transaction", update); };
  }, [editor]);
  const r = Number(rows), c = Number(cols);
  const valid = Number.isInteger(r) && r >= 1 && r <= 100 && Number.isInteger(c) && c >= 1 && c <= 30;
  const insert = (row = r, col = c) => {
    if (!editor.isEditable || tableContext(editor)) return;
    committing.current = true;
    try {
      const chain = editor.chain();
      if (range) chain.deleteRange(range);
      chain.insertTable({ rows: row, cols: col, withHeaderRow: header });
      if (chain.command(({ tr }) => { validateAndDeriveContent(tr.doc.toJSON()); closeHistory(tr); return true; }).run()) { close(); editor.view.focus(); }
    } catch (cause) { setError((cause as Error).message); }
    finally { committing.current = false; }
  };
  return <Popup anchor={anchor} title="插入表格" close={close} restoreFocus={() => editor.view.focus()} className="table-picker" back={custom ? () => setCustom(false) : undefined}>
    {!custom ? <>
      <p aria-live="polite">{preview[0]} 行 × {preview[1]} 列</p>
      <div ref={grid} className="table-grid" role="grid" aria-label="表格尺寸" onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        const index = Number((event.target as HTMLElement).dataset.index);
        const delta = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -6, ArrowDown: 6 } as Record<string, number>)[event.key];
        if (delta !== undefined) { event.preventDefault(); grid.current?.querySelector<HTMLButtonElement>('[data-index="' + Math.max(0, Math.min(35, index + delta)) + '"]')?.focus(); }
      }}>{Array.from({ length: 36 }, (_, i) => {
        const row = Math.floor(i / 6) + 1, col = i % 6 + 1;
        return <button key={i} data-index={i} data-initial-focus={i === 7 ? "" : undefined} tabIndex={row === preview[0] && col === preview[1] ? 0 : -1} aria-label={row + " 行 " + col + " 列"} className={row <= preview[0]! && col <= preview[1]! ? "chosen" : ""} onFocus={() => setPreview([row, col])} onPointerEnter={() => setPreview([row, col])} onClick={() => insert(row, col)} />;
      })}</div>
      <button aria-haspopup="true" onClick={() => setCustom(true)}>自定义尺寸…</button>
    </> : <>
      <label>行数<input aria-label="表格行数" type="number" min="1" max="100" value={rows} onChange={e => setRows(e.target.value)} /></label>
      <label>列数<input aria-label="表格列数" type="number" min="1" max="30" value={cols} onChange={e => setCols(e.target.value)} /></label>
      <p>1—100 行、1—30 列；必须为整数。</p>
      {!valid && <p role="alert">请输入范围内的正整数。</p>}
      <button disabled={!valid} onClick={() => insert()}>插入</button>
    </>}
    <label><input type="checkbox" checked={header} onChange={e => setHeader(e.target.checked)} />包含表头（计入总行数）</label>
    {error && <p role="alert">{error}</p>}
  </Popup>;
}

export type ObjectMenuEvent = { kind: string; anchor: PopupAnchor };
export function TableTools({ editor, readOnly }: { editor: Editor; readOnly: boolean }) {
  const [, refresh] = useState(0), [target, setTarget] = useState<ObjectMenuEvent | null>(null), [panel, setPanel] = useState(""), [width, setWidth] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const executing = useRef(false);
  const openTarget = useRef(false);
  const close = () => { openTarget.current = false; setTarget(null); setPanel(""); setHistory([]); };
  useEffect(() => {
    const open = (event: Event) => { if (!editor.isEditable) return; const detail = (event as CustomEvent<ObjectMenuEvent>).detail; openTarget.current = true; setTarget(detail); setPanel(detail.kind); setHistory([]); setWidth(""); };
    const update = ({ transaction }: { transaction: { docChanged: boolean; selectionSet: boolean } }) => {
      refresh(v => v + 1);
      if (!executing.current && (transaction.docChanged || transaction.selectionSet)) {
        if (openTarget.current && transaction.docChanged) window.dispatchEvent(new CustomEvent("uranus-editor-error", { detail: "目标内容已变化，菜单已关闭，请重新选择。" }));
        close();
      }
    };
    editor.view.dom.addEventListener("uranus-table-menu", open); editor.on("transaction", update);
    return () => { editor.view.dom.removeEventListener("uranus-table-menu", open); editor.off("transaction", update); };
  }, [editor]);
  useEffect(() => { if (readOnly) close(); }, [readOnly]);
  if (!target || readOnly) return null;
  const context = tableContext(editor);
  const image = editor.state.selection instanceof NodeSelection && editor.state.selection.node.type.name === "image";
  if (!context && !image) return null;
  const rect = context ? selectedRect(editor.state) : null;
  const rowCount = rect ? rect.bottom - rect.top : 0, colCount = rect ? rect.right - rect.left : 0;
  const rangeLabel = (axis: "row" | "column") => {
    if (!rect) return "";
    const start = axis === "row" ? rect.top : rect.left, end = axis === "row" ? rect.bottom : rect.right;
    return "第 " + (start + 1) + (end > start + 1 ? "—" + end : "") + (axis === "row" ? " 行" : " 列");
  };
  const act = (action: () => unknown, keep = false) => {
    executing.current = true;
    try { editor.view.dispatch(closeHistory(editor.state.tr)); action(); editor.view.dispatch(closeHistory(editor.state.tr)); }
    finally { executing.current = false; }
    if (!keep) { close(); editor.view.focus(); } else refresh(v => v + 1);
  };
  const go = (next: string) => { setHistory(previous => [...previous, panel]); setPanel(next); if (next === "width" && rect) { const widths = tableWidths(editor).slice(rect.left, rect.right); setWidth(new Set(widths).size === 1 ? String(widths[0]) : ""); } };
  const remove = (kind: "row" | "column" | "table") => {
    if (!context || !rect) return;
    const all = kind === "table" || kind === "row" && rowCount === rect.map.height || kind === "column" && colCount === rect.map.width;
    let hasImage = false; context.node.descendants(node => { if (node.type.name === "image") hasImage = true; });
    if (all && (context.node.textContent.trim() || hasImage) && !confirm("删除整张非空表格？可通过撤销恢复。")) return;
    act(() => all ? editor.commands.deleteTable() : kind === "row" ? editor.commands.deleteRow() : editor.commands.deleteColumn());
  };
  const attrs: Record<string, unknown>[] = [], selection = editor.state.selection;
  if (selection instanceof CellSelection) selection.forEachCell(node => attrs.push({ ...node.attrs, textAlign: node.attrs.textAlign ?? (node.type.name === "tableHeader" ? "center" : "left") }));
  else if (rect) { const node = rect.table.nodeAt(rect.map.map[rect.top * rect.map.width + rect.left]!); if (node) attrs.push({ ...node.attrs, textAlign: node.attrs.textAlign ?? (node.type.name === "tableHeader" ? "center" : "left") }); }
  const mixed = (key: string, fallback: string) => new Set(attrs.map(a => a[key] ?? fallback)).size > 1 ? "mixed" : String(attrs[0]?.[key] ?? fallback);
  const title = panel === "row" ? rangeLabel("row") : panel === "column" || panel === "width" ? rangeLabel("column") : panel === "image" ? "图片操作" : panel === "align" || panel === "cell" ? "已选 " + rowCount * colCount + " 个单元格" : "表格操作";
  return <Popup anchor={target.anchor} title={title} close={close} restoreFocus={() => editor.view.focus()} back={history.length ? () => { setPanel(history.at(-1)!); setHistory(history.slice(0, -1)); } : undefined}>
    {panel === "row" && <>
      <button onClick={() => act(() => editor.commands.addRowBefore())}>上方插行</button><button onClick={() => act(() => editor.commands.addRowAfter())}>下方插行</button>
      <button onClick={() => act(() => clearCells(editor, "row"))}>清空所选行内容</button><hr /><button className="danger" onClick={() => remove("row")}>删除 {rowCount} 行</button>
    </>}
    {panel === "column" && <>
      <button onClick={() => act(() => editor.commands.addColumnBefore())}>左侧插列</button><button onClick={() => act(() => editor.commands.addColumnAfter())}>右侧插列</button>
      <button aria-haspopup="true" onClick={() => go("width")}>调整列宽…</button><button onClick={() => act(() => clearCells(editor, "column"))}>清空所选列内容</button><hr /><button className="danger" onClick={() => remove("column")}>删除 {colCount} 列</button>
    </>}
    {panel === "cell" && <>
      <button aria-haspopup="true" onClick={() => go("row")}>行操作 ›</button><button aria-haspopup="true" onClick={() => go("column")}>列操作 ›</button><button aria-haspopup="true" onClick={() => go("align")}>单元格对齐 ›</button>
      <button onClick={() => act(() => clearCells(editor))}>清空所选格</button><button aria-haspopup="true" onClick={() => go("more")}>表格操作 ›</button>
    </>}
    {panel === "width" && <>
      <label>{colCount > 1 ? "应用到所选 " + colCount + " 列（px）" : rangeLabel("column") + "宽度（px）"}<input aria-label="当前列宽" type="number" min="64" max="2000" placeholder="混合值" value={width} onChange={e => setWidth(e.target.value)} /></label>
      <p>64—2000 px；仅修改所选列。</p><button disabled={!Number.isInteger(Number(width)) || Number(width) < 64 || Number(width) > 2000} onClick={() => act(() => { const widths = tableWidths(editor); for (let i = rect!.left; i < rect!.right; i++) widths[i] = Number(width); setWidths(editor, widths); }, true)}>应用列宽</button>
    </>}
    {panel === "align" && <>
      {([['textAlign', '单元格水平对齐', ['left', 'center', 'right'], ['左', '中', '右'], 'left'], ['verticalAlign', '单元格垂直对齐', ['top', 'middle', 'bottom'], ['上', '中', '下'], 'top']] as const).map(([key, label, values, labels, fallback]) => <div key={key} role="group" aria-label={label}><p>{label}{mixed(key, fallback) === "mixed" ? " · 混合" : ""}</p><div className="segmented">{values.map((value, i) => <button key={value} aria-label={label + "：" + labels[i]} aria-pressed={mixed(key, fallback) === value} onClick={() => act(() => editor.commands.setCellAttribute(key, value), true)}>{labels[i]}</button>)}</div></div>)}
      <p>有独立对齐的内容保持原设置。</p>
    </>}
    {panel === "more" && <>
      <button onClick={() => act(() => { editor.commands.setTextSelection(context!.start + rect!.map.map.at(-1)! + 2); editor.commands.addRowAfter(); })}>追加一行</button>
      <button onClick={() => act(() => { editor.commands.setTextSelection(context!.start + rect!.map.map.at(-1)! + 2); editor.commands.addColumnAfter(); })}>追加一列</button>
      <button onClick={() => act(() => editor.commands.toggleHeaderRow())}>表头开关</button>
      <button onClick={() => act(() => setWidths(editor, null))}>恢复自适应</button><button onClick={() => act(() => setWidths(editor, tableWidths(editor)))}>按列宽显示</button>
      <button onClick={() => act(() => { const widths = tableWidths(editor); setWidths(editor, widths.map(() => Math.max(64, Math.round(widths.reduce((a, b) => a + b, 0) / widths.length)))); })}>平均分配整表列宽</button>
      <button onClick={() => act(() => beforeTable(editor))}>在表格上方继续输入</button><button onClick={() => act(() => belowTable(editor))}>在表格下方继续输入</button><hr /><button className="danger" onClick={() => remove("table")}>删除表格</button>
    </>}
    {panel === "image" && <>
      {(["left", "center", "right"] as const).map((value, i) => <button key={value} aria-pressed={editor.getAttributes("image").imageAlign === value} onClick={() => act(() => editor.commands.updateAttributes("image", { imageAlign: value }), true)}>图片{["左对齐", "居中", "右对齐"][i]}</button>)}
      <button onClick={() => act(() => editor.commands.updateAttributes("image", { imageAlign: null }), true)}>恢复默认对齐</button>
      {context && <button aria-haspopup="true" onClick={() => go("more")}>表格操作 ›</button>}
      <hr /><button className="danger" onClick={() => act(() => editor.commands.deleteSelection())}>移除图片</button>
    </>}
  </Popup>;
}
