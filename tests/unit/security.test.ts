import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { initializeTestAccount } from "../accountFixture";
import { issueAccountSession, readAccountSession } from "../../worker/services/accountSessions";
beforeAll(initializeTestAccount);
it("rejects tampering and signing-key rotation", async () => {
  const user = await env.DB.prepare("SELECT id,credential_version FROM uranus_users LIMIT 1").first<{ id: string; credential_version: number }>();
  const issued = await issueAccountSession(env.DB, env.SESSION_SECRET, user!.id, user!.credential_version);
  expect((await readAccountSession(env.DB, env.SESSION_SECRET, issued.token))?.user.id).toBe(user!.id);
  expect(await readAccountSession(env.DB, env.SESSION_SECRET, issued.token + "x")).toBeNull();
  expect(await readAccountSession(env.DB, "different-secret".repeat(4), issued.token)).toBeNull();
});
