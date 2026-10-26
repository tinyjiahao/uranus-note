-- NULL denotes legacy data awaiting controlled ownership migration. Public
-- account endpoints must stay disabled until ALL data ownership is migrated.
ALTER TABLE uranus_folders ADD COLUMN user_id TEXT REFERENCES uranus_users(id);
DROP INDEX uranus_folders_system_key_idx;
DROP INDEX uranus_folders_name_idx;
CREATE UNIQUE INDEX uranus_folders_system_key_idx
  ON uranus_folders(COALESCE(user_id, ''), system_key) WHERE system_key IS NOT NULL;
CREATE UNIQUE INDEX uranus_folders_name_idx
  ON uranus_folders(COALESCE(user_id, ''), name COLLATE NOCASE);
CREATE INDEX uranus_folders_user_idx ON uranus_folders(user_id, id);
