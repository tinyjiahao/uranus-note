-- Preserve existing rows and all foreign-key references without rebuilding parent
-- tables (which could cascade-delete attachment references in D1).
-- The legacy v1 constraint remains on an inert column; new writes use version 2.
ALTER TABLE uranus_notes RENAME COLUMN content_schema_version TO content_schema_v1;
ALTER TABLE uranus_notes ADD COLUMN content_schema_version INTEGER NOT NULL DEFAULT 1 CHECK(content_schema_version IN (1, 2));
ALTER TABLE uranus_note_versions RENAME COLUMN content_schema_version TO content_schema_v1;
ALTER TABLE uranus_note_versions ADD COLUMN content_schema_version INTEGER NOT NULL DEFAULT 1 CHECK(content_schema_version IN (1, 2));
