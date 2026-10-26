import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { initializeDefaultAccount } from "../../worker/services/initializeAccount";
import { registerAccount } from "../../worker/services/accounts";
import { issueAccountSession, readAccountSession, revokeAccountSession, type AccountSession } from "../../worker/services/accountSessions";
import { createFolder, deleteFolder, listFolders, renameFolder } from "../../worker/services/folders";
import { changeDeletedState, createManualVersion, createNote, getNote, getVersion, listNotes, listVersions, patchNote, restoreVersion } from "../../worker/services/notes";
import { copyAttachment, deleteAttachment, downloadAttachment, uploadAttachment } from "../../worker/services/attachments";
import { getJob, processMaintenance, queueEmptyTrash, queueHardDelete } from "../../worker/services/maintenance";
import { uuidv7 } from "../../src/api/client";

const db = env.DB, secret = "test-business-secret-longer-than-thirty-two-bytes";
let a: AccountSession, b: AccountSession;
const paragraph = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const png = () => new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "test.png", { type: "image/png" });
const note = (session: AccountSession, text = "Private") => createNote(db, { operation_id: uuidv7(), content_schema_version: 5, content: paragraph(text) }, session);

beforeAll(async () => {
  await db.prepare("UPDATE uranus_runtime_state SET mode='frozen',maintenance_id='test-isolation' WHERE id=1").run();
  const admin = await initializeDefaultAccount(db, { email: "admin@example.com", password: "test-password-only", maintenanceId: "test-isolation" });
  await db.prepare("UPDATE uranus_runtime_state SET mode='normal',maintenance_id=NULL WHERE id=1").run();
  const other = await registerAccount(db, "true", { email: "other@example.com", username: "Other", password: "test-password-only", confirmPassword: "test-password-only" });
  const at = await issueAccountSession(db, secret, admin.userId, 1), bt = await issueAccountSession(db, secret, other.id, 1);
  a = (await readAccountSession(db, secret, at.token))!;
  b = (await readAccountSession(db, secret, bt.token))!;
});

it("scopes folders, counts, search and pagination before returning rows", async () => {
  const fa = await createFolder(db, "Same folder", a), fb = await createFolder(db, "Same folder", b);
  expect(fa.id).not.toBe(fb.id);
  const na = await note(a, "unique-scope-search Alice"), nb = await note(b, "unique-scope-search Bob");
  const foundA = await listNotes(db, { q: "unique-scope-search", pageSize: 1 }, a);
  const foundB = await listNotes(db, { q: "unique-scope-search", pageSize: 1 }, b);
  expect(foundA.totalCount).toBe(1); expect(foundA.items.map((n) => n.id)).toEqual([na.id]);
  expect(foundB.totalCount).toBe(1); expect(foundB.items.map((n) => n.id)).toEqual([nb.id]);
  expect((await listFolders(db, a)).map((f) => f.id)).not.toContain(fb.id);
  await expect(listNotes(db, { folderId: fb.id }, a)).rejects.toMatchObject({ status: 404 });
  await expect(renameFolder(db, fb.id, "stolen", a)).rejects.toMatchObject({ status: 404 });
  await expect(deleteFolder(db, fb.id, a)).rejects.toMatchObject({ status: 404 });
  // The old ownerless path must not suddenly become all-user access.
  expect((await listNotes(db, {})).totalCount).toBe(0);
  expect(await listFolders(db)).toHaveLength(0);
});

it("rejects foreign detail, save, move, versions and operation replay", async () => {
  const nb = await note(b, "B only");
  const op = uuidv7();
  await patchNote(db, nb.id, { operation_id: op, expected_revision: 1, content_schema_version: 5, content: paragraph("B saved") }, b);
  const version = await createManualVersion(db, nb.id, uuidv7(), b);
  await expect(getNote(db, nb.id, a)).rejects.toMatchObject({ status: 404 });
  await expect(patchNote(db, nb.id, { operation_id: uuidv7(), expected_revision: 2, content_schema_version: 5 }, a)).rejects.toMatchObject({ status: 404 });
  await expect(patchNote(db, nb.id, { operation_id: op, expected_revision: 1, content_schema_version: 5 }, a)).rejects.toMatchObject({ status: 404 });
  await expect(listVersions(db, nb.id, 1, 30, a)).rejects.toMatchObject({ status: 404 });
  await expect(getVersion(db, nb.id, version.id, a)).rejects.toMatchObject({ status: 404 });
  await expect(restoreVersion(db, nb.id, version.id, { operation_id: uuidv7(), expected_revision: 2 }, a)).rejects.toMatchObject({ status: 404 });
  const na = await note(a);
  await expect(patchNote(db, na.id, { operation_id: uuidv7(), expected_revision: 1, content_schema_version: 5, folder_id: nb.folderId }, a)).rejects.toMatchObject({ status: 404 });
  expect((await getNote(db, nb.id, b)).revision).toBe(2);
});

