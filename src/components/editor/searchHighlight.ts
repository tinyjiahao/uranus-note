import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

type SearchState = { query: string; active: number; ranges: Array<{ from: number; to: number }>; decorations: DecorationSet };
export const searchHighlightKey = new PluginKey<SearchState>("uranus-search-highlight");

function build(doc: Parameters<typeof DecorationSet.create>[0], query: string, active: number): SearchState {
  const ranges: Array<{ from: number; to: number }> = [];
  const needle = query.toLocaleLowerCase();
  if (needle) doc.descendants((node, position) => {
    if (!node.isText || !node.text) return;
    const haystack = node.text.toLocaleLowerCase();
    let offset = 0;
    while ((offset = haystack.indexOf(needle, offset)) >= 0) {
      ranges.push({ from: position + offset, to: position + offset + needle.length });
      offset += Math.max(needle.length, 1);
    }
  });
  const normalizedActive = ranges.length ? ((active % ranges.length) + ranges.length) % ranges.length : 0;
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
  editor.view.dispatch(editor.state.tr.setMeta(searchHighlightKey, { query, active }));
  const state = searchHighlightKey.getState(editor.state);
  const range = state?.ranges[state.active];
  if (range) editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, range.from, range.to)).scrollIntoView());
  return state?.ranges.length ?? 0;
}
