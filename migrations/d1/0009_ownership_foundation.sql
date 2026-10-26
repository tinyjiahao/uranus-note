-- Staged upgrade: NULL remains legal only until controlled initialization.
ALTER TABLE uranus_notes ADD COLUMN user_id TEXT REFERENCES uranus_users(id);
ALTER TABLE uranus_operations ADD COLUMN user_id TEXT REFERENCES uranus_users(id);
ALTER TABLE uranus_maintenance_jobs ADD COLUMN user_id TEXT REFERENCES uranus_users(id);
CREATE INDEX uranus_notes_user_list_idx ON uranus_notes(user_id,deleted_at,pinned DESC,updated_at DESC,id DESC);
CREATE INDEX uranus_operations_user_idx ON uranus_operations(user_id,operation_id);
CREATE INDEX uranus_maintenance_jobs_user_idx ON uranus_maintenance_jobs(user_id,status,next_attempt_at);

CREATE TRIGGER uranus_notes_owner_insert BEFORE INSERT ON uranus_notes
BEGIN
  SELECT CASE WHEN NEW.user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM uranus_folders WHERE id=NEW.folder_id AND user_id=NEW.user_id
  ) THEN RAISE(ABORT,'OWNERSHIP_CONFLICT') END;
  SELECT CASE WHEN NEW.user_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM uranus_folders WHERE id=NEW.prev_folder_id AND user_id IS NOT NEW.user_id
  ) THEN RAISE(ABORT,'OWNERSHIP_CONFLICT') END;
  SELECT CASE WHEN NEW.user_id IS NULL AND EXISTS (
    SELECT 1 FROM uranus_account_state WHERE id=1 AND ownership_ready=1
  ) THEN RAISE(ABORT,'OWNER_REQUIRED') END;
END;
CREATE TRIGGER uranus_notes_owner_update BEFORE UPDATE OF user_id,folder_id,prev_folder_id ON uranus_notes
BEGIN
  SELECT CASE WHEN OLD.user_id IS NOT NULL AND NEW.user_id IS NOT OLD.user_id
    THEN RAISE(ABORT,'OWNER_IMMUTABLE') END;
  SELECT CASE WHEN NEW.user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM uranus_folders WHERE id=NEW.folder_id AND user_id=NEW.user_id
  ) THEN RAISE(ABORT,'OWNERSHIP_CONFLICT') END;
  SELECT CASE WHEN NEW.user_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM uranus_folders WHERE id=NEW.prev_folder_id AND user_id IS NOT NEW.user_id
  ) THEN RAISE(ABORT,'OWNERSHIP_CONFLICT') END;
END;
CREATE TRIGGER uranus_folders_owner_update BEFORE UPDATE OF user_id ON uranus_folders
WHEN OLD.user_id IS NOT NULL AND NEW.user_id IS NOT OLD.user_id
BEGIN SELECT RAISE(ABORT,'OWNER_IMMUTABLE'); END;
CREATE TRIGGER uranus_folders_owner_insert BEFORE INSERT ON uranus_folders
WHEN NEW.user_id IS NULL AND EXISTS(SELECT 1 FROM uranus_account_state WHERE id=1 AND ownership_ready=1)
BEGIN SELECT RAISE(ABORT,'OWNER_REQUIRED'); END;
CREATE TRIGGER uranus_operations_owner_insert BEFORE INSERT ON uranus_operations
WHEN NEW.user_id IS NULL AND EXISTS(SELECT 1 FROM uranus_account_state WHERE id=1 AND ownership_ready=1)
BEGIN SELECT RAISE(ABORT,'OWNER_REQUIRED'); END;
CREATE TRIGGER uranus_operations_owner_update BEFORE UPDATE OF user_id ON uranus_operations
WHEN OLD.user_id IS NOT NULL AND NEW.user_id IS NOT OLD.user_id
BEGIN SELECT RAISE(ABORT,'OWNER_IMMUTABLE'); END;
CREATE TRIGGER uranus_jobs_owner_insert BEFORE INSERT ON uranus_maintenance_jobs
WHEN NEW.user_id IS NULL AND EXISTS(SELECT 1 FROM uranus_account_state WHERE id=1 AND ownership_ready=1)
BEGIN SELECT RAISE(ABORT,'OWNER_REQUIRED'); END;
CREATE TRIGGER uranus_jobs_owner_update BEFORE UPDATE OF user_id ON uranus_maintenance_jobs
WHEN OLD.user_id IS NOT NULL AND NEW.user_id IS NOT OLD.user_id
BEGIN SELECT RAISE(ABORT,'OWNER_IMMUTABLE'); END;

-- Attachment IDs are note-specific even for two notes belonging to one user.
CREATE TRIGGER uranus_refs_parent_insert BEFORE INSERT ON uranus_attachment_refs
WHEN EXISTS(SELECT 1 FROM uranus_account_state WHERE id=1 AND ownership_ready=1)
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM uranus_attachments WHERE id=NEW.attachment_id AND note_id=NEW.note_id)
    THEN RAISE(ABORT,'REFERENCE_PARENT_CONFLICT') END;
  SELECT CASE WHEN NEW.version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM uranus_note_versions WHERE id=NEW.version_id AND note_id=NEW.note_id)
    THEN RAISE(ABORT,'REFERENCE_PARENT_CONFLICT') END;