it("authorizes downloads before ETag and rejects cross-user copy, upload and delete", async () => {
  const na = await note(a), nb = await note(b);
  const image = await uploadAttachment(db, env.UPLOADS, nb.id, uuidv7(), png(), b);
  await expect(downloadAttachment(db, env.UPLOADS, image.id, image.etag!, a)).rejects.toMatchObject({ status: 404 });
  expect((await downloadAttachment(db, env.UPLOADS, image.id, image.etag!, b)).notModified).toBe(true);
  await expect(copyAttachment(db, env.UPLOADS, image.id, na.id, uuidv7(), a)).rejects.toMatchObject({ status: 404 });
  await expect(copyAttachment(db, env.UPLOADS, image.id, na.id, uuidv7(), b)).rejects.toMatchObject({ status: 404 });
  await expect(uploadAttachment(db, env.UPLOADS, nb.id, uuidv7(), png(), a)).rejects.toMatchObject({ status: 404 });
  await expect(deleteAttachment(db, env.UPLOADS, image.id, a)).rejects.toMatchObject({ status: 404 });
  expect((await downloadAttachment(db, env.UPLOADS, image.id, undefined, b)).object).not.toBeNull();
});

it("keeps empty-trash jobs and child deletion within the initiating user's scope", async () => {
  const na = await note(a), nb = await note(b);
  await changeDeletedState(db, na.id, { operation_id: uuidv7(), expected_revision: 1 }, false, a);
  await changeDeletedState(db, nb.id, { operation_id: uuidv7(), expected_revision: 1 }, false, b);
  await expect(queueHardDelete(db, nb.id, { operation_id: uuidv7(), expected_revision: 2 }, a)).rejects.toMatchObject({ status: 404 });
  const job = await queueEmptyTrash(db, uuidv7(), a);
  await expect(getJob(db, job.job_id, b)).rejects.toMatchObject({ status: 404 });
  for (let i = 0; i < 3; i++) await processMaintenance(db, env.UPLOADS);
  expect((await getJob(db, job.job_id, a)).status).toBe("succeeded");
  await expect(getNote(db, na.id, a)).rejects.toMatchObject({ status: 404 });
  expect((await getNote(db, nb.id, b)).deletedAt).not.toBeNull();
});

it("rejects writes from a revoked session and cleans an upload revoked during R2 put", async () => {
  const issued = await issueAccountSession(db, secret, b.user.id, 1);
  const session = (await readAccountSession(db, secret, issued.token))!;
  const nb = await note(session);
  let uploadedKey = "";
  const bucket = new Proxy(env.UPLOADS, {
    get(target, prop) {
      if (prop === "put") return async (...args: Parameters<R2Bucket["put"]>) => {
        uploadedKey = args[0];
        const result = await target.put(...args);
        await revokeAccountSession(db, session);
        return result;
      };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(uploadAttachment(db, bucket, nb.id, uuidv7(), png(), session)).rejects.toMatchObject({ status: 401 });
  expect(uploadedKey).not.toBe("");
  expect(await env.UPLOADS.get(uploadedKey)).toBeNull();
  expect((await db.prepare("SELECT count(*) n FROM uranus_attachments WHERE note_id=? AND status='ready'").bind(nb.id).first())?.n).toBe(0);
  await expect(patchNote(db, nb.id, { operation_id: uuidv7(), expected_revision: 1, content_schema_version: 5 }, session)).rejects.toMatchObject({ status: 401 });
  expect((await getNote(db, nb.id, b)).revision).toBe(1);
});
