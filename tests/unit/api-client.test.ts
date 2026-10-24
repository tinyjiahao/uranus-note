import { afterEach, expect, it, vi } from "vitest";
import { createFolder, setCsrfToken, uploadAttachment } from "../../src/api/client";

afterEach(() => { vi.unstubAllGlobals(); setCsrfToken(""); });

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
