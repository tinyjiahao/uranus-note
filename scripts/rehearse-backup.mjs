// Restore an encrypted archive into a new isolated LOCAL target, never production.
import { mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { getPlatformProxy } from "wrangler";
import { migrate, restore } from "./local-operations.mjs";

if (!process.argv[2]) throw new Error("BACKUP_PATH_REQUIRED");
const directory = await mkdtemp(resolve(".wrangler/backup-rehearsal-"));
const proxy = await getPlatformProxy({ configPath: "tests/v6.wrangler.jsonc", remoteBindings: false, persist: { path: directory } });
try {
  await migrate(proxy.env.DB);
  const result = await restore(proxy.env.DB, proxy.env.UPLOADS, resolve(process.argv[2]));
  console.log(JSON.stringify({ verifiedLocalRestore: true, directory, counts: result.counts }));
} catch { console.error("ISOLATED_RESTORE_FAILED"); process.exitCode = 1; }
finally { await proxy.dispose(); }
