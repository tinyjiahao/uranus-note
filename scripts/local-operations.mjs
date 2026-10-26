// Deployment-only local bindings. No HTTP credentials, no public admin route.
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseEnv } from "node:util";
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler";
import { initializeDefaultAccount } from "../worker/services/initializeAccount.ts";

const tables = ["uranus_users", "uranus_folders", "uranus_notes", "uranus_note_search", "uranus_note_versions", "uranus_attachments", "uranus_attachment_refs", "uranus_operations", "uranus_maintenance_jobs", "uranus_account_state"];
const digest = value => createHash("sha256").update(value).digest("hex");
const root = new URL("../", import.meta.url).pathname;
const keyPath = resolve(process.env.URANUS_BACKUP_KEY_FILE || join(root, ".wrangler/backup.key"));
async function key(create = false) {
  if (create) { await mkdir(resolve(keyPath, ".."), { recursive: true, mode: 0o700 }); try { await writeFile(keyPath, randomBytes(32), { flag: "wx", mode: 0o600 }); } catch (e) { if (e.code !== "EEXIST") throw e; } }
  const value = await readFile(keyPath);
  if (value.length !== 32) throw new Error("INVALID_BACKUP_KEY");
  return value;
}
function seal(bytes, secret) { const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", secret, iv); const body = Buffer.concat([cipher.update(bytes), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]); }
function open(bytes, secret) { const cipher = createDecipheriv("aes-256-gcm", secret, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]); }
const stateOf = db => db.prepare("SELECT * FROM uranus_runtime_state WHERE id=1").first();

export async function freeze(db) {
  let state = await stateOf(db);
  if (state.mode === "normal") {
    await db.prepare("UPDATE uranus_runtime_state SET mode='draining', generation=generation+1, maintenance_id=?, started_at=? WHERE id=1 AND mode='normal'").bind(randomUUID(), Date.now()).run();
    state = await stateOf(db);
  }
  if (!["draining", "frozen"].includes(state.mode)) throw new Error("MAINTENANCE_BUSY");
  const active = await db.prepare("SELECT (SELECT COUNT(*) FROM uranus_operations WHERE status='pending') + (SELECT COUNT(*) FROM uranus_maintenance_jobs WHERE status='running') + (SELECT COUNT(*) FROM uranus_attachments WHERE status IN ('pending','deleting')) AS count").first();
  if (active.count) throw new Error("DRAIN_REQUIRED_STOP_SERVER_AND_RESOLVE_INFLIGHT_OPERATIONS");
  await db.prepare("UPDATE uranus_runtime_state SET mode='frozen' WHERE id=1 AND maintenance_id=? AND mode='draining'").bind(state.maintenance_id).run();
  return stateOf(db);
}

