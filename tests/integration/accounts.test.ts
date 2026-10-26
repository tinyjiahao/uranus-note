import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { hashPassword } from "../../worker/lib/password";
import { authenticateAccount, changeAccountEmail, changeAccountPassword, registerAccount, renameAccount } from "../../worker/services/accounts";
import { issueAccountSession, readAccountSession } from "../../worker/services/accountSessions";

const secret = "accounts-tests-only-session-secret-32-bytes";
const password = "test-password-😀";
const input = (name: string) => ({ email: `${name}@example.com`, username: name, password, confirmPassword: password });

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM uranus_account_state").run();
  await env.DB.prepare("DELETE FROM uranus_folders WHERE user_id IS NOT NULL").run();
  await env.DB.prepare("DELETE FROM uranus_users").run();
  const hash = await hashPassword(password);
  await env.DB.prepare(`INSERT INTO uranus_users
    (id,email,email_normalized,username,username_normalized,password_algorithm,password_iterations,password_salt,password_hash,created_at,updated_at)
    VALUES('default-owner','admin@example.com','admin@example.com','admin','admin',?,?,?,?,0,0)`)
    .bind(hash.password_algorithm, hash.password_iterations, hash.password_salt, hash.password_hash).run();
  // A fixture marker, not a production initialization shortcut.
  await env.DB.prepare("INSERT INTO uranus_account_state(id,default_user_id,ownership_ready) VALUES(1,'default-owner',1)").run();
});

async function sessionFor(id: string) {
  const issued = await issueAccountSession(env.DB, secret, id, 1);
  return { issued, session: (await readAccountSession(env.DB, secret, issued.token))! };
}

it("requires explicit registration enablement and completed initialization", async () => {
  await expect(registerAccount(env.DB, undefined, input("alice"))).rejects.toMatchObject({ code: "REGISTRATION_DISABLED" });
  await env.DB.prepare("UPDATE uranus_account_state SET ownership_ready=0 WHERE id=1").run();
  await expect(registerAccount(env.DB, "true", input("alice"))).rejects.toMatchObject({ code: "ACCOUNT_INITIALIZATION_REQUIRED" });
  expect((await env.DB.prepare("SELECT count(*) n FROM uranus_users").first())?.n).toBe(1);
});

it("atomically registers a personal Notes folder with unique normalized identifiers", async () => {
  const alice = await registerAccount(env.DB, "true", input("alice"));
  const bob = await registerAccount(env.DB, "true", input("bob"));
  for (const user of [alice, bob]) {
    expect((await env.DB.prepare("SELECT name,system_key FROM uranus_folders WHERE user_id=?").bind(user.id).first()))
      .toEqual({ name: "Notes", system_key: "default" });
  }
  await expect(registerAccount(env.DB, "true", { ...input("another"), email: " ALICE@EXAMPLE.COM " }))
    .rejects.toMatchObject({ code: "EMAIL_ALREADY_EXISTS" });
  await expect(registerAccount(env.DB, "true", { ...input("another"), username: " Alice " }))
    .rejects.toMatchObject({ code: "USERNAME_ALREADY_EXISTS" });
  expect((await env.DB.prepare("SELECT count(*) n FROM uranus_users").first())?.n).toBe(3);
  expect((await env.DB.prepare("SELECT count(*) n FROM uranus_folders WHERE user_id IS NOT NULL").first())?.n).toBe(2);
});

it("rolls back the user when default folder creation fails", async () => {
  await env.DB.prepare(`CREATE TRIGGER uranus_test_reject_folder BEFORE INSERT ON uranus_folders
    WHEN NEW.user_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'TEST_FOLDER_FAILURE'); END`).run();
  try {
    await expect(registerAccount(env.DB, "true", input("alice"))).rejects.toThrow("TEST_FOLDER_FAILURE");
    expect((await env.DB.prepare("SELECT count(*) n FROM uranus_users").first())?.n).toBe(1);
  } finally { await env.DB.exec("DROP TRIGGER uranus_test_reject_folder"); }
});

it("allows only one concurrent registration per normalized email", async () => {
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => registerAccount(env.DB, "true", input("alice"))));
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect((await env.DB.prepare("SELECT count(*) n FROM uranus_users").first())?.n).toBe(2);
  expect((await env.DB.prepare("SELECT count(*) n FROM uranus_folders WHERE user_id IS NOT NULL").first())?.n).toBe(1);
});

