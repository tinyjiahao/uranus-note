import { afterEach, expect, it, vi } from "vitest";
import { NoteSaveQueue } from "../../src/state/saveQueue";
import { patchNote } from "../../src/api/client";
import type { NoteDetail } from "../../shared/dto";

vi.mock("../../src/api/client", () => ({ patchNote: vi.fn(), uuidv7: () => crypto.randomUUID() }));
vi.mock("../../src/state/drafts", () => ({ deleteDraftIfSequence: vi.fn(async () => undefined), putDraft: vi.fn(async () => true) }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("does not regress a confirmed revision when a stale blur callback runs", async () => {
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  vi.mocked(patchNote).mockImplementation(async (_id, revision) => ({ note: { id: 1, revision: revision + 1 } as NoteDetail, operation_id: "test", applied_revision: revision + 1 }));
  const queue = new NoteSaveQueue(1, 1, () => undefined);
  queue.enqueue({ starred: true }, 60_000);
  await queue.flush();
  queue.updateRevision(1);
  queue.enqueue({ starred: false }, 60_000);
  await queue.flush();
  expect(vi.mocked(patchNote).mock.calls.map(call => call[1])).toEqual([1, 2]);
  expect(queue.hasUnsaved()).toBe(false);
});