export async function backup(db, bucket, destination) {
  // A completed archive is immutable; use a new directory for a new snapshot.
  try { await readFile(join(destination, "COMPLETE")); throw new Error("BACKUP_ALREADY_COMPLETE"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const state = await freeze(db), secret = await key(true);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const manifest = { format: 2, maintenanceId: state.maintenance_id, generation: state.generation, files: [], counts: {}, migrations: (await db.prepare("SELECT name FROM uranus_d1_migrations ORDER BY id").all()).results };
  let index = 0;
  const save = async (bytes, metadata) => {
    const file = String(index++) + ".enc", encrypted = seal(bytes, secret);
    await writeFile(join(destination, file), encrypted, { mode: 0o600 });
    manifest.files.push({ ...metadata, file, sha256: digest(encrypted), plainSha256: digest(bytes) });
  };
  for (const table of tables) {
    // Pre-v6 snapshots legitimately lack account tables; all older tables are required.
    if (["uranus_users", "uranus_account_state"].includes(table) && !await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").bind(table).first()) {
      manifest.counts[table] = 0;
      continue;
    }
    let cursor = 0, count = 0;
    for (;;) {
      const rows = (await db.prepare("SELECT rowid AS backup_rowid,* FROM " + table + " WHERE rowid>? ORDER BY rowid LIMIT 50").bind(cursor).all()).results;
      if (!rows.length) break;
      cursor = rows.at(-1).backup_rowid;
      const items = rows.map(({ backup_rowid, ...row }) => row);
      await save(Buffer.from(JSON.stringify(items)), { table, count: items.length });
      count += items.length;
    }
    manifest.counts[table] = count;
  }
  let cursor;
  do {
    const page = await bucket.list({ prefix: "uranus/attachments/", limit: 100, ...(cursor ? { cursor } : {}) });
    for (const item of page.objects) {
      const object = await bucket.get(item.key);
      if (!object) throw new Error("ATTACHMENT_DISAPPEARED");
      await save(Buffer.from(await object.arrayBuffer()), { objectKey: item.key, httpMetadata: object.httpMetadata, customMetadata: object.customMetadata });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const ready = (await db.prepare("SELECT object_key,size FROM uranus_attachments WHERE status='ready'").all()).results;
  for (const row of ready) { const object = await bucket.head(row.object_key); if (!object || object.size !== row.size || !manifest.files.some(file => file.objectKey === row.object_key)) throw new Error("READY_ATTACHMENT_MISSING"); }
  const current = await stateOf(db);
  if (current.mode !== "frozen" || current.generation !== state.generation || current.maintenance_id !== state.maintenance_id) throw new Error("FREEZE_CHANGED");
  const encrypted = seal(Buffer.from(JSON.stringify(manifest)), secret);
  await writeFile(join(destination, "manifest.enc"), encrypted, { mode: 0o600 });
  await writeFile(join(destination, "COMPLETE"), digest(encrypted), { mode: 0o600 });
  return manifest;
}
export async function verify(source) {
  const secret = await key(), bytes = await readFile(join(source, "manifest.enc"));
  if ((await readFile(join(source, "COMPLETE"), "utf8")) !== digest(bytes)) throw new Error("INCOMPLETE_BACKUP");
  const manifest = JSON.parse(open(bytes, secret));
  if (manifest.format !== 2) throw new Error("INVALID_BACKUP_FORMAT");
  const files = [];
  for (const file of manifest.files) {
    if (!/^\d+\.enc$/.test(file.file) || (file.table && !tables.includes(file.table)) || (file.objectKey && !file.objectKey.startsWith("uranus/attachments/"))) throw new Error("INVALID_BACKUP_PATH");
    const encrypted = await readFile(join(source, file.file));
    if (digest(encrypted) !== file.sha256) throw new Error("BACKUP_CHECKSUM_MISMATCH");
    const bytes = open(encrypted, secret);
    if (digest(bytes) !== file.plainSha256) throw new Error("BACKUP_CHECKSUM_MISMATCH");
    files.push({ ...file, bytes });
  }
  return { manifest, files, backupId: digest(bytes) };
}
export async function restore(db, bucket, source) {
  const { manifest, files, backupId } = await verify(source);
  const state = await stateOf(db);
  const maintenanceId = "restore:" + backupId;
  if (state.mode === "normal") {
    for (const table of tables.filter(t => t !== "uranus_folders")) if ((await db.prepare("SELECT COUNT(*) AS count FROM " + table).first()).count) throw new Error("RESTORE_TARGET_NOT_EMPTY");
    if ((await db.prepare("SELECT COUNT(*) AS count FROM uranus_folders WHERE system_key IS NULL OR user_id IS NOT NULL").first()).count || (await bucket.list({ prefix: "uranus/attachments/", limit: 1 })).objects.length) throw new Error("RESTORE_TARGET_NOT_EMPTY");
    await db.batch([
      db.prepare("UPDATE uranus_runtime_state SET mode='restoring',generation=generation+1,maintenance_id=?,started_at=? WHERE id=1 AND mode='normal'").bind(maintenanceId, Date.now()),
      db.prepare("DELETE FROM uranus_folders WHERE user_id IS NULL AND system_key='default'"),
      db.prepare("DELETE FROM uranus_sessions"),
    ]);
  } else if (state.maintenance_id !== maintenanceId || !["restoring", "frozen"].includes(state.mode)) throw new Error("RESTORE_ALREADY_ACTIVE");
  for (const file of files) {
    const done = await db.prepare("SELECT checksum FROM uranus_restore_batches WHERE backup_id=? AND batch_id=?").bind(backupId, file.file).first();
    if (done) { if (done.checksum !== file.sha256) throw new Error("RESTORE_BATCH_MISMATCH"); continue; }
    const statements = [];
    if (file.table) {
      const columns = new Set((await db.prepare("PRAGMA table_info(" + file.table + ")").all()).results.map(row => row.name));
      for (const row of JSON.parse(file.bytes)) {
        const names = Object.keys(row);
        if (names.some(name => !columns.has(name))) throw new Error("UNKNOWN_BACKUP_COLUMN");
        statements.push(db.prepare("INSERT INTO " + file.table + "(" + names.join(",") + ") VALUES(" + names.map(() => "?").join(",") + ")").bind(...names.map(name => row[name])));
      }
    } else {
      await bucket.put(file.objectKey, file.bytes, { httpMetadata: file.httpMetadata, customMetadata: file.customMetadata });
      const check = await bucket.get(file.objectKey);
      if (!check || digest(Buffer.from(await check.arrayBuffer())) !== file.plainSha256) throw new Error("RESTORE_OBJECT_MISMATCH");
    }
    statements.push(db.prepare("INSERT INTO uranus_restore_batches(backup_id,batch_id,checksum,entity,created_at) VALUES(?,?,?,?,?)").bind(backupId, file.file, file.sha256, file.table || "attachment_bytes", Date.now()));
    await db.batch(statements);
  }
  for (const table of tables) if ((await db.prepare("SELECT COUNT(*) AS count FROM " + table).first()).count !== manifest.counts[table]) throw new Error("RESTORE_COUNT_MISMATCH");
  const foreignKeys = (await db.prepare("PRAGMA foreign_key_check").all()).results.filter(row => row.table.startsWith("uranus_"));
  if (foreignKeys.length) throw new Error("RESTORE_FOREIGN_KEY_FAILURE");
  await db.prepare("UPDATE uranus_runtime_state SET mode='frozen' WHERE id=1 AND maintenance_id=?").bind(maintenanceId).run();
  return { maintenanceId, counts: manifest.counts };
}
export async function migrate(db) {
  await db.prepare("CREATE TABLE IF NOT EXISTS uranus_d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)").run();
  for (const name of (await readdir(join(root, "migrations/d1"))).filter(n => n.endsWith(".sql")).sort()) {
    if (await db.prepare("SELECT 1 FROM uranus_d1_migrations WHERE name=?").bind(name).first()) continue;
    const sql = await readFile(join(root, "migrations/d1", name), "utf8");
    await db.batch([...unstable_splitSqlQuery(sql).map(statement => db.prepare(statement)), db.prepare("INSERT INTO uranus_d1_migrations(name) VALUES(?)").bind(name)]);
  }
}

export async function run(command = process.argv[2], args = process.argv.slice(3)) {
  if (!["backup", "restore", "initialize", "resume", "status", "migrate"].includes(command)) throw new Error("USAGE: local-operations.mjs backup|restore|initialize|resume|status|migrate");
  const proxy = await getPlatformProxy({ configPath: join(root, "wrangler.jsonc"), remoteBindings: false, ...(process.env.URANUS_LOCAL_STATE_DIR ? { persist: { path: resolve(process.env.URANUS_LOCAL_STATE_DIR) } } : {}) });
  try {
    const db = proxy.env.DB, bucket = proxy.env.UPLOADS;
    if (command === "migrate") { await migrate(db); console.log("Local migrations applied"); }
    if (command === "status") console.log(JSON.stringify(await stateOf(db)));
    if (command === "backup") { const dest = resolve(args[0] || "backups/v6-" + Date.now()); const result = await backup(db, bucket, dest); console.log(JSON.stringify({ destination: dest, keyFile: keyPath, maintenanceId: result.maintenanceId, counts: result.counts })); }
    if (command === "restore") { if (!args[0]) throw new Error("BACKUP_PATH_REQUIRED"); console.log(JSON.stringify(await restore(db, bucket, resolve(args[0])))); }
    if (command === "initialize") {
      if (!args[0] || !args[1]) throw new Error("EMAIL_AND_VERIFIED_BACKUP_PATH_REQUIRED");
      const { manifest } = await verify(resolve(args[1]));
      const state = await stateOf(db);
      if (state.mode !== "frozen" || state.maintenance_id !== manifest.maintenanceId || state.generation !== manifest.generation) throw new Error("VERIFIED_BACKUP_DOES_NOT_MATCH_FREEZE");
      const vars = parseEnv(await readFile(join(root, ".dev.vars"), "utf8"));
      console.log(JSON.stringify(await initializeDefaultAccount(db, { email: args[0], password: vars.ADMIN_INITIAL_PASSWORD, maintenanceId: state.maintenance_id })));
    }
    if (command === "resume") {
      if (!args[0] || !await db.prepare("SELECT 1 FROM uranus_account_state WHERE id=1 AND ownership_ready=1").first()) throw new Error("OWNERSHIP_NOT_READY");
      const guard = randomUUID();
      await db.batch([db.prepare("INSERT INTO uranus_initialization_guards VALUES(?,?,1)").bind(guard, args[0]), db.prepare("DELETE FROM uranus_initialization_guards WHERE id=?").bind(guard), db.prepare("UPDATE uranus_runtime_state SET mode='normal',maintenance_id=NULL,started_at=NULL WHERE id=1 AND mode='frozen' AND maintenance_id=?").bind(args[0])]);
      console.log("Local instance resumed");
    }
  } finally { await proxy.dispose(); }
}
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  try { await run(); } catch { console.error("LOCAL_OPERATION_FAILED: instance remains protected; inspect status and retry the same operation. No secrets logged."); process.exitCode = 1; }
}
