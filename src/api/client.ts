import { CURRENT_SCHEMA_VERSION } from "../../shared/schemaVersion";
import type { ApiErrorBody, FolderDto, NoteDetail, NoteListItem, NoteStatsDto, PageDto } from "../../shared/dto";
import type { AccountIdentity } from "../../shared/account";
import { activateIdentity, identity, identityMatches, lockIdentity, notifyAccountChange, trackRequest } from "../state/identity";
import { afterActiveRequest, waitForSessionActivity } from "../state/sessionActivity";

let csrfToken = "";
export const setCsrfToken = (value: string) => { csrfToken = value; };

export class ApiClientError extends Error {
  constructor(public status: number, public code: string, message: string, public body?: ApiErrorBody) { super(message); }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const expected = identity();
  if (!expected.userId && !["/api/session", "/api/register", "/api/account/switch", "/api/account/sessions"].includes(path)) throw new ApiClientError(401, "UNAUTHENTICATED", "请重新登录");
  const controller = new AbortController();
  const untrack = trackRequest(controller);
  const headers = new Headers(init.headers);
  // FormData needs fetch's multipart boundary; never label binary uploads as JSON.
  if (typeof init.body === "string" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (init.method && !["GET", "HEAD"].includes(init.method.toUpperCase()) && csrfToken) headers.set("X-CSRF-Token", csrfToken);
  try {
  const response = await fetch(path, { ...init, headers, credentials: "same-origin", signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal });
  const body = await response.json().catch(() => ({})) as T | ApiErrorBody;
  if (!identityMatches(expected)) throw new ApiClientError(401, "IDENTITY_CHANGED", "账号状态已变化");
  if (!response.ok) {
    if (response.status === 401 && (path !== "/api/session" || init.method === "DELETE")) lockIdentity();
    const error = body as ApiErrorBody;
    throw new ApiClientError(response.status, error.error?.code ?? "HTTP_ERROR", error.error?.message ?? `请求失败 (${response.status})`, error);
  }
  if (expected.userId && /^\/api\/(notes|folders|attachments|import)(\/|\?|$)/.test(path)) {
    afterActiveRequest(`${expected.userId}:${expected.epoch}`, async () => (await request<{ expiresAt: number }>("/api/session/activity", { method: "POST", signal: AbortSignal.timeout(10_000) })).expiresAt);
  }
  return body as T;
  } finally { untrack(); }
}

export type Session = { authenticated: boolean; csrfToken?: string; expiresAt?: number; user?: AccountIdentity; defaultDataOwner?: boolean; registrationEnabled?: boolean };
export async function getSession(): Promise<Session> {
  const session = await request<Session>("/api/session");
  setCsrfToken(session.csrfToken ?? "");
  activateIdentity(session.authenticated ? session.user?.id ?? null : null);
  return session;
}
export async function login(email: string, password: string): Promise<Session> {
  await waitForSessionActivity();
  const session = await request<Session>("/api/session", { method: "POST", body: JSON.stringify({ email, password }) });
  setCsrfToken(session.csrfToken ?? "");
  activateIdentity(session.user?.id ?? null); notifyAccountChange();
  return session;
}
export async function logout() { await waitForSessionActivity(); const result = await request<Session>("/api/session", { method: "DELETE" }); setCsrfToken(""); lockIdentity(true); return result; }
export const rememberedAccounts = () => request<{ accounts: { user: AccountIdentity; expiresAt: number; current: boolean }[]; limit: number; switchToken: string }>("/api/account/sessions");
export async function forgetAccount(userId: string) { await waitForSessionActivity(); return request("/api/account/forget", { method: "POST", body: JSON.stringify({ userId }) }); }
export async function switchAccount(userId: string, switchToken: string) {
  await waitForSessionActivity();
  const session = await request<Session>("/api/account/switch", { method: "POST", headers: { "X-Account-Switch-Token": switchToken }, body: JSON.stringify({ userId }) });
  setCsrfToken(session.csrfToken ?? ""); activateIdentity(session.user?.id ?? null); notifyAccountChange();
  return session;
}
export const register = (input: unknown) => request<{ registered: boolean; email: string }>("/api/register", { method: "POST", body: JSON.stringify(input) });
export const getAccount = () => request<AccountIdentity>("/api/account");
export const renameAccount = (username: string) => request<AccountIdentity>("/api/account", { method: "PATCH", body: JSON.stringify({ username }) });
export async function changeEmail(input: unknown) { await waitForSessionActivity(); const result = await request<{ changed: boolean }>("/api/account/email", { method: "POST", body: JSON.stringify(input) }); if (result.changed) lockIdentity(true); return result; }
export async function changePassword(input: unknown) { await waitForSessionActivity(); const result = await request("/api/account/password", { method: "POST", body: JSON.stringify(input) }); lockIdentity(true); return result; }
export const deploymentStatus = () => request<{ version: string; configured: boolean }>("/api/settings/status");

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
export const getNote = (id: number, signal?: AbortSignal) => request<NoteDetail>(`/api/notes/${id}`, signal ? { signal } : {});
export const createNote = (folderId?: number) => request<NoteDetail>("/api/notes", {
  method: "POST", body: JSON.stringify({ operation_id: uuidv7(), ...(folderId ? { folder_id: folderId } : {}), content_schema_version: CURRENT_SCHEMA_VERSION }),
});
export const createNoteWithContent = (folderId: number, content: Record<string, unknown>) => request<NoteDetail>("/api/notes", {
  method: "POST", body: JSON.stringify({ operation_id: uuidv7(), folder_id: folderId, content_schema_version: CURRENT_SCHEMA_VERSION, content }),
});
export type NotePatch = { content?: Record<string, unknown>; folder_id?: number; pinned?: boolean; starred?: boolean };
export const patchNote = (id: number, revision: number, patch: NotePatch, keepalive = false, operationId = uuidv7()) => request<{ note: NoteDetail; operation_id: string; applied_revision: number }>(`/api/notes/${id}`, {
  method: "PATCH", keepalive, body: JSON.stringify({ operation_id: operationId, expected_revision: revision, content_schema_version: CURRENT_SCHEMA_VERSION, ...patch }),
});
export const removeNote = (id: number, revision: number) => request<NoteDetail>(`/api/notes/${id}`, { method: "DELETE", body: JSON.stringify({ operation_id: uuidv7(), expected_revision: revision }) });
export const restoreNote = (id: number, revision: number) => request<NoteDetail>(`/api/notes/${id}/restore`, { method: "POST", body: JSON.stringify({ operation_id: uuidv7(), expected_revision: revision }) });
export const hardDeleteNote = (id: number, revision: number) => request<{ job_id: string; status: string }>(`/api/notes/${id}?hard=1`, { method: "DELETE", body: JSON.stringify({ operation_id: uuidv7(), expected_revision: revision }) });
export const emptyTrash = () => request<{ job_id: string; status: string }>("/api/notes/empty-trash", { method: "POST", body: JSON.stringify({ operation_id: uuidv7() }) });
export const getMaintenanceJob = (id: string) => request<{ id: string; status: string }>(`/api/maintenance/jobs/${encodeURIComponent(id)}`);
export const retryMaintenanceJob = (id: string) => request(`/api/maintenance/jobs/${encodeURIComponent(id)}/retry`, { method: "POST", body: JSON.stringify({ operation_id: uuidv7() }) });
export const importMarkdown = (markdown: string, folderId?: number) => request<NoteDetail>("/api/import/markdown", { method: "POST", body: JSON.stringify({ operation_id: uuidv7(), markdown, ...(folderId ? { folder_id: folderId } : {}) }) });
export const getNoteStats = (id: number) => request<NoteStatsDto>(`/api/notes/${id}/stats`);
export const listVersions = (id: number) => request<PageDto<Record<string, unknown>>>(`/api/notes/${id}/versions?page=1&pageSize=30`);
export const getVersion = (id: number, versionId: number) => request<Record<string, unknown>>(`/api/notes/${id}/versions/${versionId}`);
export const createVersion = (id: number) => request<Record<string, unknown>>(`/api/notes/${id}/versions`, { method: "POST", body: JSON.stringify({ operation_id: uuidv7() }) });
export const restoreVersion = (id: number, versionId: number, revision: number) => request<NoteDetail>(`/api/notes/${id}/versions/${versionId}/restore`, { method: "POST", body: JSON.stringify({ operation_id: uuidv7(), expected_revision: revision }) });
export type AttachmentDto = { id: string; noteId: number; fileName: string; mime: string; size: number; etag: string | null; url: string };
export async function downloadAttachmentBytes(id: string, signal: AbortSignal, budget: number) {
  const expected = identity(), controller = new AbortController(), untrack = trackRequest(controller);
  if (!expected.userId) { untrack(); throw new Error("请先登录"); }
  try {
    const response = await fetch(`/api/attachments/${encodeURIComponent(id)}`, { credentials: "same-origin", signal: AbortSignal.any([signal, controller.signal]) });
    if (!response.ok || !response.body) throw new Error(`附件不可用 (${response.status})`);
    if (Number(response.headers.get("Content-Length")) > budget) { await response.body.cancel(); throw new Error("超过导出体积上限"); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.length; if (length > budget) { await reader.cancel(); throw new Error("超过导出体积上限"); } chunks.push(value);
    }
    if (!identityMatches(expected)) throw new Error("账号状态已变化");
    const result = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  } finally { untrack(); }
}
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
