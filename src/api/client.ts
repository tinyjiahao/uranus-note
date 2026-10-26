import type { ApiErrorBody, FolderDto, NoteDetail, NoteListItem, PageDto } from "../../shared/dto";

let csrfToken = "";
export const setCsrfToken = (value: string) => { csrfToken = value; };

export class ApiClientError extends Error {
  constructor(public status: number, public code: string, message: string, public body?: ApiErrorBody) { super(message); }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  // FormData needs fetch's multipart boundary; never label binary uploads as JSON.
  if (typeof init.body === "string" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (init.method && !["GET", "HEAD"].includes(init.method.toUpperCase()) && csrfToken) headers.set("X-CSRF-Token", csrfToken);
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  const body = await response.json().catch(() => ({})) as T | ApiErrorBody;
  if (!response.ok) {
    if (response.status === 401 && path !== "/api/session") window.dispatchEvent(new Event("uranus-session-expired"));
    const error = body as ApiErrorBody;
    throw new ApiClientError(response.status, error.error?.code ?? "HTTP_ERROR", error.error?.message ?? `请求失败 (${response.status})`, error);
  }
  return body as T;
}

export type Session = { authenticated: boolean; csrfToken?: string; expiresAt?: number };
export async function getSession(): Promise<Session> {
  const session = await request<Session>("/api/session");
  setCsrfToken(session.csrfToken ?? "");
  return session;
}
export async function login(token: string): Promise<Session> {
  const session = await request<Session>("/api/session", { method: "POST", body: JSON.stringify({ token }) });
  setCsrfToken(session.csrfToken ?? "");
  return session;
}
export const logout = () => request<Session>("/api/session", { method: "DELETE" });

export const listFolders = () => request<FolderDto[]>("/api/folders");
export const createFolder = (name: string) => request<FolderDto>("/api/folders", { method: "POST", body: JSON.stringify({ name }) });
export const renameFolder = (id: number, name: string) => request<FolderDto>(`/api/folders/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });
export const deleteFolder = (id: number) => request<{ deleted: boolean }>(`/api/folders/${id}`, { method: "DELETE" });

export type NoteFilters = { folderId?: number | undefined; starred?: boolean | undefined; deleted?: boolean | undefined; q?: string | undefined; sortBy?: string | undefined; sortDir?: string | undefined };
export function listNotes(filters: NoteFilters = {}, page = 1, signal?: AbortSignal) {
  const params = new URLSearchParams({ page: String(page), pageSize: "50", sort_by: filters.sortBy ?? "updated_at", sort_dir: filters.sortDir ?? "desc" });
  if (filters.folderId) params.set("folder_id", String(filters.folderId));
  if (filters.starred) params.set("starred", "1");
  if (filters.deleted) params.set("deleted", "1");
  if (filters.q?.trim()) params.set("q", filters.q.trim());
  return request<PageDto<NoteListItem>>(`/api/notes?${params}`, signal ? { signal } : {});
}
export const getNote = (id: number) => request<NoteDetail>(`/api/notes/${id}`);
export const createNote = (folderId?: number) => request<NoteDetail>("/api/notes", {
  method: "POST", body: JSON.stringify({ operation_id: uuidv7(), ...(folderId ? { folder_id: folderId } : {}), content_schema_version: 5 }),
});
export const createNoteWithContent = (folderId: number, content: Record<string, unknown>) => request<NoteDetail>("/api/notes", {
  method: "POST", body: JSON.stringify({ operation_id: uuidv7(), folder_id: folderId, content_schema_version: 5, content }),
});
export type NotePatch = { content?: Record<string, unknown>; folder_id?: number; pinned?: boolean; starred?: boolean };
export const patchNote = (id: number, revision: number, patch: NotePatch, keepalive = false, operationId = uuidv7()) => request<{ note: NoteDetail; operation_id: string; applied_revision: number }>(`/api/notes/${id}`, {
  method: "PATCH", keepalive, body: JSON.stringify({ operation_id: operationId, expected_revision: revision, content_schema_version: 5, ...patch }),
});
export const removeNote = (id: number, revision: number) => request<NoteDetail>(`/api/notes/${id}`, { method: "DELETE", body: JSON.stringify({ operation_id: uuidv7(), expected_revision: revision }) });
export const restoreNote = (id: number, revision: number) => request<NoteDetail>(`/api/notes/${id}/restore`, { method: "POST", body: JSON.stringify({ operation_id: uuidv7(), expected_revision: revision }) });
export const hardDeleteNote = (id: number, revision: number) => request<{ job_id: string; status: string }>(`/api/notes/${id}?hard=1`, { method: "DELETE", body: JSON.stringify({ operation_id: uuidv7(), expected_revision: revision }) });
export const emptyTrash = () => request<{ job_id: string; status: string }>("/api/notes/empty-trash", { method: "POST", body: JSON.stringify({ operation_id: uuidv7() }) });
export const getMaintenanceJob = (id: string) => request<{ id: string; status: string }>(`/api/maintenance/jobs/${encodeURIComponent(id)}`);
export const retryMaintenanceJob = (id: string) => request(`/api/maintenance/jobs/${encodeURIComponent(id)}/retry`, { method: "POST", body: JSON.stringify({ operation_id: uuidv7() }) });
export const importMarkdown = (markdown: string, folderId?: number) => request<NoteDetail>("/api/import/markdown", { method: "POST", body: JSON.stringify({ operation_id: uuidv7(), markdown, ...(folderId ? { folder_id: folderId } : {}) }) });
export const listVersions = (id: number) => request<PageDto<Record<string, unknown>>>(`/api/notes/${id}/versions?page=1&pageSize=30`);
export const getVersion = (id: number, versionId: number) => request<Record<string, unknown>>(`/api/notes/${id}/versions/${versionId}`);
export const createVersion = (id: number) => request<Record<string, unknown>>(`/api/notes/${id}/versions`, { method: "POST", body: JSON.stringify({ operation_id: uuidv7() }) });
export const restoreVersion = (id: number, versionId: number, revision: number) => request<NoteDetail>(`/api/notes/${id}/versions/${versionId}/restore`, { method: "POST", body: JSON.stringify({ operation_id: uuidv7(), expected_revision: revision }) });
export type AttachmentDto = { id: string; noteId: number; fileName: string; mime: string; size: number; etag: string | null; url: string };
export async function uploadAttachment(noteId: number, file: File): Promise<AttachmentDto> {
  const form = new FormData();
  form.set("note_id", String(noteId));
  form.set("operation_id", uuidv7());
  form.set("file", file, file.name);
  return request<AttachmentDto>("/api/attachments", { method: "POST", body: form });
}
export const copyAttachment = (attachmentId: string, targetNoteId: number) => request<AttachmentDto>(`/api/attachments/${encodeURIComponent(attachmentId)}/copy`, {
  method: "POST", body: JSON.stringify({ target_note_id: targetNoteId, operation_id: uuidv7() }),
});

export function uuidv7(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const time = BigInt(now);
  for (let i = 5; i >= 0; i--) bytes[i] = Number((time >> BigInt((5 - i) * 8)) & 0xffn);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
