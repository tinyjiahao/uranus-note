import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const source = resolve(process.argv[2] ?? "");
const origin = process.env.URANUS_ORIGIN?.replace(/\/$/, "");
const token = process.env.URANUS_API_TOKEN;
if (!process.argv[2] || !origin || !token) throw new Error("用法：URANUS_ORIGIN=... URANUS_API_TOKEN=... npm run restore -- <backup-directory>");
const shaHex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const shaUrl = (value) => createHash("sha256").update(value).digest("base64url");
const manifestBytes = await readFile(join(source, "manifest.json"));
await readFile(join(source, "COMPLETE"));
const manifest = JSON.parse(manifestBytes.toString("utf8"));
if (manifest.backupFormatVersion !== 1 || ![1, 2, 3].includes(manifest.contentSchemaVersion)) throw new Error("备份格式或正文 schema 与当前版本不兼容");
for (const [relative, expected] of Object.entries(manifest.files)) {
  const bytes = await readFile(join(source, relative));
  if (bytes.length !== expected.bytes || shaHex(bytes) !== expected.sha256) throw new Error(`${relative} 校验失败`);
}
for (const [relative, expected] of Object.entries(manifest.attachmentFiles)) {
  const bytes = await readFile(join(source, relative));
  if (bytes.length !== expected.bytes || shaHex(bytes) !== expected.sha256) throw new Error(`${relative} 校验失败`);
}
const uuidv7 = () => {
  const bytes = randomBytes(16); const time = BigInt(Date.now());
  for (let i = 5; i >= 0; i--) bytes[i] = Number((time >> BigInt((5 - i) * 8)) & 255n);
  bytes[6] = (bytes[6] & 15) | 112; bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString("hex"); return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
};
const loginResponse = await fetch(`${origin}/api/session`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
if (!loginResponse.ok) throw new Error(`登录失败 (${loginResponse.status})`);
const session = await loginResponse.json();
const cookie = loginResponse.headers.get("set-cookie")?.split(";")[0];
if (!cookie || !session.csrfToken) throw new Error("登录响应缺少会话信息");
const headers = { Cookie: cookie, Origin: origin, "X-CSRF-Token": session.csrfToken };
const maintenanceId = process.env.URANUS_MAINTENANCE_ID || uuidv7();
const modeResponse = await fetch(`${origin}/api/maintenance/mode`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ operation_id: maintenanceId, purpose: "restore" }) });
const mode = await modeResponse.json();
if (!modeResponse.ok || mode.mode !== "restoring" || mode.maintenance_id !== maintenanceId) throw new Error(`无法进入恢复模式：${JSON.stringify(mode)}`);
const backupId = shaHex(manifestBytes).slice(0, 32);
const records = {};
for (const entity of ["folders", "notes", "versions", "attachments", "refs"]) {
  const content = await readFile(join(source, `records/${entity}.jsonl`), "utf8");
  records[entity] = content.trim() ? content.trimEnd().split("\n").map((line) => JSON.parse(line)) : [];
}
const restoredAttachmentIds = new Set(records.attachments.filter((item) => item.status === "ready").map((item) => item.id));
records.attachments = records.attachments.filter((item) => restoredAttachmentIds.has(item.id));
records.refs = records.refs.filter((item) => restoredAttachmentIds.has(item.attachment_id));
const sendBatch = async (entity, items, index) => {
  const checksum = shaUrl(JSON.stringify(items));
  const response = await fetch(`${origin}/api/maintenance/restore`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ maintenance_id: maintenanceId, backup_id: backupId, batch_id: `${entity}:${index}`, entity, checksum, items }) });
  if (!response.ok) throw new Error(`${entity}:${index} 恢复失败 (${response.status})：${await response.text()}`);
};
for (const entity of ["folders", "notes", "versions", "attachments"]) {
  for (let offset = 0; offset < records[entity].length; offset += 50) await sendBatch(entity, records[entity].slice(offset, offset + 50), offset / 50);
}
for (const [relative, expected] of Object.entries(manifest.attachmentFiles)) {
  if (!restoredAttachmentIds.has(expected.attachmentId)) continue;
  const bytes = await readFile(join(source, relative));
  const response = await fetch(`${origin}/api/maintenance/restore?attachment_id=${encodeURIComponent(expected.attachmentId)}`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/octet-stream", "X-Maintenance-Id": maintenanceId, "X-Backup-Id": backupId, "X-Batch-Id": `attachment:${expected.attachmentId}`, "X-Content-SHA256": createHash("sha256").update(bytes).digest("base64url"), "Content-Length": String(bytes.length) }, body: bytes,
  });
  if (!response.ok) throw new Error(`${basename(relative)} 恢复失败 (${response.status})：${await response.text()}`);
}
for (let offset = 0; offset < records.refs.length; offset += 50) await sendBatch("refs", records.refs.slice(offset, offset + 50), offset / 50);
const search = records.notes.map((item) => ({ note_id: item.id }));
for (let offset = 0; offset < search.length; offset += 50) await sendBatch("search", search.slice(offset, offset + 50), offset / 50);
await sendBatch("finalize", [], 0);
console.log(`恢复完成并通过服务端完整性检查，maintenance_id：${maintenanceId}`);
if (process.env.URANUS_EXIT_MAINTENANCE === "1") {
  const response = await fetch(`${origin}/api/maintenance/mode`, { method: "DELETE", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ maintenance_id: maintenanceId, confirm: true }) });
  if (!response.ok) throw new Error(`恢复完成，但解除冻结失败 (${response.status})`);
  console.log("已明确解除冻结，实例可写");
} else console.log("目标仍处于 frozen；完成抽样核验后设置 URANUS_EXIT_MAINTENANCE=1，并使用相同 maintenance_id 执行解除操作。");
