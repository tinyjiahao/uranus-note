import { sessionWriteBatch, type AccountSession } from "./accountSessions";

// Transitional legacy callers can only access NULL-owned data. Once ownership
// is initialized, DB triggers reject ownerless inserts. There is no admin fallback.
export function businessWrite(db: D1Database, session: AccountSession | undefined, statements: D1PreparedStatement[]) {
  return session ? sessionWriteBatch(db, session, statements) : db.batch(statements);
}
