let userId: string | null = null;
let epoch = 0;
export const identityTabId = crypto.randomUUID();
const requests = new Set<AbortController>();
export const identity = () => ({ userId, epoch });
export function activateIdentity(next: string | null) {
  if (next === userId) return;
  for (const controller of requests) controller.abort();
  requests.clear(); userId = next; epoch++;
}
export function trackRequest(controller: AbortController) { requests.add(controller); return () => requests.delete(controller); }
export function lockIdentity(broadcast = false) {
  for (const controller of requests) controller.abort();
  requests.clear(); userId = null; epoch++;
  if (typeof window !== "undefined") window.dispatchEvent(new Event("uranus-session-expired"));
  if (broadcast && typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel("uranus-account-change"); channel.postMessage({ sender: identityTabId }); channel.close();
  }
}
export function notifyAccountChange() {
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel("uranus-account-change"); channel.postMessage({ sender: identityTabId }); channel.close();
  }
}
export const identityMatches = (expected: { userId: string | null; epoch: number }) => expected.userId === userId && expected.epoch === epoch;
