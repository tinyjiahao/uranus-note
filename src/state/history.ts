export type NavigationHistory = { stack: { url: string; keys: string[] }[]; pos: number };
export const emptyHistory = (): NavigationHistory => ({ stack: [], pos: -1 });
export function reconcileHistory(history: NavigationHistory, url: string, key: string, action: "POP" | "PUSH" | "REPLACE", move?: number): NavigationHistory {
  const { stack, pos } = history;
  if (stack[pos]?.keys.includes(key)) return history;
  if (action === "REPLACE" && pos >= 0) return { stack: stack.map((entry, i) => i === pos ? { url, keys: [key] } : entry), pos };
  const known = action === "POP" ? stack.findIndex(entry => entry.keys.includes(key)) : -1;
  const target = known >= 0 ? known : action === "PUSH" && move !== undefined && Math.abs(move - pos) === 1 && stack[move]?.url === url ? move : -1;
  if (target >= 0) return { stack: stack.map((entry, i) => i === target ? { ...entry, keys: [...entry.keys, key] } : entry), pos: target };
  return { stack: [...stack.slice(0, pos + 1), { url, keys: [key] }], pos: pos + 1 };
}
