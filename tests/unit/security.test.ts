import { describe, expect, it } from "vitest";
import { createSession, verifySession } from "../../worker/middleware/auth";
import type { Env } from "../../worker/types";

const base = {
  DB: {} as D1Database, UPLOADS: {} as R2Bucket,
  LOGIN_RATE_LIMITER: { limit: async () => ({ success: true }) },
  API_TOKEN: "a".repeat(32), SESSION_SECRET: "b".repeat(32), APP_ENV: "development" as const,
} satisfies Env;

describe("signed session", () => {
  it("accepts a valid session and rejects tampering", async () => {
    const { token, payload } = await createSession(base);
    expect((await verifySession(base, token))?.sid).toBe(payload.sid);
    expect(await verifySession(base, `${token.slice(0, -1)}x`)).toBeNull();
  });

  it("invalidates sessions after session secret or API token rotation", async () => {
    const { token } = await createSession(base);
    expect(await verifySession({ ...base, SESSION_SECRET: "c".repeat(32) }, token)).toBeNull();
    expect(await verifySession({ ...base, API_TOKEN: "d".repeat(32) }, token)).toBeNull();
  });
});
