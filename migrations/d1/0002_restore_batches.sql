CREATE TABLE uranus_restore_batches (
  backup_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  checksum TEXT NOT NULL,
  entity TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (backup_id, batch_id)
);
CREATE INDEX uranus_restore_batches_created_idx ON uranus_restore_batches(created_at);
