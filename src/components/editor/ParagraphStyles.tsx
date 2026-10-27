import type { Editor } from "@tiptap/core";
import { Popup, type PopupAnchor } from "../Popup";

export function paragraphStyle(editor: Editor) {
  if (editor.isActive("heading")) return `标题 ${editor.getAttributes("heading").level}`;
  if (editor.isActive("codeBlock")) return "代码块";
  return editor.isActive("small") ? "小号文本" : "普通文本";
}
export function ParagraphStyles({ editor, anchor, close }: { editor: Editor; anchor: PopupAnchor; close: () => void }) {
  const levels = [1, 2, 3, 4, 5, 6] as const;
  const blocked = editor.isActive("codeBlock") || editor.isActive("code");
  const apply = (kind: "normal" | "small" | typeof levels[number]) => {
    if (!editor.isEditable || editor.view.composing) return;
    const chain = editor.chain().focus();
    if (typeof kind === "number") {
      chain.command(({ tr, state }) => {
        state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
          if (node.isTextblock) tr.removeMark(pos + 1, pos + node.nodeSize - 1, state.schema.marks.small!);
        });
        return true;
      }).unsetMark("small").setHeading({ level: kind }).run();
    } else if (kind === "small") chain.setParagraph().setMark("small").run();
    else chain.setParagraph().unsetMark("small", { extendEmptyMarkRange: true }).run();
    close();
  };
  const current = paragraphStyle(editor);
  return <Popup className="paragraph-styles-popup" anchor={anchor} title="段落样式" close={close} restoreFocus={() => editor.view.focus()}>
    <button aria-pressed={current === "普通文本"} disabled={!editor.isActive("paragraph") && !editor.can().setParagraph()} onClick={() => apply("normal")}><span className="paragraph-style-icon" aria-hidden="true">T</span><span>普通文本</span></button>
    <button aria-pressed={current === "小号文本"} disabled={blocked || (!editor.isActive("paragraph") && !editor.can().setParagraph())} onClick={() => apply("small")}><span className="paragraph-style-icon" aria-hidden="true">Tₛ</span><span>小号文本</span></button>
    {levels.map(level => <button key={level} aria-pressed={current === `标题 ${level}`} disabled={!editor.can().setHeading({ level })} onClick={() => apply(level)}><span className="paragraph-style-icon" aria-hidden="true">H{level}</span><span style={{ fontSize: `${24 - level * 2}px`, fontWeight: 650 }}>标题 {level}</span></button>)}
  </Popup>;
}
