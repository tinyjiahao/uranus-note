import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { activateIdentity } from "../../src/state/identity";
beforeEach(() => activateIdentity("test-user"));
import { createFolder, listNotes, setCsrfToken, uploadAttachment } from "../../src/api/client";

afterEach(() => { vi.unstubAllGlobals(); setCsrfToken(""); });

it("loads the notes list with a query signal when AbortSignal.any is unavailable", async () => {
  vi.stubGlobal("AbortSignal", {});
  const fetchMock = vi.fn(async (_path: string, init: RequestInit) => {
    expect(init.signal?.aborted).toBe(false);
    return Response.json({ items: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  await expect(listNotes({ folderId: 42 }, 1, new AbortController().signal)).resolves.toEqual({ items: [] });
  expect(fetchMock.mock.calls[0]?.[0]).toContain("folder_id=42");
});

it.each(["caller", "account"] as const)("cancels a notes request when the %s cancels", async source => {
  const caller = new AbortController();
  vi.stubGlobal("fetch", vi.fn((_path: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init.signal!;
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  })));
  const rejected = expect(listNotes({}, 1, caller.signal)).rejects.toMatchObject({ name: "AbortError" });
  if (source === "caller") caller.abort();
  else activateIdentity("other-user");
  await rejected;
});

it("lets fetch set multipart headers while retaining CSRF and cookies", async () => {
  const fetchMock = vi.fn(async (_path: unknown, init?: RequestInit) => {
    expect(new Headers(init?.headers).has("Content-Type")).toBe(false);
    expect(new Headers(init?.headers).get("X-CSRF-Token")).toBe("test-csrf");
    expect(init?.credentials).toBe("same-origin");
    expect(init?.body).toBeInstanceOf(FormData);
    expect((init?.body as FormData).get("note_id")).toBe("1");
    return Response.json({ id: "test-attachment" });
  });
  vi.stubGlobal("fetch", fetchMock); setCsrfToken("test-csrf");
  await uploadAttachment(1, new File(["test"], "test.png", { type: "image/png" }));
  expect(fetchMock).toHaveBeenCalledOnce();
});

it("still sends JSON requests with the JSON content type", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_path: unknown, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({ name: "test" });
    return Response.json({ id: 1 });
  }));
  await createFolder("test");
});

it("rejects a late response even when an underlying transport ignores abort", async () => {
  let release!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { release = resolve; })));
  const pending = createFolder("old-user-folder");
  const rejected = expect(pending).rejects.toMatchObject({ code: "IDENTITY_CHANGED" });
  activateIdentity("new-user");
  release(Response.json({ id: 7, name: "old-user-folder" }));
  await rejected;
});
