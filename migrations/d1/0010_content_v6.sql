-- Append-only upgrade; preserve parent tables, references and legacy constraints.
ALTER TABLE uranus_notes RENAME COLUMN content_schema_version TO content_schema_v5;
ALTER TABLE uranus_notes ADD COLUMN content_schema_version INTEGER NOT NULL DEFAULT 1 CHECK(content_schema_version BETWEEN 1 AND 99);
UPDATE uranus_notes SET content_schema_version=content_schema_v5;
ALTER TABLE uranus_note_versions RENAME COLUMN content_schema_version TO content_schema_v5;
ALTER TABLE uranus_note_versions ADD COLUMN content_schema_version INTEGER NOT NULL DEFAULT 1 CHECK(content_schema_version BETWEEN 1 AND 99);
UPDATE uranus_note_versions SET content_schema_version=content_schema_v5;
