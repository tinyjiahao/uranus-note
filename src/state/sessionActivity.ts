import { identity } from "./identity";
// Only real foreground interaction can make a successful business request active.
let lastInteraction = 0;
let nextAttempt = 0;
let owner = "";
let pending: Promise<void> | undefined;

export function installSessionActivity() {
  const mark = (event: Event) => {
    if (event.isTrusted && document.visibilityState === "visible") {
      const current = identity();
      if (!current.userId) return;
      const key = `${current.userId}:${current.epoch}`;
      if (owner !== key) { owner = key; nextAttempt = 0; }
      lastInteraction = Date.now();
    }
  };
  const events = ["pointerdown", "keydown", "input", "wheel", "touchmove"];
  events.forEach(name => document.addEventListener(name, mark, { passive: true, capture: true }));
  return () => { events.forEach(name => document.removeEventListener(name, mark, true)); lastInteraction = 0; };
}

export function afterActiveRequest(userId: string, renew: () => Promise<number>) {
  if (owner !== userId) { owner = userId; nextAttempt = 0; lastInteraction = 0; }
  const now = Date.now();
  if (pending || now < nextAttempt || !lastInteraction || now - lastInteraction > 60_000 || document.visibilityState !== "visible") return;
  lastInteraction = 0;
  nextAttempt = now + 60_000;
  pending = renew().then(() => {
    if (owner === userId) nextAttempt = Date.now() + 60 * 60 * 1000;
  }).catch(() => { /* Transient renewal failure is not a failed note save. */ }).finally(() => { pending = undefined; });
}

export function waitForSessionActivity() { return pending ?? Promise.resolve(); }
