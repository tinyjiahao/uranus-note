import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

type SearchState = { query: string; active: number; ranges: Array<{ from: number; to: number }>; decorations: DecorationSet };
export const searchHighlightKey = new PluginKey<SearchState>("uranus-search-highlight");

function fold(value: string) {
  let text = "", original = 0;
  const starts: number[] = [], ends: number[] = [];
  for (const point of value) {
    const lowered = point.toLowerCase();
    text += lowered;
    for (let index = 0; index < lowered.length; index++) { starts.push(original); ends.push(original + point.length); }
    original += point.length;
  }
  return { text, starts, ends };
}

function build(doc: Parameters<typeof DecorationSet.create>[0], query: string, active: number): SearchState {
  const ranges: Array<{ from: number; to: number }> = [];
  const needle = fold(query).text;
  if (needle) doc.descendants((node, position) => {
    if (!node.isTextblock) return;
    let value = "";
    const pieces: Array<{ offset: number; from: number; length: number }> = [];
    node.descendants((child, childPosition) => {
      if (!child.isText || !child.text) return;
      pieces.push({ offset: value.length, from: position + 1 + childPosition, length: child.text.length });
      value += child.text;
      return false;
    });
    const folded = fold(value), haystack = folded.text;
    let offset = 0;
    while ((offset = haystack.indexOf(needle, offset)) >= 0) {
      const originalStart = folded.starts[offset] ?? offset;
      const originalEnd = folded.ends[offset + needle.length - 1] ?? originalStart;
      const first = pieces.find(piece => originalStart >= piece.offset && originalStart < piece.offset + piece.length);
      const endOffset = originalEnd;
      const last = [...pieces].reverse().find(piece => endOffset > piece.offset && endOffset <= piece.offset + piece.length);
      if (first && last) ranges.push({ from: first.from + originalStart - first.offset, to: last.from + endOffset - last.offset });
      offset += Math.max(needle.length, 1);
    }
    return false;
  });
  const normalizedActive = ranges.length && active >= 0 ? ((active % ranges.length) + ranges.length) % ranges.length : -1;
  const decorations = DecorationSet.create(doc, ranges.map((range, index) => Decoration.inline(range.from, range.to, { class: index === normalizedActive ? "search-hit search-hit-current" : "search-hit" })));
  return { query, active: normalizedActive, ranges, decorations };
}

export const SearchHighlight = Extension.create({
  name: "searchHighlight",
  addProseMirrorPlugins() {
    return [new Plugin<SearchState>({
      key: searchHighlightKey,
      state: {
        init: (_, state) => build(state.doc, "", 0),
        apply: (transaction, previous) => {
          const meta = transaction.getMeta(searchHighlightKey) as { query?: string; active?: number } | undefined;
          if (meta || transaction.docChanged) return build(transaction.doc, meta?.query ?? previous.query, meta?.active ?? previous.active);
          return previous;
        },
      },
      props: { decorations: (state) => searchHighlightKey.getState(state)?.decorations ?? null },
    })];
  },
});

export function updateEditorSearch(editor: Editor, query: string, active: number) {
  const previous = searchHighlightKey.getState(editor.state);
  if (editor.view.composing || (!query && !previous?.query)) return previous?.ranges.length ?? 0;
  editor.view.dispatch(editor.state.tr.setMeta(searchHighlightKey, { query, active }));
  const state = searchHighlightKey.getState(editor.state);
  const range = state?.ranges[state.active];
  if (range) {
    const tr = editor.state.tr;
    const $match = tr.doc.resolve(range.from);
    for (let depth = $match.depth; depth > 0; depth--) {
      if ($match.node(depth).type.name === "codeBlock") tr.setMeta("uranus-reveal-code", $match.before(depth));
    }
    editor.view.dispatch(tr.setSelection(TextSelection.create(editor.state.doc, range.from, range.to)).scrollIntoView());
    // At a text/decorated boundary domAtPos can return the whole code block.
    // Scroll the actual match, not its potentially very tall parent.
    const element = editor.view.dom.querySelector(".search-hit-current");
    element?.scrollIntoView({ block: "center", inline: "center" });
  }
  return state?.ranges.length ?? 0;
}
