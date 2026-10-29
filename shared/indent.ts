export const MAX_INDENT = 6;
export const isIndentLevel = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_INDENT;
