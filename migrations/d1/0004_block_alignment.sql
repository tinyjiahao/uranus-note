-- Preserve legacy constraints and foreign-key references without rebuilding tables.
ALTER TABLE uranus_notes RENAME COLUMN content_schema_version TO content_schema_v2;
ALTER TABLE uranus_notes ADD COLUMN content_schema_version INTEGER NOT NULL DEFAULT 1 CHECK(content_schema_version IN (1, 2, 3));
UPDATE uranus_notes SET content_schema_version=content_schema_v2;
ALTER TABLE uranus_note_versions RENAME COLUMN content_schema_version TO content_schema_v2;
ALTER TABLE uranus_note_versions ADD COLUMN content_schema_version INTEGER NOT NULL DEFAULT 1 CHECK(content_schema_version IN (1, 2, 3));
UPDATE uranus_note_versions SET content_schema_version=content_schema_v2;