END;
CREATE TRIGGER uranus_refs_parent_update BEFORE UPDATE ON uranus_attachment_refs
WHEN EXISTS(SELECT 1 FROM uranus_account_state WHERE id=1 AND ownership_ready=1)
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM uranus_attachments WHERE id=NEW.attachment_id AND note_id=NEW.note_id)
    THEN RAISE(ABORT,'REFERENCE_PARENT_CONFLICT') END;
  SELECT CASE WHEN NEW.version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM uranus_note_versions WHERE id=NEW.version_id AND note_id=NEW.note_id)
    THEN RAISE(ABORT,'REFERENCE_PARENT_CONFLICT') END;
END;
CREATE TRIGGER uranus_attachments_parent_immutable BEFORE UPDATE OF note_id ON uranus_attachments
WHEN NEW.note_id<>OLD.note_id
BEGIN SELECT RAISE(ABORT,'REFERENCE_PARENT_IMMUTABLE'); END;
CREATE TRIGGER uranus_versions_parent_immutable BEFORE UPDATE OF note_id ON uranus_note_versions
WHEN NEW.note_id<>OLD.note_id
BEGIN SELECT RAISE(ABORT,'REFERENCE_PARENT_IMMUTABLE'); END;

-- Checked at the beginning and end of the same initialization batch. Keeping
-- both checks in SQLite avoids a check/write race and rolls back ALL changes.
CREATE TABLE uranus_initialization_guards (
  id TEXT PRIMARY KEY NOT NULL,
  maintenance_id TEXT NOT NULL,
  validate_ownership INTEGER NOT NULL CHECK(validate_ownership IN (0,1))
);
CREATE TRIGGER uranus_initialization_guard BEFORE INSERT ON uranus_initialization_guards
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM uranus_runtime_state WHERE id=1 AND mode='frozen' AND maintenance_id=NEW.maintenance_id)
    THEN RAISE(ABORT,'INITIALIZATION_REQUIRES_FREEZE') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM uranus_operations WHERE status='pending')
    OR EXISTS(SELECT 1 FROM uranus_maintenance_jobs WHERE status='running')
    THEN RAISE(ABORT,'INITIALIZATION_NOT_DRAINED') END;
  SELECT CASE WHEN NEW.validate_ownership=1 AND (
    EXISTS(SELECT 1 FROM uranus_folders WHERE user_id IS NULL)
    OR EXISTS(SELECT 1 FROM uranus_notes WHERE user_id IS NULL)
    OR EXISTS(SELECT 1 FROM uranus_operations WHERE user_id IS NULL)
    OR EXISTS(SELECT 1 FROM uranus_maintenance_jobs WHERE user_id IS NULL)
    OR EXISTS(SELECT 1 FROM uranus_users u WHERE (SELECT count(*) FROM uranus_folders f WHERE f.user_id=u.id AND f.system_key='default')<>1)
    OR EXISTS(SELECT 1 FROM uranus_notes n JOIN uranus_folders f ON f.id=n.folder_id WHERE f.user_id IS NOT n.user_id)
    OR EXISTS(SELECT 1 FROM uranus_notes n JOIN uranus_folders f ON f.id=n.prev_folder_id WHERE f.user_id IS NOT n.user_id)
    OR EXISTS(SELECT 1 FROM uranus_notes n WHERE NOT EXISTS(SELECT 1 FROM uranus_folders f WHERE f.id=n.folder_id))
    OR EXISTS(SELECT 1 FROM uranus_attachments a WHERE NOT EXISTS(SELECT 1 FROM uranus_notes n WHERE n.id=a.note_id))
    OR EXISTS(SELECT 1 FROM uranus_note_versions v WHERE NOT EXISTS(SELECT 1 FROM uranus_notes n WHERE n.id=v.note_id))
    OR EXISTS(SELECT 1 FROM uranus_note_search s WHERE NOT EXISTS(SELECT 1 FROM uranus_notes n WHERE n.id=s.note_id))
    OR EXISTS(SELECT 1 FROM uranus_attachment_refs r WHERE NOT EXISTS(SELECT 1 FROM uranus_attachments a WHERE a.id=r.attachment_id)
      OR NOT EXISTS(SELECT 1 FROM uranus_notes n WHERE n.id=r.note_id)
      OR (r.version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM uranus_note_versions v WHERE v.id=r.version_id)))
    OR EXISTS(SELECT 1 FROM uranus_attachment_refs r JOIN uranus_attachments a ON a.id=r.attachment_id WHERE a.note_id<>r.note_id)
    OR EXISTS(SELECT 1 FROM uranus_attachment_refs r JOIN uranus_note_versions v ON v.id=r.version_id WHERE v.note_id<>r.note_id)
    OR EXISTS(SELECT 1 FROM uranus_maintenance_jobs j JOIN uranus_notes n ON j.kind='purge_note:'||n.id WHERE j.user_id IS NOT n.user_id)
    OR EXISTS(SELECT 1 FROM uranus_maintenance_jobs j JOIN uranus_attachments a ON j.kind='delete_attachment:'||a.id JOIN uranus_notes n ON n.id=a.note_id WHERE j.user_id IS NOT n.user_id)
  ) THEN RAISE(ABORT,'OWNERSHIP_VALIDATION_FAILED') END;
END;
