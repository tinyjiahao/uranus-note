import type { AccountIdentity } from "../../shared/account";
import { base64url, hmac, sha256, timingSafeEqual } from "../lib/crypto";
import { ApiError } from "../lib/http";

export type AccountSession = {
  credentialDigest: string;
  credentialVersion: number;
  csrf: string;
  expiresAt: number;
  user: AccountIdentity;
};
type SessionRow = {
  credential_digest: string; credential_version: number; csrf: string; expires_at: number;
  id: string; email: string; username: string;
};

export const ACTIVE_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const SESSION_RENEW_INTERVAL_MS = 60 * 60 * 1000;

export async function renewAccountSession(db: D1Database, session: AccountSession) {
  const now = Date.now();
  await db.prepare(`UPDATE uranus_sessions SET expires_at=?
    WHERE credential_digest=? AND user_id=? AND revoked_at IS NULL AND expires_at>?
      AND expires_at<=? AND credential_version=?
      AND EXISTS(SELECT 1 FROM uranus_users WHERE id=? AND disabled=0 AND credential_version=?)
      AND EXISTS(SELECT 1 FROM uranus_runtime_state WHERE id=1 AND mode='normal')`)
    .bind(now + ACTIVE_SESSION_TTL_MS, session.credentialDigest, session.user.id, now,
      now + ACTIVE_SESSION_TTL_MS - SESSION_RENEW_INTERVAL_MS, session.credentialVersion, session.user.id, session.credentialVersion).run();
}

function validateSecret(secret: string) {
  if (new TextEncoder().encode(secret).length < 32) throw new ApiError(503, "CONFIGURATION_ERROR", "服务密钥长度不足");
}

/** Only called after password verification; the observed version is a CAS. */
export async function issueAccountSession(db: D1Database, secret: string, userId: string, observedVersion: number, configuredTtl?: string) {
  validateSecret(secret);
  const requested = Number(configuredTtl ?? 86400);
  const ttl = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, 2_592_000) : 86400;
  const credential = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await sha256(credential);
  const csrf = base64url(crypto.getRandomValues(new Uint8Array(24)));
  const now = Date.now();
  const expiresAt = now + ttl * 1000;
  const result = await db.prepare(`INSERT INTO uranus_sessions
    (credential_digest,user_id,credential_version,csrf,created_at,expires_at)
    SELECT ?,id,credential_version,?,?,? FROM uranus_users
    WHERE id=? AND credential_version=? AND disabled=0
      AND EXISTS(SELECT 1 FROM uranus_runtime_state WHERE id=1 AND mode='normal')`)
    .bind(digest, csrf, now, expiresAt, userId, observedVersion).run();
  if (result.meta.changes !== 1) throw new ApiError(409, "CREDENTIALS_CHANGED", "账号状态已变化，请重新登录");
  return { token: `${credential}.${await hmac(secret, `session-v6:${credential}`)}`, csrf, expiresAt, ttl };
}

export async function readAccountSession(db: D1Database, secret: string, token?: string): Promise<AccountSession | null> {
  validateSecret(secret);
  if (!token || !/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [credential, signature] = token.split(".") as [string, string];
  if (!timingSafeEqual(signature, await hmac(secret, `session-v6:${credential}`))) return null;
  const row = await db.prepare(`SELECT s.credential_digest,s.credential_version,s.csrf,s.expires_at,u.id,u.email,u.username
    FROM uranus_sessions s JOIN uranus_users u ON u.id=s.user_id
    WHERE s.credential_digest=? AND s.revoked_at IS NULL AND s.expires_at>?
      AND u.disabled=0 AND s.credential_version=u.credential_version`)
    .bind(await sha256(credential), Date.now()).first<SessionRow>();
  return row ? {
    credentialDigest: row.credential_digest, credentialVersion: row.credential_version,
    csrf: row.csrf, expiresAt: row.expires_at, user: { id: row.id, email: row.email, username: row.username },
  } : null;
}

/** Revocation is permitted during maintenance too. Clearing the Cookie alone is insufficient. */
export async function revokeAccountSession(db: D1Database, session: AccountSession): Promise<void> {
  await db.prepare("UPDATE uranus_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE credential_digest=? AND user_id=?")
    .bind(Date.now(), session.credentialDigest, session.user.id).run();
}

/** Authorization must still be expressed by each statement's owner predicate.
 * This helper additionally linearizes session validity with the write commit.
 * Never split this into separate calls or use for statements from client SQL.
 */
export async function sessionWriteBatch<T = unknown>(db: D1Database, session: AccountSession, statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
  const id = crypto.randomUUID();
  try {
    const results = await db.batch<T>([
      db.prepare("INSERT INTO uranus_session_write_guards(id,credential_digest) VALUES(?,?)").bind(id, session.credentialDigest),
      ...statements,
      db.prepare("DELETE FROM uranus_session_write_guards WHERE id=?").bind(id),
    ]);
    return results.slice(1, -1);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("SESSION_REVOKED")) throw new ApiError(401, "UNAUTHENTICATED", "会话已失效，请重新登录");
    if (message.includes("MAINTENANCE_MODE")) throw new ApiError(503, "MAINTENANCE_MODE", "维护中，暂不能修改");
    throw error;
  }
}

export async function expireAccountSessions(db: D1Database): Promise<void> {
  await db.prepare(`DELETE FROM uranus_sessions WHERE credential_digest IN (
    SELECT credential_digest FROM uranus_sessions WHERE expires_at<=? OR revoked_at IS NOT NULL LIMIT 100
  )`).bind(Date.now()).run();
}
