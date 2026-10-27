import { Mark, type Editor } from "@tiptap/core";
import Highlight from "@tiptap/extension-highlight";
import { Check, RotateCcw, Eraser } from "lucide-react";
import { useState } from "react";
import { TEXT_COLORS, HIGHLIGHT_COLORS, parsePaletteColor } from "../../../shared/textColors";
import { Popup, type PopupAnchor } from "../Popup";

export const TextColor = Mark.create({
  name: "textColor",
  addAttributes: () => ({ color: { default: null, rendered: false } }),
  parseHTML: () => [{ style: "color", getAttrs: value => { const color = parsePaletteColor(value); return color ? { color } : false; } }],
  renderHTML: ({ mark }) => ["span", { style: `color: ${parsePaletteColor(String(mark.attrs.color)) ?? "inherit"}` }, 0],
});
export const ColoredHighlight = Highlight.extend({
  addAttributes: () => ({ color: {
    default: null,
    parseHTML: element => parsePaletteColor(element.getAttribute("data-color") ?? element.style.backgroundColor, true),
    renderHTML: attrs => {
      const color = parsePaletteColor(String(attrs.color), true);
      return color ? { "data-color": color, style: `background-color: ${color}; color: inherit` } : {};
    },
  } }),
}).configure({ multicolor: true });

const names = ["灰色", "蓝色", "青色", "绿色", "浅绿色", "黄色", "橙色", "红色", "粉色", "紫色"];
export function TextColorsPopup({ editor, anchor, close }: { editor: Editor; anchor: PopupAnchor; close: () => void }) {
  const [, render] = useState(0);
  const apply = (kind: "textColor" | "highlight", color?: string) => {
    if (editor.view.composing || !editor.isEditable) return;
    // Keep keyboard focus in the palette; commands use the preserved editor selection.
    const command = editor.chain();
    if (color) command.setMark(kind, { color }).run(); else command.unsetMark(kind).run();
    render(value => value + 1);
  };
  return <Popup className="text-colors-popup" anchor={anchor} title="文本颜色与突出显示" close={close} restoreFocus={() => editor.view.focus()}>
    <h3>文本颜色</h3>
    <div className="text-color-palette" role="group" aria-label="文本颜色">{TEXT_COLORS.map((color, index) => <button key={color} style={{ backgroundColor: color }} aria-label={`${["深", "标准", "浅"][Math.floor(index / 10)]}${names[index % 10]}`} aria-pressed={editor.getAttributes("textColor").color === color} onClick={() => apply("textColor", color)}>{editor.getAttributes("textColor").color === color && <Check style={{ color: index < 20 ? "white" : "#292a2e" }} />}</button>)}</div>
    <button className="secondary color-reset-button" onClick={() => apply("textColor")}><RotateCcw aria-hidden="true" />默认文本颜色</button>
    <h3>突出显示颜色</h3>
    <div className="text-color-palette" role="group" aria-label="突出显示颜色">{HIGHLIGHT_COLORS.map((color, index) => <button key={color} style={{ backgroundColor: color, color: "#1858bc" }} aria-label={names[index]} aria-pressed={editor.getAttributes("highlight").color === color} onClick={() => apply("highlight", color)}>{editor.getAttributes("highlight").color === color ? <Check style={{ color: "#292a2e" }} /> : "A"}</button>)}</div>
    <button className="secondary color-reset-button" onClick={() => apply("highlight")}><Eraser aria-hidden="true" />清除突出显示</button>
  </Popup>;
}
