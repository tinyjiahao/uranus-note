// Deployment-only access through Wrangler's authenticated remote bindings.
// Never exposed as an application HTTP endpoint. No password in argv or logs.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { randomUUID } from "node:crypto";
import { unstable_DevEnv, unstable_readConfig } from "wrangler";
import { backup, verify, migrate } from "./local-operations.mjs";
import { initializeDefaultAccount } from "../worker/services/initializeAccount.ts";
import { passwordSchema } from "../shared/account.ts";
import { verifyPassword } from "../worker/lib/password.ts";
import assert from "node:assert/strict";

export async function remoteProxy() {
  const config = unstable_readConfig({ config: "wrangler.jsonc" });
  if (config.d1_databases?.length !== 1 || config.d1_databases[0].binding !== "DB" || config.r2_buckets?.length !== 1 || config.r2_buckets[0].binding !== "UPLOADS") throw new Error("UNEXPECTED_BINDINGS");
  await mkdir(".wrangler/remote-operations", { recursive: true, mode: 0o700 });
  const path = resolve(".wrangler/remote-operations/wrangler.json");
  const operationsKey = randomUUID() + randomUUID();
  await writeFile(path, JSON.stringify({ name: config.name, main: resolve("scripts/operations-preview.worker.ts"), workers_dev: false, compatibility_date: config.compatibility_date, account_id: config.account_id,
    d1_databases: config.d1_databases.map(binding => ({ ...binding, preview_database_id: binding.database_id })),
    r2_buckets: config.r2_buckets.map(binding => ({ ...binding, preview_bucket_name: binding.bucket_name })),
  }), { mode: 0o600 });
  const dev = new unstable_DevEnv();
  const reloaded = new Promise(resolve => dev.once("reloadComplete", resolve));
  try {
    await dev.startWorker({ config: path, bindings: { OPERATIONS_KEY: { type: "secret_text", value: operationsKey } }, dev: { remote: true, server: { hostname: "127.0.0.1", port: 8791 } } });
    const event = await reloaded, url = new URL("https://localhost/");
    Object.assign(url, event.proxyData.userWorkerUrl);
    const call = async body => {
      const response = await fetch(url, { method: "POST", headers: { ...event.proxyData.headers, "content-type": "application/json", "x-operations-key": operationsKey }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
      if (!response.ok && !(body.action === "get" && response.status === 404)) throw Object.assign(new Error("REMOTE_BINDING_OPERATION_FAILED"), { safeCode: `HTTP_${response.status}_${body.action}` });
      return response;
    };
    const batch = async statements => (await call({ action: "db", statements })).json();
    const prepare = (sql, params = []) => ({ sql, params, bind: (...values) => prepare(sql, values),
      all: async () => (await batch([{ sql, params }]))[0], run: async () => (await batch([{ sql, params }]))[0],
      first: async () => (await batch([{ sql, params }]))[0].results[0] ?? null });
    return { env: { DB: { prepare, batch: statements => batch(statements.map(({ sql, params }) => ({ sql, params }))) }, UPLOADS: {
      list: async options => (await call({ action: "list", cursor: options.cursor })).json(),
      head: async key => (await call({ action: "head", key })).json(),
      get: async key => { const response = await call({ action: "get", key }); return response.status === 404 ? null : { ...JSON.parse(response.headers.get("x-object-metadata")), arrayBuffer: () => response.arrayBuffer() }; },
    } }, dispose: () => dev.teardown() };
  } catch (error) { await dev.teardown(); throw error; }
}

export async function run(command, args = []) {
  if (!["status", "backup", "migrate", "initialize", "resume", "audit"].includes(command)) throw new Error("INVALID_COMMAND");
  let vars;
  if (command === "initialize" || command === "audit") {
    vars = parseEnv(await readFile(".env.production.local", "utf8"));
    passwordSchema.parse(vars.ADMIN_INITIAL_PASSWORD);
  }
  const proxy = await remoteProxy();
  try {
    const db = proxy.env.DB, bucket = proxy.env.UPLOADS;
    const stateOf = () => db.prepare("SELECT mode,generation,maintenance_id FROM uranus_runtime_state WHERE id=1").first();
    if (command === "status") {
      const migrations = (await db.prepare("SELECT name FROM uranus_d1_migrations ORDER BY id").all()).results;
      const counts = await db.prepare("SELECT (SELECT COUNT(*) FROM uranus_notes) AS notes,(SELECT COUNT(*) FROM uranus_attachments) AS attachments,(SELECT COUNT(*) FROM uranus_operations WHERE status='pending') AS pending_operations,(SELECT COUNT(*) FROM uranus_maintenance_jobs WHERE status='running') AS running_jobs,(SELECT COUNT(*) FROM uranus_attachments WHERE status IN ('pending','deleting')) AS active_attachments").first();
      console.log(JSON.stringify({ remote: true, state: await stateOf(), migrations, counts }));
    }
    if (command === "backup") {
      if (!args[0]) throw new Error("BACKUP_PATH_REQUIRED");
      const result = await backup(db, bucket, resolve(args[0]));
      await verify(resolve(args[0]));
      console.log(JSON.stringify({ verified: true, maintenanceId: result.maintenanceId, counts: result.counts, objects: result.files.filter(f => f.objectKey).length }));
    }
    if (command === "audit") {
      const { files, manifest } = await verify(resolve(args[0]));
      assert.equal((await stateOf()).mode, "frozen");
      const marker = await db.prepare("SELECT * FROM uranus_account_state WHERE id=1").first();
      assert.equal(marker.ownership_ready, 1);
      const account = await db.prepare("SELECT * FROM uranus_users WHERE id=?").bind(marker.default_user_id).first();
      assert.equal(await verifyPassword(vars.ADMIN_INITIAL_PASSWORD, account), true);
      for (const table of Object.keys(manifest.counts).filter(t => !["uranus_users", "uranus_account_state"].includes(t))) {
        const before = files.filter(f => f.table === table).flatMap(f => JSON.parse(f.bytes));
        const after = (await db.prepare("SELECT * FROM " + table + " ORDER BY rowid").all()).results;
        assert.equal(after.length, before.length);
        before.forEach((row, i) => { for (const key of Object.keys(row)) assert.deepEqual(after[i][key], row[key]); });
        if (["uranus_folders", "uranus_notes", "uranus_operations", "uranus_maintenance_jobs"].includes(table)) assert.equal(after.every(row => row.user_id === marker.default_user_id), true);
      }
      console.log(JSON.stringify({ ownershipVerified: true, initialPasswordVerified: true, originalRowsUnchanged: true }));
    }
    if (command === "migrate" || command === "initialize") {
      const source = command === "migrate" ? args[0] : args[1];
      if (!source) throw new Error("VERIFIED_BACKUP_REQUIRED");
      const { manifest } = await verify(resolve(source)), state = await stateOf();
      if (state.mode !== "frozen" || state.maintenance_id !== manifest.maintenanceId || state.generation !== manifest.generation) throw new Error("BACKUP_FREEZE_MISMATCH");
      if (command === "migrate") { await migrate(db); console.log("Remote migrations applied; instance remains frozen"); }
      else console.log(JSON.stringify(await initializeDefaultAccount(db, { email: args[0], password: vars.ADMIN_INITIAL_PASSWORD, maintenanceId: state.maintenance_id })));
    }
    if (command === "resume") {
      if (!args[0] || !await db.prepare("SELECT 1 FROM uranus_account_state WHERE id=1 AND ownership_ready=1").first()) throw new Error("OWNERSHIP_NOT_READY");
      const guard = randomUUID();
      await db.batch([db.prepare("INSERT INTO uranus_initialization_guards VALUES(?,?,1)").bind(guard, args[0]), db.prepare("DELETE FROM uranus_initialization_guards WHERE id=?").bind(guard), db.prepare("UPDATE uranus_runtime_state SET mode='normal',maintenance_id=NULL,started_at=NULL WHERE id=1 AND mode='frozen' AND maintenance_id=?").bind(args[0])]);
      console.log(JSON.stringify({ resumed: (await stateOf()).mode === "normal" }));
    }
  } finally { await proxy.dispose(); }
}
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  try { await run(process.argv[2], process.argv.slice(3)); }
  catch (error) { console.error("REMOTE_OPERATION_FAILED: inspect protected instance state; no secrets logged.", error.safeCode ?? error.name, error.cause?.code ?? ""); process.exitCode = 1; }
}
