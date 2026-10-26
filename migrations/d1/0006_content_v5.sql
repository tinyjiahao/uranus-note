-- Keep legacy constraints and foreign-key references while enabling schema 5.
-- Schema 5 adds the semantic small mark and rich blocks inside table cells.
ALTER TABLE uranus_notes RENAME COLUMN content_schema_version TO content_schema_v4;
ALTER TABLE uranus_notes ADD COLUMN content_schema_version INTEGER NOT NULL DEFAULT 1 CHECK(content_schema_version IN (1, 2, 3, 4, 5));
UPDATE uranus_notes SET content_schema_version=content_schema_v4;
ALTER TABLE uranus_note_versions RENAME COLUMN content_schema_version TO content_schema_v4;
ALTER TABLE uranus_note_versions ADD COLUMN content_schema_version INTEGER NOT NULL DEFAULT 1 CHECK(content_schema_version IN (1, 2, 3, 4, 5));
UPDATE uranus_note_versions SET content_schema_version=content_schema_v4;
