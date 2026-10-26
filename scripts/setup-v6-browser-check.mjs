import { getPlatformProxy } from "wrangler";
import { resolve } from "node:path";
import { migrate } from "./local-operations.mjs";
import { initializeDefaultAccount } from "../worker/services/initializeAccount.ts";
const proxy = await getPlatformProxy({ configPath: resolve("tests/v6.wrangler.jsonc"), remoteBindings: false, persist: { path: resolve(".wrangler/v6-browser-check/v3") } });
try {
  const db = proxy.env.DB;
  await migrate(db);
  await db.prepare("UPDATE uranus_runtime_state SET mode='frozen',maintenance_id='browser-fixture' WHERE id=1").run();
  await initializeDefaultAccount(db, { email: "admin@example.test", password: "test-browser-password", maintenanceId: "browser-fixture" });
  await db.prepare("UPDATE uranus_runtime_state SET mode='normal',maintenance_id=NULL WHERE id=1").run();
  console.log("Isolated browser fixture ready; no user development data changed");
} finally { await proxy.dispose(); }
