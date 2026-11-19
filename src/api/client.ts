import { readConfirmedNote, beginCacheWrite, confirmCacheWrite, rememberListVersions, clearNoteCache, retryPendingCacheCleanup, type CacheReadOptions } from "../state/noteCache";
import { t } from "../state/locale";
import { CURRENT_SCHEMA_VERSION } from "../../shared/schemaVersion";
import type { ApiErrorBody, FolderDto, NoteDetail, NoteListItem, NoteStatsDto, PageDto } from "../../shared/dto";
import type { AccountIdentity } from "../../shared/account";
import { activateIdentity, identity, identityMatches, lockIdentity, notifyAccountChange, trackRequest } from "../state/identity";
import { afterActiveRequest, waitForSessionActivity } from "../state/sessionActivity";

let csrfToken = "";
let sessionExpiresAt = 0;
const rememberedUserIds = new Set<string>();
export const setCsrfToken = (value: string) => { csrfToken = value; };

export class ApiClientError extends Error {
  constructor(public status: number, public code: string, message: string, public body?: ApiErrorBody) { super(message); }
}

// Forward caller cancellation into the controller tracked for account changes.
// This also works in browsers without AbortSignal.any.
function forwardAbort(signal: AbortSignal | null | undefined, controller: AbortController) {
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  return () => signal?.removeEventListener("abort", abort);
}

