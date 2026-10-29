import { z } from "zod";
export const SUPPORTED_SCHEMA_VERSIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;
export const CURRENT_SCHEMA_VERSION = 15;
export type ContentSchemaVersion = typeof SUPPORTED_SCHEMA_VERSIONS[number];
export const contentSchemaVersionSchema = z.union(SUPPORTED_SCHEMA_VERSIONS.map(version => z.literal(version)));
export const supportsSchema = (value: number): value is ContentSchemaVersion => (SUPPORTED_SCHEMA_VERSIONS as readonly number[]).includes(value);
export const SCHEMA_FEATURE = { table: 2, alignment: 3, imageAlignment: 4, richCells: 5, label: 6, fileAttachment: 7, noteLink: 8, attachmentDisplay: 9, tableAttachments: 10, textColors: 11, inlineImage: 12, indent: 13, codeCollapse: 14, inlineFile: 15 } as const;
