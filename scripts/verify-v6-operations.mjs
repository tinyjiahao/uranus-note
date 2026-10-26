// Isolated, synthetic fixtures only; never touches the user's local or remote data.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, cp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { getPlatformProxy } from "wrangler";
import { backup, restore, verify, migrate } from "./local-operations.mjs";
import { initializeDefaultAccount } from "../worker/services/initializeAccount.ts";
import { verifyPassword } from "../worker/lib/password.ts";

const directory = await mkdtemp(resolve(".wrangler/v6-verification-"));
const configPath = resolve("tests/v6.wrangler.jsonc");
const proxies = [];
const connect = async name => { const proxy = await getPlatformProxy({ configPath, remoteBindings: false, persist: { path: join(directory, name) } }); proxies.push(proxy); await migrate(proxy.env.DB); return proxy.env; };
try {
  const source = await connect("source"), target = await connect("target");
  const db = source.DB;
  await db.prepare("UPDATE uranus_runtime_state SET mode='frozen',maintenance_id='fixture' WHERE id=1").run();
  const account = await initializeDefaultAccount(db, { email: "admin@example.test", password: "test-only-password", maintenanceId: "fixture" });
  const again = await initializeDefaultAccount(db, { email: "ignored@example.test", password: "not-the-original-password", maintenanceId: "fixture" });
  assert.equal(again.created, false); assert.equal(account.userId, again.userId);
  const before = await db.prepare("SELECT * FROM uranus_users WHERE id=?").bind(account.userId).first();
  assert.equal(await verifyPassword("test-only-password", before), true);
  await db.prepare("INSERT INTO uranus_sessions(credential_digest,user_id,credential_version,csrf,created_at,expires_at) VALUES('test-session',?,1,'test-csrf',1,9999999999999)").bind(account.userId).run();
  for (const env of [source, target]) {
    await env.DB.prepare("CREATE TABLE unrelated_v6_probe(id TEXT PRIMARY KEY,value TEXT)").run();
    await env.DB.prepare("INSERT INTO unrelated_v6_probe VALUES('keep','untouched')").run();
    await env.UPLOADS.put("other-app/keep", "untouched");
  }
  await source.UPLOADS.put("uranus/attachments/test-fixture.bin", "private-fixture-bytes");
  const destination = join(directory, "backup");
  await backup(db, source.UPLOADS, destination);
  const checked = await verify(destination);
  assert.equal(checked.manifest.counts.uranus_users, 1);
  assert.equal(checked.files.some(file => file.table === "uranus_sessions"), false);
  assert.equal((await readFile(join(destination, "manifest.enc"))).includes(Buffer.from("admin@example.test")), false);
  await assert.rejects(() => backup(db, source.UPLOADS, destination), /BACKUP_ALREADY_COMPLETE/);
  // Interrupt after a committed batch, then resume the same backup.
  let calls = 0;
  const interrupted = new Proxy(target.DB, { get(db, prop) {
    if (prop === "batch") return async statements => { if (++calls === 3) throw new Error("SIMULATED_INTERRUPTION"); return db.batch(statements); };
    const value = db[prop]; return typeof value === "function" ? value.bind(db) : value;
  } });
  await assert.rejects(() => restore(interrupted, target.UPLOADS, destination), /SIMULATED_INTERRUPTION/);
  await restore(target.DB, target.UPLOADS, destination);
  await restore(target.DB, target.UPLOADS, destination);
  assert.deepEqual(await target.DB.prepare("SELECT * FROM uranus_users WHERE id=?").bind(account.userId).first(), before);
  assert.equal((await target.DB.prepare("SELECT COUNT(*) n FROM uranus_sessions").first()).n, 0);
  assert.equal((await target.DB.prepare("SELECT default_user_id FROM uranus_account_state").first()).default_user_id, account.userId);
  assert.equal(await (await target.UPLOADS.get("uranus/attachments/test-fixture.bin")).text(), "private-fixture-bytes");
  for (const env of [source, target]) {
    assert.equal((await env.DB.prepare("SELECT value FROM unrelated_v6_probe").first()).value, "untouched");
    assert.equal(await (await env.UPLOADS.get("other-app/keep")).text(), "untouched");
  }
  const corrupted = join(directory, "corrupted");
  await cp(destination, corrupted, { recursive: true });
  const file = checked.files[0].file, bytes = await readFile(join(corrupted, file));
  bytes[bytes.length - 1] ^= 1; await writeFile(join(corrupted, file), bytes);
  await assert.rejects(() => verify(corrupted), /BACKUP_CHECKSUM_MISMATCH/);
  await target.DB.prepare("UPDATE uranus_runtime_state SET mode='normal',maintenance_id=NULL WHERE id=1").run();
  await assert.rejects(() => restore(target.DB, target.UPLOADS, destination), /RESTORE_TARGET_NOT_EMPTY/);
  console.log(JSON.stringify({ passed: ["encrypted-account-roundtrip", "no-session-restoration", "interrupted-resume", "idempotent-replay", "checksum-rejection", "nonempty-rejection", "unrelated-D1-R2-preserved", "initialization-does-not-reset-password"], directory }));
} finally { for (const proxy of proxies) await proxy.dispose(); }