type ResponseCapture = { response?: Response; startedAt?: number; allow304?: boolean; active?: boolean };
async function request<T>(path: string, init: RequestInit = {}, capture?: ResponseCapture): Promise<T> {
  const expected = identity();
  if (!expected.userId && !["/api/session", "/api/register", "/api/account/switch", "/api/account/sessions"].includes(path)) throw new ApiClientError(401, "UNAUTHENTICATED", t("请重新登录"));
  const isWrite = !!init.method && !["GET", "HEAD"].includes(init.method.toUpperCase());
  const notePath = /^\/api\/notes\/(\d+)(?:\/|\?|$)/.exec(path);
  const ticket = isWrite && (/^\/api\/(notes|import)(\/|$)/.test(path) || /^\/api\/folders\/\d+$/.test(path) && init.method === "DELETE") ? await beginCacheWrite(notePath ? Number(notePath[1]) : undefined) : undefined;
  if (!identityMatches(expected)) throw new ApiClientError(401, "IDENTITY_CHANGED", t("账号状态已变化"));
  const startedAt = Date.now();
  if (capture) capture.startedAt = startedAt;
  const controller = new AbortController();
  const untrack = trackRequest(controller);
  const headers = new Headers(init.headers);
  // FormData needs fetch's multipart boundary; never label binary uploads as JSON.
  if (typeof init.body === "string" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (init.method && !["GET", "HEAD"].includes(init.method.toUpperCase()) && csrfToken) headers.set("X-CSRF-Token", csrfToken);
  const stopForwarding = forwardAbort(init.signal, controller);
  try {
  const response = await fetch(path, { ...init, headers, credentials: "same-origin", signal: controller.signal });
  if (capture) capture.response = response;
  const body = (response.status === 304 ? undefined : await response.json().catch(() => ({}))) as T | ApiErrorBody;
  if (!identityMatches(expected)) throw new ApiClientError(401, "IDENTITY_CHANGED", t("账号状态已变化"));
  if (!response.ok && !(response.status === 304 && capture?.allow304)) {
    if (response.status === 401 && (path !== "/api/session" || init.method === "DELETE")) lockIdentity();
    const error = body as ApiErrorBody;
    throw new ApiClientError(response.status, error.error?.code ?? "HTTP_ERROR", error.error?.message ?? t("请求失败 ({0})", response.status), error);
  }
  if (capture?.active !== false && expected.userId && /^\/api\/(notes|folders|attachments|import)(\/|\?|$)/.test(path)) {
    afterActiveRequest(`${expected.userId}:${expected.epoch}`, async () => { sessionExpiresAt = (await request<{ expiresAt: number }>("/api/session/activity", { method: "POST", signal: AbortSignal.timeout(10_000) })).expiresAt; return sessionExpiresAt; });
  }
  if (path.startsWith("/api/notes?") && !isWrite) rememberListVersions((body as PageDto<NoteListItem>).items, startedAt, response.headers.get("X-Note-Representation-Version") ?? "", expected);
  if (ticket) {
    const candidate = body as NoteDetail & { note?: NoteDetail };
    const note = candidate.note ?? candidate;
    if (note?.content && typeof note.revision === "number") void confirmCacheWrite(note, ticket, startedAt);
    if ((path.includes("?hard=1") || path === "/api/notes/empty-trash" || /^\/api\/folders\/\d+$/.test(path) && init.method === "DELETE") && expected.userId) await clearNoteCache(expected.userId, path.includes("?hard=1") && notePath ? Number(notePath[1]) : undefined).catch(() => {});
  }
  return body as T;
  } finally { stopForwarding(); untrack(); }
}

export type Session = { authenticated: boolean; csrfToken?: string; expiresAt?: number; user?: AccountIdentity; defaultDataOwner?: boolean; registrationEnabled?: boolean };
export async function getSession(): Promise<Session> {
  const session = await request<Session>("/api/session");
  sessionExpiresAt = session.expiresAt ?? 0;
  if (session.user) rememberedUserIds.add(session.user.id);
  setCsrfToken(session.csrfToken ?? "");
  activateIdentity(session.authenticated ? session.user?.id ?? null : null);
  if (session.user) void retryPendingCacheCleanup(session.user.id);
  return session;
}
export async function login(email: string, password: string): Promise<Session> {
  await waitForSessionActivity();
  const session = await request<Session>("/api/session", { method: "POST", body: JSON.stringify({ email, password }) });
  sessionExpiresAt = session.expiresAt ?? 0;
  if (session.user) rememberedUserIds.add(session.user.id);
  setCsrfToken(session.csrfToken ?? "");
  activateIdentity(session.user?.id ?? null); notifyAccountChange();
  return session;
}
export async function logout() { await rememberedAccounts().catch(() => {}); await waitForSessionActivity(); const result = await request<Session>("/api/session", { method: "DELETE" }); setCsrfToken(""); lockIdentity(true); await Promise.all([...rememberedUserIds].map(user => clearNoteCache(user).catch(() => {}))); rememberedUserIds.clear(); return result; }
export const rememberedAccounts = async () => { const result = await request<{ accounts: { user: AccountIdentity; expiresAt: number; current: boolean }[]; limit: number; switchToken: string }>("/api/account/sessions"); result.accounts.forEach(account => rememberedUserIds.add(account.user.id)); return result; };
export async function forgetAccount(userId: string) { await waitForSessionActivity(); const result = await request("/api/account/forget", { method: "POST", body: JSON.stringify({ userId }) }); await clearNoteCache(userId).catch(() => {}); rememberedUserIds.delete(userId); return result; }
export async function switchAccount(userId: string, switchToken: string) {
  await waitForSessionActivity();
  const session = await request<Session>("/api/account/switch", { method: "POST", headers: { "X-Account-Switch-Token": switchToken }, body: JSON.stringify({ userId }) });
  sessionExpiresAt = session.expiresAt ?? 0;
  if (session.user) rememberedUserIds.add(session.user.id);
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

export type NoteFilters = { ids?: number[] | undefined; folderId?: number | undefined; starred?: boolean | undefined; deleted?: boolean | undefined; q?: string | undefined; sortBy?: string | undefined; sortDir?: string | undefined };
export function listNotes(filters: NoteFilters = {}, page = 1, signal?: AbortSignal) {
  const params = new URLSearchParams({ page: String(page), pageSize: "50", sort_by: filters.sortBy ?? "updated_at", sort_dir: filters.sortDir ?? "desc" });
  if (filters.folderId) params.set("folder_id", String(filters.folderId));
  if (filters.ids?.length) params.set("ids", filters.ids.join(","));
  if (filters.starred) params.set("starred", "1");
  if (filters.deleted) params.set("deleted", "1");
  if (filters.q?.trim()) params.set("q", filters.q.trim());
  return request<PageDto<NoteListItem>>(`/api/notes?${params}`, signal ? { signal } : {});
}
export const getNote = async (id: number, signal?: AbortSignal, options: CacheReadOptions = {}) => {
  if (sessionExpiresAt && Date.now() >= sessionExpiresAt) { const session = await getSession(); if (!session.authenticated) lockIdentity(); }
  return readConfirmedNote(id, async (etag, requestSignal) => {
    const capture: ResponseCapture = { allow304: true, active: !options.background };
    const note = await request<NoteDetail>(`/api/notes/${id}`, { signal: requestSignal, ...(etag ? { headers: { "If-None-Match": etag } } : {}) }, capture);
    return { status: capture.response!.status as 200 | 304, note, etag: capture.response!.headers.get("ETag"), representationVersion: capture.response!.headers.get("X-Note-Representation-Version") ?? "", startedAt: capture.startedAt! };
  }, signal, options);
};
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
  if (!expected.userId) { untrack(); throw new Error(t("请先登录")); }
  const stopForwarding = forwardAbort(signal, controller);
  try {
    const response = await fetch(`/api/attachments/${encodeURIComponent(id)}`, { credentials: "same-origin", signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(t("附件不可用 ({0})", response.status));
    if (Number(response.headers.get("Content-Length")) > budget) { await response.body.cancel(); throw new Error(t("超过导出体积上限")); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.length; if (length > budget) { await reader.cancel(); throw new Error(t("超过导出体积上限")); } chunks.push(value);
    }
    if (!identityMatches(expected)) throw new Error(t("账号状态已变化"));
    const result = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  } finally { stopForwarding(); untrack(); }
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
