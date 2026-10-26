import { z } from "zod";
import {
  changeEmailSchema, changePasswordSchema, changeUsernameSchema, loginSchema,
  normalizeEmail, normalizeUsername, registrationSchema, type AccountIdentity,
} from "../../shared/account";
import { randomSafeInteger } from "../lib/crypto";
import { ApiError } from "../lib/http";
import { hashPassword, verifyPassword, type PasswordRecord } from "../lib/password";
import { sessionWriteBatch, type AccountSession } from "./accountSessions";

type AccountRow = AccountIdentity & PasswordRecord & { email_normalized: string; credential_version: number; disabled: number };

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ApiError(400, "INVALID_ACCOUNT_INPUT", "请检查账号信息", {
      fields: Object.fromEntries(result.error.issues.map((issue) => [issue.path.join("."), issue.message])),
    });
  }
  return result.data;
}

function translateDatabaseError(error: unknown): never {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("REGISTRATION_CAPACITY_REACHED")) throw new ApiError(409, "REGISTRATION_CAPACITY_REACHED", "当前用户数量已达上限（100 个），暂不接受新用户注册");
  if (message.includes("uranus_users.email_normalized")) throw new ApiError(409, "EMAIL_ALREADY_EXISTS", "该邮箱已被使用", { fields: { email: "EMAIL_ALREADY_EXISTS" } });
  if (message.includes("uranus_users.username_normalized")) throw new ApiError(409, "USERNAME_ALREADY_EXISTS", "该用户名已被使用", { fields: { username: "USERNAME_ALREADY_EXISTS" } });
  throw error;
}

/** Internal only until all business APIs have owner predicates. */
export async function registerAccount(db: D1Database, enabled: string | undefined, input: unknown): Promise<AccountIdentity> {
  if (enabled !== "true") throw new ApiError(403, "REGISTRATION_DISABLED", "注册未开放");
  const data = parseInput(registrationSchema, input);
  const ready = await db.prepare(`SELECT 1 FROM uranus_account_state a,uranus_runtime_state r
    WHERE a.id=1 AND a.ownership_ready=1 AND r.id=1 AND r.mode='normal'`).first();
  if (!ready) throw new ApiError(503, "ACCOUNT_INITIALIZATION_REQUIRED", "账号初始化或维护尚未完成");
  const password = await hashPassword(data.password);
  const id = crypto.randomUUID(), now = Date.now();
  try {
    const result = await db.batch([
      db.prepare(`INSERT INTO uranus_users
        (id,email,email_normalized,username,username_normalized,password_algorithm,password_iterations,password_salt,password_hash,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(
          SELECT 1 FROM uranus_account_state a,uranus_runtime_state r
          WHERE a.id=1 AND a.ownership_ready=1 AND r.id=1 AND r.mode='normal')`)
        .bind(id, data.email, normalizeEmail(data.email), data.username, normalizeUsername(data.username),
          password.password_algorithm, password.password_iterations, password.password_salt, password.password_hash, now, now),
      db.prepare(`INSERT INTO uranus_folders(id,name,system_key,created_at,updated_at,user_id)
        SELECT ?,'Notes','default',?,?,id FROM uranus_users WHERE id=?`).bind(randomSafeInteger(), now, now, id),
    ]);
    if (result[0]?.meta.changes !== 1 || result[1]?.meta.changes !== 1) throw new ApiError(503, "MAINTENANCE_MODE", "维护中，暂不能注册");
  } catch (error) { translateDatabaseError(error); }
  return { id, email: data.email, username: data.username };
}

/** Does the same password work for absent email; caller must rate-limit first. */
export async function authenticateAccount(db: D1Database, input: unknown): Promise<{ user: AccountIdentity; credentialVersion: number }> {
  const data = parseInput(loginSchema, input);
  const row = await db.prepare("SELECT * FROM uranus_users WHERE email_normalized=?").bind(normalizeEmail(data.email)).first<AccountRow>();
  const valid = await verifyPassword(data.password, row);
  if (!valid || !row || row.disabled) throw new ApiError(401, "INVALID_CREDENTIALS", "邮箱或密码不正确");
  return { user: { id: row.id, email: row.email, username: row.username }, credentialVersion: row.credential_version };
}

export async function renameAccount(db: D1Database, session: AccountSession, input: unknown): Promise<void> {
  const { username } = parseInput(changeUsernameSchema, input);
  const normalized = normalizeUsername(username);
  if (normalized === "admin") {
    const marker = await db.prepare("SELECT 1 FROM uranus_account_state WHERE id=1 AND default_user_id=?").bind(session.user.id).first();
    if (!marker) throw new ApiError(400, "USERNAME_RESERVED", "该用户名为默认账号保留", { fields: { username: "USERNAME_RESERVED" } });
  }
  try {
    await sessionWriteBatch(db, session, [db.prepare("UPDATE uranus_users SET username=?,username_normalized=?,updated_at=? WHERE id=? AND credential_version=?")
      .bind(username, normalized, Date.now(), session.user.id, session.credentialVersion)]);
  } catch (error) { translateDatabaseError(error); }
}

async function checkCurrentPassword(db: D1Database, session: AccountSession, password: string): Promise<AccountRow> {
  const row = await db.prepare("SELECT * FROM uranus_users WHERE id=?").bind(session.user.id).first<AccountRow>();
  const valid = await verifyPassword(password, row);
  if (!row || row.disabled || row.credential_version !== session.credentialVersion) throw new ApiError(401, "UNAUTHENTICATED", "会话已失效，请重新登录");
  if (!valid) throw new ApiError(400, "CURRENT_PASSWORD_INCORRECT", "当前密码不正确", { fields: { currentPassword: "CURRENT_PASSWORD_INCORRECT" } });
  return row;
}

function revokeAllStatement(db: D1Database, userId: string) {
  return db.prepare("UPDATE uranus_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE user_id=?").bind(Date.now(), userId);
}

export async function changeAccountEmail(db: D1Database, session: AccountSession, input: unknown): Promise<{ changed: boolean }> {
  const data = parseInput(changeEmailSchema, input);
  const row = await checkCurrentPassword(db, session, data.currentPassword);
  const normalized = normalizeEmail(data.email);
  if (normalized === row.email_normalized) {
    // Even no-op requests must check revocation/freeze at the final boundary.
    await sessionWriteBatch(db, session, []);
    return { changed: false };
  }
  try {
    await sessionWriteBatch(db, session, [
      db.prepare(`UPDATE uranus_users SET email=?,email_normalized=?,credential_version=credential_version+1,updated_at=?
        WHERE id=? AND credential_version=?`).bind(data.email, normalized, Date.now(), session.user.id, session.credentialVersion),
      revokeAllStatement(db, session.user.id),
    ]);
  } catch (error) { translateDatabaseError(error); }
  return { changed: true };
}

export async function changeAccountPassword(db: D1Database, session: AccountSession, input: unknown): Promise<void> {
  const data = parseInput(changePasswordSchema, input);
  await checkCurrentPassword(db, session, data.currentPassword);
  const hash = await hashPassword(data.password);
  await sessionWriteBatch(db, session, [
    db.prepare(`UPDATE uranus_users SET password_algorithm=?,password_iterations=?,password_salt=?,password_hash=?,
      credential_version=credential_version+1,updated_at=? WHERE id=? AND credential_version=?`)
      .bind(hash.password_algorithm, hash.password_iterations, hash.password_salt, hash.password_hash, Date.now(), session.user.id, session.credentialVersion),
    revokeAllStatement(db, session.user.id),
  ]);
}
