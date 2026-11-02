import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

// V9-07: Mod-C with an empty selection copies the caret's text block (or the
// physical line inside a code block) as plain text plus a trailing newline.
export const CopyLine = Extension.create({
  name: "copyLine",
  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey("copyLine"),
      props: {
        handleKeyDown: (view, event) => {
          if (event.isComposing || view.composing) return false;
          if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return false;
          if (event.key.toLowerCase() !== "c") return false;
          const { selection } = view.state;
          if (!selection.empty) return false;
          const $from = selection.$from;
          let text: string;
          if ($from.parent.type.name === "codeBlock") {
            const content = $from.parent.textContent;
            const rel = Math.max(0, selection.from - $from.start());
            const lineStart = content.lastIndexOf("\n", rel - 1) + 1;
            const lineEnd = content.indexOf("\n", rel);
            text = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd) + "\n";
          } else {
            text = $from.parent.textContent + "\n";
          }
          if (text === "\n") return false;
          void navigator.clipboard?.writeText(text).catch(() => {});
          return true;
        },
      },
    })];
  },
});
