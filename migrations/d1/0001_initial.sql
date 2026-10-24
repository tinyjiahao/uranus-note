PRAGMA foreign_keys = ON;

CREATE TABLE uranus_folders (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 128),
  system_key TEXT CHECK(system_key IS NULL OR system_key = 'default'),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX uranus_folders_system_key_idx ON uranus_folders(system_key) WHERE system_key IS NOT NULL;
CREATE UNIQUE INDEX uranus_folders_name_idx ON uranus_folders(name COLLATE NOCASE);

INSERT INTO uranus_folders(id, name, system_key, created_at, updated_at)
VALUES (1, 'Notes', 'default', unixepoch('subsec') * 1000, unixepoch('subsec') * 1000);

CREATE TABLE uranus_notes (
  id INTEGER PRIMARY KEY,
  folder_id INTEGER NOT NULL REFERENCES uranus_folders(id),
  prev_folder_id INTEGER,
  title TEXT NOT NULL DEFAULT '',
  snippet TEXT NOT NULL DEFAULT '',
  content_json TEXT NOT NULL,
  content_schema_version INTEGER NOT NULL DEFAULT 1 CHECK(content_schema_version = 1),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0, 1)),
  starred INTEGER NOT NULL DEFAULT 0 CHECK(starred IN (0, 1)),
  deleted_at INTEGER,
  purge_pending INTEGER NOT NULL DEFAULT 0 CHECK(purge_pending IN (0, 1)),
  last_operation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX uranus_notes_folder_list_idx ON uranus_notes(folder_id, deleted_at, pinned DESC, updated_at DESC, id DESC);
CREATE INDEX uranus_notes_deleted_idx ON uranus_notes(deleted_at, updated_at DESC, id DESC);
CREATE INDEX uranus_notes_starred_idx ON uranus_notes(starred, deleted_at, pinned DESC, updated_at DESC, id DESC);

CREATE TABLE uranus_note_search (
  note_id INTEGER PRIMARY KEY REFERENCES uranus_notes(id) ON DELETE CASCADE,
  normalized_title TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  source_revision INTEGER NOT NULL
);

CREATE TABLE uranus_note_versions (
  id INTEGER PRIMARY KEY,
  note_id INTEGER NOT NULL REFERENCES uranus_notes(id) ON DELETE CASCADE,
  content_json TEXT NOT NULL,
  content_schema_version INTEGER NOT NULL CHECK(content_schema_version = 1),
  title TEXT NOT NULL,
  char_count INTEGER NOT NULL,
  source_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX uranus_note_versions_note_idx ON uranus_note_versions(note_id, id DESC);

CREATE TABLE uranus_attachments (
  id TEXT PRIMARY KEY,
  note_id INTEGER NOT NULL REFERENCES uranus_notes(id),
  object_key TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size BETWEEN 0 AND 10000000),
  etag TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending', 'ready', 'deleting', 'error')),
  unreferenced_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_error_code TEXT
);
CREATE INDEX uranus_attachments_note_status_idx ON uranus_attachments(note_id, status);

CREATE TABLE uranus_attachment_refs (
  attachment_id TEXT NOT NULL REFERENCES uranus_attachments(id) ON DELETE CASCADE,
  note_id INTEGER NOT NULL REFERENCES uranus_notes(id) ON DELETE CASCADE,
  version_id INTEGER REFERENCES uranus_note_versions(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX uranus_attachment_refs_current_idx ON uranus_attachment_refs(attachment_id, note_id) WHERE version_id IS NULL;
CREATE UNIQUE INDEX uranus_attachment_refs_version_idx ON uranus_attachment_refs(attachment_id, note_id, version_id) WHERE version_id IS NOT NULL;
CREATE INDEX uranus_attachment_refs_attachment_idx ON uranus_attachment_refs(attachment_id, version_id);

CREATE TABLE uranus_operations (
  operation_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'succeeded', 'failed')),
  result_id TEXT,
  result_revision INTEGER,
  result_code TEXT,
  lease_owner TEXT,
  lease_until INTEGER,
  attempt INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX uranus_operations_expires_idx ON uranus_operations(expires_at, status);

CREATE TABLE uranus_maintenance_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'retry_wait', 'succeeded', 'failed')),
  cursor TEXT,
  lease_owner TEXT,
  lease_until INTEGER,
  attempt INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX uranus_maintenance_jobs_status_idx ON uranus_maintenance_jobs(status, next_attempt_at);

CREATE TABLE uranus_runtime_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  mode TEXT NOT NULL CHECK(mode IN ('normal', 'draining', 'frozen', 'restoring')),
  generation INTEGER NOT NULL,
  maintenance_id TEXT,
  started_at INTEGER
);
INSERT INTO uranus_runtime_state(id, mode, generation) VALUES (1, 'normal', 1);
