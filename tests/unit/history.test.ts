import { expect, it } from "vitest";
import { emptyHistory, reconcileHistory } from "../../src/state/history";
it("reconciles app moves, native POP, duplicate PUSH and replacement", () => {
  let h = emptyHistory();
  for (const [url, key] of [["/", "root"], ["/notes/1", "a"], ["/notes/2", "b"], ["/notes/3", "c"]]) h = reconcileHistory(h, url!, key!, "PUSH");
  h = reconcileHistory(h, "/notes/2", "back-b", "PUSH", 2);
  h = reconcileHistory(h, "/notes/1", "back-a", "PUSH", 1);
  expect(h.pos).toBe(1); expect(h.stack).toHaveLength(4);
  h = reconcileHistory(h, "/notes/2", "forward-b", "PUSH", 2);
  expect(h.pos).toBe(2);
  h = reconcileHistory(h, "/notes/1", "back-a", "POP"); expect(h.pos).toBe(1);
  h = reconcileHistory(h, "/notes/4", "d", "PUSH"); expect(h.stack.map(x => x.url)).toEqual(["/", "/notes/1", "/notes/4"]);
  // An ordinary link to an adjacent location is still a new PUSH.
  h = reconcileHistory(h, "/notes/1", "new-a", "PUSH"); expect(h.pos).toBe(3);
  h = reconcileHistory(h, "/", "replace", "REPLACE"); expect(h.stack[3]?.url).toBe("/"); expect(h.stack[3]?.keys).toEqual(["replace"]);
  expect(emptyHistory().stack).toEqual([]);
});
