import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { emailSchema, normalizeEmail, normalizeUsername, passwordSchema, registrationSchema, usernameSchema } from "../../shared/account";
import { hashPassword, verifyPassword } from "../../worker/lib/password";
import { base64url, fromBase64url } from "../../worker/lib/crypto";
import { issueAccountSession, readAccountSession, revokeAccountSession, sessionWriteBatch, expireAccountSessions } from "../../worker/services/accountSessions";

const secret = "account-session-test-secret-at-least-32-bytes";
const testPassword = " test-only-password 😀 ";

async function insertUser(id = crypto.randomUUID()) {
  const hash = await hashPassword(testPassword);
  await env.DB.prepare(`INSERT INTO uranus_users
    (id,email,email_normalized,username,username_normalized,password_algorithm,password_iterations,password_salt,password_hash,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(id, `${id}@example.com`, `${id}@example.com`, id, id,
      hash.password_algorithm, hash.password_iterations, hash.password_salt, hash.password_hash, Date.now(), Date.now()).run();
  return id;
}

describe("v6 shared input contract", () => {
  it("normalizes identifiers without merging distinct email addresses", () => {
    expect(normalizeEmail(" Alice+tag@Example.com ")).toBe("alice+tag@example.com");
    expect(normalizeUsername(" E\u0301lodie ")).toBe("élodie");
    expect(emailSchema.safeParse("用户@example.com").success).toBe(false);
    expect(emailSchema.safeParse("not-an-email").success).toBe(false);
    expect(usernameSchema.safeParse(" ").success).toBe(false);
    expect(usernameSchema.safeParse("ab\u0000cd").success).toBe(false);
    expect(usernameSchema.safeParse("😀".repeat(32)).success).toBe(true);
    expect(usernameSchema.safeParse("😀".repeat(33)).success).toBe(false);
  });
  it("counts Unicode code points and does not transform passwords", () => {
    for (const length of [8, 128]) expect(passwordSchema.parse("😀".repeat(length))).toBe("😀".repeat(length));
    for (const password of ["😀".repeat(7), "😀".repeat(129), " ".repeat(8)]) expect(passwordSchema.safeParse(password).success).toBe(false);
    expect(passwordSchema.parse(testPassword)).toBe(testPassword);
    const input = { email: "a@example.com", username: " Alice ", password: testPassword, confirmPassword: testPassword };
    expect(registrationSchema.parse(input).username).toBe("Alice");
    expect(registrationSchema.safeParse({ ...input, confirmPassword: testPassword.trim() }).success).toBe(false);
    expect(registrationSchema.safeParse({ ...input, username: " ADMIN " }).success).toBe(false);
    expect(registrationSchema.safeParse({ ...input, user_id: "forged" }).success).toBe(false);
  });
});

describe("v6 password records", () => {
  it("salts independently and verifies exact passwords", async () => {
    const a = await hashPassword(testPassword), b = await hashPassword(testPassword);
    expect(a.password_iterations).toBe(10000);
    expect(a.password_salt).not.toBe(b.password_salt);
    expect(a.password_hash).not.toBe(b.password_hash);
    expect(await verifyPassword(testPassword, a)).toBe(true);
    expect(await verifyPassword(testPassword.trim(), a)).toBe(false);
    expect(await verifyPassword(testPassword, null)).toBe(false);
    expect(await verifyPassword(testPassword, { ...a, password_iterations: 1 })).toBe(false);
    expect(await verifyPassword(testPassword, { ...a, password_iterations: 100001 })).toBe(false);
    expect(await verifyPassword(testPassword, { ...a, password_salt: "malformed" })).toBe(false);
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(testPassword), "PBKDF2", false, ["deriveBits"]);
    const upgraded = { ...a, password_iterations: 10001, password_hash: base64url(new Uint8Array(await crypto.subtle.deriveBits({
      name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(fromBase64url(a.password_salt)), iterations: 10001,
    }, key, 256))) };
    expect(await verifyPassword(testPassword, upgraded)).toBe(true);
    expect(await verifyPassword(testPassword, { ...upgraded, password_iterations: 10000 })).toBe(false);
  });
});

describe("v6 server session foundation (not wired to public routes yet)", () => {
  it("stores only a digest, rejects tampering and secret rotation, and revokes on the server", async () => {
    const id = await insertUser();
    const issued = await issueAccountSession(env.DB, secret, id, 1);
    const session = await readAccountSession(env.DB, secret, issued.token);
    expect(session?.user.id).toBe(id);
    const row = await env.DB.prepare("SELECT * FROM uranus_sessions WHERE user_id=?").bind(id).first();
    expect(JSON.stringify(row)).not.toContain(issued.token.split(".")[0]);
    expect(await readAccountSession(env.DB, `${secret}-rotated`, issued.token)).toBeNull();
    expect(await readAccountSession(env.DB, secret, `${issued.token}x`)).toBeNull();
    expect(issued.ttl).toBe(86400);
    await revokeAccountSession(env.DB, session!);
    expect(await readAccountSession(env.DB, secret, issued.token)).toBeNull();
    await expireAccountSessions(env.DB);
    expect(await env.DB.prepare("SELECT * FROM uranus_sessions WHERE user_id=?").bind(id).first()).toBeNull();
  });
  it("rejects stale password-version login, expires sessions and caps TTL at 30 days", async () => {
    const id = await insertUser();
    const issued = await issueAccountSession(env.DB, secret, id, 1, "999999999");
    expect(issued.ttl).toBe(2592000);
    await env.DB.prepare("UPDATE uranus_users SET credential_version=2 WHERE id=?").bind(id).run();
    expect(await readAccountSession(env.DB, secret, issued.token)).toBeNull();
    await expect(issueAccountSession(env.DB, secret, id, 1)).rejects.toMatchObject({ code: "CREDENTIALS_CHANGED" });
    const next = await issueAccountSession(env.DB, secret, id, 2);
    await env.DB.prepare("UPDATE uranus_sessions SET expires_at=0 WHERE user_id=?").bind(id).run();
    expect(await readAccountSession(env.DB, secret, next.token)).toBeNull();
  });
  it("serializes revocation with writes and leaves no guard rows", async () => {
    const id = await insertUser();
    const issued = await issueAccountSession(env.DB, secret, id, 1);
    const session = (await readAccountSession(env.DB, secret, issued.token))!;
    const change = (name: string) => env.DB.prepare("UPDATE uranus_users SET username=? WHERE id=?").bind(name, id);
    await sessionWriteBatch(env.DB, session, [change("Before revocation")]);
    await revokeAccountSession(env.DB, session);
    await expect(sessionWriteBatch(env.DB, session, [change("After revocation")])).rejects.toMatchObject({ status: 401 });
    expect((await env.DB.prepare("SELECT username FROM uranus_users WHERE id=?").bind(id).first())?.username).toBe("Before revocation");
    expect((await env.DB.prepare("SELECT count(*) AS n FROM uranus_session_write_guards").first())?.n).toBe(0);
  });
  it("blocks protected writes during freeze, without blocking logout", async () => {
    const id = await insertUser();
    const issued = await issueAccountSession(env.DB, secret, id, 1);
    const session = (await readAccountSession(env.DB, secret, issued.token))!;
    await env.DB.prepare("UPDATE uranus_runtime_state SET mode='frozen' WHERE id=1").run();
    try {
      await expect(sessionWriteBatch(env.DB, session, [env.DB.prepare("UPDATE uranus_users SET username='no' WHERE id=?").bind(id)]))
        .rejects.toMatchObject({ code: "MAINTENANCE_MODE" });
      await expect(issueAccountSession(env.DB, secret, id, 1)).rejects.toMatchObject({ code: "CREDENTIALS_CHANGED" });
      await revokeAccountSession(env.DB, session);
    } finally {
      await env.DB.prepare("UPDATE uranus_runtime_state SET mode='normal' WHERE id=1").run();
    }
  });
  it("rolls back earlier writes and guard rows when a later statement fails", async () => {
    const id = await insertUser();
    const issued = await issueAccountSession(env.DB, secret, id, 1);
    const session = (await readAccountSession(env.DB, secret, issued.token))!;
    await expect(sessionWriteBatch(env.DB, session, [
      env.DB.prepare("UPDATE uranus_users SET username='rolled back' WHERE id=?").bind(id),
      env.DB.prepare("UPDATE uranus_users SET credential_version=0 WHERE id=?").bind(id),
    ])).rejects.toThrow();
    expect((await env.DB.prepare("SELECT username FROM uranus_users WHERE id=?").bind(id).first())?.username).toBe(id);
    expect((await env.DB.prepare("SELECT count(*) n FROM uranus_session_write_guards").first())?.n).toBe(0);
  });
  it("enforces normalized uniqueness and the capacity constraint inside D1", async () => {
    // Each test file has isolated storage; remove earlier fixture users only.
    await env.DB.prepare("DELETE FROM uranus_users").run();
    const id = await insertUser();
    await expect(env.DB.prepare(`INSERT INTO uranus_users SELECT 'duplicate',email,email_normalized,username,
      username_normalized,password_algorithm,password_iterations,password_salt,password_hash,
      credential_version,disabled,created_at,updated_at FROM uranus_users WHERE id=?`).bind(id).run()).rejects.toThrow();
    const copy = (suffix: string) => env.DB.prepare(`INSERT INTO uranus_users
      SELECT ?,?, ?,?,?,password_algorithm,password_iterations,password_salt,password_hash,
        credential_version,disabled,created_at,updated_at FROM uranus_users WHERE id=?`)
      .bind(suffix, `${suffix}@example.com`, `${suffix}@example.com`, suffix, suffix, id);
    await env.DB.batch(Array.from({ length: 98 }, (_, i) => copy(`capacity-${i}`)));
    const attempts = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => copy(`racing-${i}`).run()));
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM uranus_users").first())?.n).toBe(100);
    await expect(copy("overflow").run()).rejects.toThrow("REGISTRATION_CAPACITY_REACHED");
  });
});
