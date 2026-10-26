-- Additive preparation only: public account routes remain disabled until the
-- complete ownership migration and authorization cutover have been verified.
CREATE TABLE uranus_users (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL,
  username TEXT NOT NULL,
  username_normalized TEXT NOT NULL,
  password_algorithm TEXT NOT NULL CHECK(password_algorithm = 'pbkdf2-sha256-v1'),
  password_iterations INTEGER NOT NULL CHECK(password_iterations BETWEEN 10000 AND 100000),
  password_salt TEXT NOT NULL CHECK(length(password_salt) = 22),
  password_hash TEXT NOT NULL CHECK(length(password_hash) = 43),
  credential_version INTEGER NOT NULL DEFAULT 1 CHECK(credential_version >= 1),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX uranus_users_email_idx ON uranus_users(email_normalized);
CREATE UNIQUE INDEX uranus_users_username_idx ON uranus_users(username_normalized);
CREATE TRIGGER uranus_users_capacity BEFORE INSERT ON uranus_users
WHEN (SELECT count(*) FROM uranus_users) >= 100
BEGIN
  SELECT RAISE(ABORT, 'REGISTRATION_CAPACITY_REACHED');
END;

CREATE TABLE uranus_account_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  default_user_id TEXT NOT NULL REFERENCES uranus_users(id),
  ownership_ready INTEGER NOT NULL DEFAULT 0 CHECK(ownership_ready IN (0, 1))
);

CREATE TABLE uranus_sessions (
  credential_digest TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES uranus_users(id) ON DELETE CASCADE,
  credential_version INTEGER NOT NULL,
  csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX uranus_sessions_user_idx ON uranus_sessions(user_id, credential_version);
CREATE INDEX uranus_sessions_expiry_idx ON uranus_sessions(expires_at);

-- Inserted and removed inside the SAME D1 batch as the protected writes. A
-- failed guard aborts the batch, unlike a conditional UPDATE affecting 0 rows.
CREATE TABLE uranus_session_write_guards (
  id TEXT PRIMARY KEY NOT NULL,
  credential_digest TEXT NOT NULL
);
CREATE TRIGGER uranus_session_write_guard BEFORE INSERT ON uranus_session_write_guards
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM uranus_sessions s JOIN uranus_users u ON u.id = s.user_id
    WHERE s.credential_digest = NEW.credential_digest AND s.revoked_at IS NULL
      AND s.expires_at > unixepoch('subsec') * 1000 AND u.disabled = 0
      AND s.credential_version = u.credential_version
  ) THEN RAISE(ABORT, 'SESSION_REVOKED') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM uranus_runtime_state WHERE id = 1 AND mode = 'normal'
  ) THEN RAISE(ABORT, 'MAINTENANCE_MODE') END;
END;
