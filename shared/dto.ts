export type ContentNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  content?: ContentNode[];
};

export type NoteListItem = {
  id: number;
  folderId: number;
  title: string;
  snippet: string;
  revision: number;
  pinned: boolean;
  starred: boolean;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type NoteDetail = NoteListItem & {
  content: ContentNode;
  contentSchemaVersion: 1 | 2 | 3;
};

export type FolderDto = {
  id: number;
  name: string;
  systemKey: "default" | null;
  noteCount: number;
};

export type PageDto<T> = { items: T[]; page: number; pageSize: number; hasMore: boolean; totalCount?: number };

export type ApiErrorBody = {
  error: { code: string; message: string; requestId: string; latest?: NoteDetail };
};

export type OperationReceipt = {
  operation_id: string;
  note_id: number;
  applied_revision: number;
};

export const EMPTY_CONTENT: ContentNode = { type: "doc", content: [{ type: "paragraph" }] };
export const CONTENT_SCHEMA_VERSION = 2 as const;
