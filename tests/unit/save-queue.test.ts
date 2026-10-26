import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { putDraft, deleteDraftIfSequence } from "../../src/state/drafts";
import type { ContentNode } from "../../shared/dto";
import { NoteSaveQueue } from "../../src/state/saveQueue";
import { activateIdentity } from "../../src/state/identity";
import { patchNote } from "../../src/api/client";
import type { NoteDetail } from "../../shared/dto";

vi.mock("../../src/api/client", () => ({ patchNote: vi.fn(), uuidv7: () => crypto.randomUUID() }));
vi.mock("../../src/state/drafts", () => ({ deleteDraftIfSequence: vi.fn(async () => undefined), putDraft: vi.fn(async () => true) }));
beforeEach(() => {
  activateIdentity("queue-user");
  vi.useFakeTimers();
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  vi.mocked(putDraft).mockResolvedValue(true);
  vi.mocked(patchNote).mockImplementation(async (_id, revision) => ({ note: { id: 1, revision: revision + 1 } as NoteDetail, operation_id: "test", applied_revision: revision + 1 }));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetAllMocks(); });
const content = (text: string): ContentNode => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

it("an empty cleanup flush cannot immediately sync subsequent edits", async () => {
  const queue = new NoteSaveQueue(1, 1, () => {});
  const cleanup = queue.flush();
  queue.enqueue({ content: content("typed after mount") });
  await cleanup;
  await vi.advanceTimersByTimeAsync(800);
  expect(putDraft).toHaveBeenCalled();
  expect(patchNote).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(29_200);
  expect(patchNote).toHaveBeenCalledTimes(1);
});

it("stops old-account retries and retains its own draft after switching identities", async () => {
  const report = vi.fn();
  const queue = new NoteSaveQueue(1, 1, report);
  queue.enqueue({ content: content("private A") });
  activateIdentity("another-user");
  queue.dispose();
  report.mockClear();
  await vi.advanceTimersByTimeAsync(60_000);
  await queue.flush();
  expect(patchNote).not.toHaveBeenCalled();
  expect(putDraft).toHaveBeenCalledWith(expect.objectContaining({ noteId: 1 }), "queue-user");
  expect(report).not.toHaveBeenCalled();
});

it("persists at 800ms but syncs at 30s without postponing on new input", async () => {
  const report = vi.fn();
  const queue = new NoteSaveQueue(1, 1, report);
  queue.enqueue({ content: content("first") });
  await vi.advanceTimersByTimeAsync(799);
  expect(putDraft).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(putDraft).toHaveBeenCalledTimes(1);
  expect(report.mock.lastCall?.[3].localSaved).toBe(true);
  expect(patchNote).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(20_000);
  queue.enqueue({ content: content("latest") });
  await vi.advanceTimersByTimeAsync(9200);
  expect(patchNote).toHaveBeenCalledTimes(1);
  expect(vi.mocked(patchNote).mock.calls[0]?.[2].content).toEqual(content("latest"));
  expect(queue.hasUnsaved()).toBe(false);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(patchNote).toHaveBeenCalledTimes(1);
});

it("writes a local draft every three seconds during uninterrupted typing", async () => {
  const queue = new NoteSaveQueue(1, 1, () => {});
  for (let i = 0; i < 12; i++) {
    queue.enqueue({ content: content(String(i)) });
    await vi.advanceTimersByTimeAsync(500);
  }
  expect(putDraft).toHaveBeenCalledTimes(2);
  expect(patchNote).not.toHaveBeenCalled();
});

it("local blur persistence does not sync; interval updates and explicit flush work", async () => {
  const queue = new NoteSaveQueue(1, 1, () => {});
  queue.enqueue({ content: content("local") });
  await queue.persistLocal();
  expect(putDraft).toHaveBeenCalled();
  expect(patchNote).not.toHaveBeenCalled();
  queue.setSyncInterval(5000);
  await vi.advanceTimersByTimeAsync(5000);
  expect(patchNote).toHaveBeenCalledTimes(1);
  queue.enqueue({ content: content("shortcut") });
  await queue.flush();
  expect(patchNote).toHaveBeenCalledTimes(2);
});

it("keeps newer edits local while a periodic request is running", async () => {
  let resolve!: (value: Awaited<ReturnType<typeof patchNote>>) => void;
  vi.mocked(patchNote).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const queue = new NoteSaveQueue(1, 1, () => {});
  queue.enqueue({ content: content("first") });
  await vi.advanceTimersByTimeAsync(30_000);
  queue.enqueue({ content: content("second") });
  await vi.advanceTimersByTimeAsync(800);
  const latestSequence = vi.mocked(putDraft).mock.lastCall![0].editSequence;
  resolve({ note: { id: 1, revision: 2 } as NoteDetail, operation_id: "test", applied_revision: 2 });
  await vi.advanceTimersByTimeAsync(0);
  expect(patchNote).toHaveBeenCalledTimes(1);
  expect(deleteDraftIfSequence).not.toHaveBeenCalledWith(1, latestSequence);
  expect(vi.mocked(putDraft).mock.lastCall![0].baseRevision).toBe(2);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(patchNote).toHaveBeenCalledTimes(2);
});

it("retries network failures online with the same operation and revision", async () => {
  vi.mocked(patchNote).mockRejectedValue(new Error("offline"));
  const queue = new NoteSaveQueue(1, 1, () => {});
  queue.enqueue({ content: content("offline") });
  await vi.advanceTimersByTimeAsync(33_000);
  const first = vi.mocked(patchNote).mock.calls[0]!;
  expect(patchNote).toHaveBeenCalledTimes(4);
  vi.mocked(patchNote).mockResolvedValue({ note: { id: 1, revision: 2 } as NoteDetail, operation_id: "test", applied_revision: 2 });
  queue.retryOnline();
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.mocked(patchNote).mock.lastCall?.[4]).toBe(first[4]);
  expect(queue.hasUnsaved()).toBe(false);
});

it("does not automatically retry conflicts or authentication failures", async () => {
  for (const status of [409, 401]) {
    vi.mocked(patchNote).mockClear();
    vi.mocked(patchNote).mockRejectedValue(Object.assign(new Error("blocked"), { status }));
    const queue = new NoteSaveQueue(status, 1, () => {});
    queue.enqueue({ content: content("blocked") });
    await vi.advanceTimersByTimeAsync(30_000);
    queue.retryOnline();
    queue.enqueue({ content: content("new edit") });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(patchNote).toHaveBeenCalledTimes(1);
  }
});

it("does not report a failed local write as saved", async () => {
  vi.mocked(putDraft).mockRejectedValue(new Error("quota"));
  const report = vi.fn();
  const queue = new NoteSaveQueue(1, 1, report);
  queue.enqueue({ content: content("quota") });
  await vi.advanceTimersByTimeAsync(800);
  expect(report.mock.lastCall?.[3]).toMatchObject({ localSaved: false, localError: true });
  await vi.advanceTimersByTimeAsync(29_200);
  expect(patchNote).toHaveBeenCalledTimes(1);
});

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
