import type { Editor } from "@tiptap/core";
import { useMemo, useSyncExternalStore } from "react";
import { Popup, type PopupAnchor } from "../Popup";
export function headings(editor: Editor) {
  const result: { position: number; level: number; text: string }[] = [];
  editor.state.doc.descendants((node, position) => { if (node.type.name === "heading") result.push({ position, level: Number(node.attrs.level), text: node.textContent || "空标题" }); });
  return result;
}
export function OutlinePopup({ editor, anchor, close }: { editor: Editor; anchor: PopupAnchor; close: () => void }) {
  const subscribe = useMemo(() => (listener: () => void) => { editor.on("transaction", listener); return () => { editor.off("transaction", listener); }; }, [editor]);
  useSyncExternalStore(subscribe, () => editor.state);
  return <Popup anchor={anchor} title="笔记大纲" close={close} restoreFocus={() => editor.view.focus()}>
    {headings(editor).map(heading => <button key={heading.position} style={{ paddingLeft: heading.level * 12 }} onClick={() => { if (editor.view.composing) return; editor.commands.setTextSelection(heading.position + 1); editor.commands.focus(); const node = editor.view.nodeDOM(heading.position); if (node instanceof HTMLElement) node.scrollIntoView({ block: "center" }); close(); }}>{heading.text}</button>)}
  </Popup>;
}