it("enforces the 100-user limit atomically with default folders", async () => {
  await env.DB.batch(Array.from({ length: 98 }, (_, i) => env.DB.prepare(`INSERT INTO uranus_users
    SELECT ?,?,?,?, ?,password_algorithm,password_iterations,password_salt,password_hash,
      credential_version,disabled,created_at,updated_at FROM uranus_users WHERE id='default-owner'`)
    .bind(`capacity-${i}`, `c${i}@example.com`, `c${i}@example.com`, `c${i}`, `c${i}`)));
  const results = await Promise.allSettled(Array.from({ length: 4 }, (_, i) => registerAccount(env.DB, "true", input(`racer${i}`))));
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "REGISTRATION_CAPACITY_REACHED" });
  expect((await env.DB.prepare("SELECT count(*) n FROM uranus_users").first())?.n).toBe(100);
  expect((await env.DB.prepare("SELECT count(*) n FROM uranus_folders WHERE user_id IS NOT NULL").first())?.n).toBe(1);
  expect((await authenticateAccount(env.DB, { email: "admin@example.com", password })).user.id).toBe("default-owner");
});

it("authenticates only exact passwords and accepts no legacy token payload", async () => {
  const alice = await registerAccount(env.DB, "true", input("alice"));
  expect((await authenticateAccount(env.DB, { email: " ALICE@EXAMPLE.COM ", password })).user.id).toBe(alice.id);
  for (const email of ["alice@example.com", "unknown@example.com"]) {
    await expect(authenticateAccount(env.DB, { email, password: "wrong-password" })).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  }
  await expect(authenticateAccount(env.DB, { token: "old-token" })).rejects.toMatchObject({ status: 400 });
});

it("renames only the current account, preserving the reserved default-admin identity", async () => {
  const alice = await registerAccount(env.DB, "true", input("alice"));
  await registerAccount(env.DB, "true", input("bob"));
  const { session } = await sessionFor(alice.id);
  await renameAccount(env.DB, session, { username: " ALICE " });
  expect((await authenticateAccount(env.DB, { email: alice.email, password })).user.username).toBe("ALICE");
  await expect(renameAccount(env.DB, session, { username: "BOB" })).rejects.toMatchObject({ code: "USERNAME_ALREADY_EXISTS" });
  await expect(renameAccount(env.DB, session, { username: "admin" })).rejects.toMatchObject({ code: "USERNAME_RESERVED" });
  const admin = (await sessionFor("default-owner")).session;
  await renameAccount(env.DB, admin, { username: "Owner" });
  await renameAccount(env.DB, admin, { username: "Admin" });
});

it("changes email using current password and revokes every existing session", async () => {
  const alice = await registerAccount(env.DB, "true", input("alice"));
  await registerAccount(env.DB, "true", input("bob"));
  const first = await sessionFor(alice.id), second = await sessionFor(alice.id);
  await expect(changeAccountEmail(env.DB, first.session, { email: "new@example.com", currentPassword: "incorrect-password" }))
    .rejects.toMatchObject({ code: "CURRENT_PASSWORD_INCORRECT" });
  await expect(changeAccountEmail(env.DB, first.session, { email: "bob@example.com", currentPassword: password }))
    .rejects.toMatchObject({ code: "EMAIL_ALREADY_EXISTS" });
  expect(await readAccountSession(env.DB, secret, first.issued.token)).not.toBeNull();
  expect(await changeAccountEmail(env.DB, first.session, { email: "ALICE@example.com", currentPassword: password })).toEqual({ changed: false });
  expect(await changeAccountEmail(env.DB, first.session, { email: "new@example.com", currentPassword: password })).toEqual({ changed: true });
  for (const previous of [first, second]) expect(await readAccountSession(env.DB, secret, previous.issued.token)).toBeNull();
  await expect(authenticateAccount(env.DB, { email: alice.email, password })).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  expect((await authenticateAccount(env.DB, { email: "new@example.com", password })).user.id).toBe(alice.id);
});

it("accepts only one concurrent password change and rejects stale login issuance", async () => {
  const alice = await registerAccount(env.DB, "true", input("alice"));
  const { session, issued } = await sessionFor(alice.id);
  const results = await Promise.allSettled(["new-password-one", "new-password-two"].map((next) =>
    changeAccountPassword(env.DB, session, { currentPassword: password, password: next, confirmPassword: next })));
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(await readAccountSession(env.DB, secret, issued.token)).toBeNull();
  await expect(issueAccountSession(env.DB, secret, alice.id, 1)).rejects.toMatchObject({ code: "CREDENTIALS_CHANGED" });
  await expect(authenticateAccount(env.DB, { email: alice.email, password })).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  expect((await env.DB.prepare("SELECT credential_version v FROM uranus_users WHERE id=?").bind(alice.id).first())?.v).toBe(2);
});
