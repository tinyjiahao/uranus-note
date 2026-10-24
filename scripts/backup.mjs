import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const origin = process.env.URANUS_ORIGIN?.replace(/\/$/, "");
const token = process.env.URANUS_API_TOKEN;
if (!origin || !token) throw new Error("请通过 URANUS_ORIGIN 和 URANUS_API_TOKEN 环境变量提供目标与令牌");
const destination = resolve(process.argv[2] ?? `backups/uranus-${new Date().toISOString().replaceAll(":", "-")}`);
const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
const uuidv7 = () => {
  const bytes = randomBytes(16); const time = BigInt(Date.now());
  for (let i = 5; i >= 0; i--) bytes[i] = Number((time >> BigInt((5 - i) * 8)) & 255n);
  bytes[6] = (bytes[6] & 15) | 112; bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
};
const loginResponse = await fetch(`${origin}/api/session`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
if (!loginResponse.ok) throw new Error(`登录失败 (${loginResponse.status})`);
const session = await loginResponse.json();
const cookie = loginResponse.headers.get("set-cookie")?.split(";")[0];
if (!cookie || !session.csrfToken) throw new Error("登录响应缺少会话信息");
const headers = { Cookie: cookie, Origin: origin, "X-CSRF-Token": session.csrfToken };
const maintenanceId = process.env.URANUS_MAINTENANCE_ID || uuidv7();
let mode;
for (let attempt = 0; attempt < 30; attempt++) {
  const response = await fetch(`${origin}/api/maintenance/mode`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ operation_id: maintenanceId }) });
  mode = await response.json();
  if (response.ok && mode.mode === "frozen") break;
  if (response.status !== 202) throw new Error(`无法进入维护模式：${JSON.stringify(mode)}`);
  await sleep(2_000);
}
if (mode?.mode !== "frozen") throw new Error("仍有无法确认结束的在途操作；实例保持 draining，请处理后使用相同 URANUS_MAINTENANCE_ID 重试");

await mkdir(join(destination, "records"), { recursive: true });
await mkdir(join(destination, "attachments"), { recursive: true });
const api = async (path) => {
  const response = await fetch(`${origin}${path}`, { headers: { Cookie: cookie } });
  if (!response.ok) throw new Error(`${path} 返回 ${response.status}`);
  return response;
};
const metadata = await (await api(`/api/maintenance/backup?maintenance_id=${maintenanceId}&entity=metadata`)).json();
const manifest = { ...metadata, createdAt: new Date().toISOString(), files: {}, attachmentFiles: {} };
const exported = {};
for (const entity of ["folders", "notes", "versions", "attachments", "refs"]) {
  let cursor = 0; const items = [];
  do {
    const page = await (await api(`/api/maintenance/backup?maintenance_id=${maintenanceId}&entity=${entity}&cursor=${cursor}&limit=100`)).json();
    items.push(...page.items.map(({ backup_rowid, ...item }) => item));
    cursor = page.nextCursor ?? 0;
  } while (cursor);
  exported[entity] = items;
  const bytes = Buffer.from(items.map((item) => JSON.stringify(item)).join("\n") + (items.length ? "\n" : ""));
  const relative = `records/${entity}.jsonl`;
  await writeFile(join(destination, relative), bytes);
  manifest.files[relative] = { count: items.length, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
for (const attachment of exported.attachments) {
  if (attachment.status !== "ready") continue;
  const response = await api(`/api/attachments/${attachment.id}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const relative = `attachments/${attachment.id}.bin`;
  await writeFile(join(destination, relative), bytes);
  manifest.attachmentFiles[relative] = { attachmentId: attachment.id, objectKey: attachment.object_key, bytes: bytes.length, etag: attachment.etag, sha256: createHash("sha256").update(bytes).digest("hex") };
}
await writeFile(join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
await writeFile(join(destination, "COMPLETE"), `${manifest.createdAt}\n${maintenanceId}\n`);
console.log(`备份完成：${destination}`);
console.log(`maintenance_id：${maintenanceId}`);
if (process.env.URANUS_EXIT_MAINTENANCE === "1") {
  const response = await fetch(`${origin}/api/maintenance/mode`, { method: "DELETE", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ maintenance_id: maintenanceId, confirm: true }) });
  if (!response.ok) throw new Error(`备份成功，但退出维护模式失败 (${response.status})`);
  console.log("已按 URANUS_EXIT_MAINTENANCE=1 明确退出维护模式");
} else console.log("实例仍处于 frozen；确认备份后设置 URANUS_EXIT_MAINTENANCE=1 并以相同 maintenance_id 再运行，或调用维护 API 退出。");
