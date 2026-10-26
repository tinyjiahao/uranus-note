import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { hashPassword } from "../../worker/lib/password";
import { issueAccountSession, readAccountSession } from "../../worker/services/accountSessions";
import { assertOwnedResource } from "../../worker/services/ownership";

it("checks every resource graph against the session user, without an admin bypass", async () => {
  const db = env.DB;
  const hash = await hashPassword("test-password-only");
  const secret = "test-owner-secret-longer-than-thirty-two-bytes";
  for (const id of ["admin-owner", "other-owner"]) {
    await db.prepare(`INSERT INTO uranus_users(id,email,email_normalized,username,username_normalized,
      password_algorithm,password_iterations,password_salt,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,1,1)`)
      .bind(id, `${id}@example.com`, `${id}@example.com`, id, id, hash.password_algorithm, hash.password_iterations, hash.password_salt, hash.password_hash).run();
  }
  await db.batch([
    db.prepare("INSERT INTO uranus_folders(id,name,created_at,updated_at,user_id) VALUES(901,'Private',1,1,'other-owner')"),
    db.prepare(`INSERT INTO uranus_notes(id,folder_id,user_id,content_json,last_operation_id,created_at,updated_at)
      VALUES(902,901,'other-owner','{"type":"doc","content":[{"type":"paragraph"}]}','test',1,1)`),
    db.prepare("INSERT INTO uranus_note_versions(id,note_id,content_json,content_schema_v1,content_schema_version,title,char_count,source_revision,created_at) VALUES(903,902,'{}',1,5,'',0,1,1)"),
    db.prepare("INSERT INTO uranus_attachments(id,note_id,object_key,file_name,mime,size,status,created_at,updated_at) VALUES('private-image',902,'uranus/attachments/private','image','image/png',1,'ready',1,1)"),
    db.prepare("INSERT INTO uranus_operations(operation_id,scope,request_hash,status,created_at,expires_at,user_id) VALUES('private-operation','note.patch','hash','succeeded',1,2,'other-owner')"),
    db.prepare("INSERT INTO uranus_maintenance_jobs(id,kind,status,created_at,updated_at,user_id) VALUES('private-job','purge_note:902','queued',1,1,'other-owner')"),
  ]);
  const adminToken = await issueAccountSession(db, secret, "admin-owner", 1);
  const otherToken = await issueAccountSession(db, secret, "other-owner", 1);
  const admin = (await readAccountSession(db, secret, adminToken.token))!;
  const other = (await readAccountSession(db, secret, otherToken.token))!;
  for (const [resource, id] of [["folder", 901], ["note", 902], ["version", 903], ["attachment", "private-image"], ["operation", "private-operation"], ["job", "private-job"]] as const) {
    await expect(assertOwnedResource(db, admin, resource, id)).rejects.toMatchObject({ status: 404, code: "RESOURCE_NOT_FOUND" });
    await expect(assertOwnedResource(db, other, resource, id)).resolves.toBeUndefined();
    await expect(assertOwnedResource(db, other, resource, "missing")).rejects.toMatchObject({ status: 404, code: "RESOURCE_NOT_FOUND" });
  }
  await db.prepare("UPDATE uranus_notes SET purge_pending=1 WHERE id=902").run();
  await expect(assertOwnedResource(db, other, "attachment", "private-image")).rejects.toMatchObject({ status: 404 });
});
