// Canonical persisted values; arbitrary CSS never enters the content schema.
export const TEXT_COLORS = [
  "#292a2e", "#1858bc", "#206a83", "#216e4e", "#4c6b1f", "#7f5f01", "#974f0c", "#ae2e24", "#943d73", "#803fa5",
  "#7d818a", "#357de8", "#2898b8", "#1f9d6b", "#6a9a23", "#b38600", "#e66c00", "#c9372c", "#cd519d", "#b15bdf",
  "#ffffff", "#cce0ff", "#c6edfb", "#baf3db", "#d3f1a7", "#f8e88d", "#fce4a6", "#ffd5d2", "#fdd0ec", "#eed7fc",
] as const;
export const HIGHLIGHT_COLORS = ["#dcdfe4", ...TEXT_COLORS.slice(21)] as readonly string[];
export function isTextColor(value: unknown): value is string { return typeof value === "string" && (TEXT_COLORS as readonly string[]).includes(value); }
export function isHighlightColor(value: unknown): value is string { return typeof value === "string" && HIGHLIGHT_COLORS.includes(value); }
// Browsers expose style colors as rgb() even when HTML was serialized as hex.
export function parsePaletteColor(value: string, highlight = false): string | null {
  let color = value.trim().toLowerCase();
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(color);
  if (rgb) color = "#" + rgb.slice(1).map(part => Number(part).toString(16).padStart(2, "0")).join("");
  return (highlight ? isHighlightColor(color) : isTextColor(color)) ? color : null;
}
