import { contentSchemaVersionSchema } from "./schemaVersion";
import { z } from "zod";

export const operationIdSchema = z.string().uuid();
export const createNoteSchema = z.object({
  operation_id: operationIdSchema,
  folder_id: z.number().int().positive().optional(),
  content_schema_version: contentSchemaVersionSchema.default(1),
  content: z.record(z.string(), z.unknown()).optional(),
});

export const patchNoteSchema = z.object({
  operation_id: operationIdSchema,
  expected_revision: z.number().int().positive(),
  content_schema_version: contentSchemaVersionSchema.optional(),
  content: z.record(z.string(), z.unknown()).optional(),
  folder_id: z.number().int().positive().optional(),
  pinned: z.boolean().optional(),
  starred: z.boolean().optional(),
}).refine((v) => v.content !== undefined || v.folder_id !== undefined || v.pinned !== undefined || v.starred !== undefined, "没有可更新字段");

export const folderSchema = z.object({ name: z.string().trim().min(1).max(128) });
