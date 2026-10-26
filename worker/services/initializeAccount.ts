import { emailSchema, normalizeEmail, passwordSchema } from "../../shared/account.ts";
import { randomSafeInteger } from "../lib/crypto.ts";
import { hashPassword } from "../lib/password.ts";

/** Deployment-only service. Never mount this on the public HTTP router.
 * Requires a verified backup and a frozen/drained instance at the caller.
 * Leaves maintenance frozen; authorization cutover is a separate operation.
 */
export async function initializeDefaultAccount(db: D1Database, input: {
  email: string; password: string; maintenanceId: string;
}): Promise<{ userId: string; created: boolean }> {
  const email = emailSchema.parse(input.email);
  passwordSchema.parse(input.password);
  if (!input.maintenanceId) throw new Error("INITIALIZATION_REQUIRES_FREEZE");
  const existing = await db.prepare("SELECT default_user_id FROM uranus_account_state WHERE id=1")
    .first<{ default_user_id: string }>();
  const userId = existing?.default_user_id ?? crypto.randomUUID();
  const statements: D1PreparedStatement[] = [];
  const beforeGuard = crypto.randomUUID(), afterGuard = crypto.randomUUID();
  statements.push(db.prepare("INSERT INTO uranus_initialization_guards VALUES(?,?,0)").bind(beforeGuard, input.maintenanceId));
  if (!existing) {
    // A conflicting username/email without a stable marker is NOT evidence of
    // ownership. Unique indexes abort; never adopt or overwrite that account.
    const hash = await hashPassword(input.password);
    statements.push(db.prepare(`INSERT INTO uranus_users
      (id,email,email_normalized,username,username_normalized,password_algorithm,password_iterations,password_salt,password_hash,created_at,updated_at)
      VALUES(?,?,?,'admin','admin',?,?,?,?,?,?)`).bind(userId, email, normalizeEmail(email), hash.password_algorithm,
        hash.password_iterations, hash.password_salt, hash.password_hash, Date.now(), Date.now()));
    statements.push(db.prepare("INSERT INTO uranus_account_state(id,default_user_id,ownership_ready) VALUES(1,?,0)").bind(userId));
  }
  statements.push(
    db.prepare("UPDATE uranus_folders SET user_id=? WHERE user_id IS NULL").bind(userId),
    db.prepare(`INSERT INTO uranus_folders(id,name,system_key,created_at,updated_at,user_id)
      SELECT ?,'Notes','default',?,?,? WHERE NOT EXISTS(SELECT 1 FROM uranus_folders WHERE user_id=? AND system_key='default')`)
      .bind(randomSafeInteger(), Date.now(), Date.now(), userId, userId),
    db.prepare("UPDATE uranus_notes SET user_id=? WHERE user_id IS NULL").bind(userId),
    db.prepare("UPDATE uranus_operations SET user_id=? WHERE user_id IS NULL").bind(userId),
    db.prepare("UPDATE uranus_maintenance_jobs SET user_id=? WHERE user_id IS NULL").bind(userId),
    db.prepare("INSERT INTO uranus_initialization_guards VALUES(?,?,1)").bind(afterGuard, input.maintenanceId),
    // Every row now has a proven owner. This is NOT permission to open public
    // routes until the owner-aware Worker is in place.
    db.prepare("UPDATE uranus_account_state SET ownership_ready=1 WHERE id=1 AND default_user_id=?").bind(userId),
    db.prepare("UPDATE uranus_sessions SET revoked_at=COALESCE(revoked_at,?)").bind(Date.now()),
    db.prepare("DELETE FROM uranus_initialization_guards WHERE id IN (?,?)").bind(beforeGuard, afterGuard),
  );
  await db.batch(statements);
  return { userId, created: !existing };
}
