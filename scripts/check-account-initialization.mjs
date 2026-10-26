import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { getPlatformProxy } from "wrangler";
import { emailSchema, passwordSchema } from "../shared/account.ts";

// Read-only local preflight. Never accepts a password in argv, never enables
// remote bindings, never migrates or creates an account. Initializer service
// remains deployment-only until the owner-aware HTTP cutover is complete.
let proxy;
try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--email") throw new Error("INVALID_ARGUMENTS");
  const vars = parseEnv(await readFile(new URL("../.dev.vars", import.meta.url), "utf8"));
  if (!emailSchema.safeParse(args[1]).success || !passwordSchema.safeParse(vars.ADMIN_INITIAL_PASSWORD).success) {
    throw new Error("INVALID_INITIAL_CREDENTIALS");
  }
  proxy = await getPlatformProxy({ configPath: new URL("../wrangler.jsonc", import.meta.url).pathname, remoteBindings: false });
  const db = proxy.env.DB;
  const { results } = await db.prepare(`SELECT name FROM sqlite_master WHERE type='table'
    AND name IN ('uranus_users','uranus_account_state','uranus_initialization_guards')`).all();
  const tables = new Set(results.map((row) => row.name));
  const state = await db.prepare("SELECT mode FROM uranus_runtime_state WHERE id=1").first();
  console.log(JSON.stringify({
    localOnly: true,
    credentialsFormatValid: true,
    accountMigrationsPresent: tables.size === 3,
    initializationMarkerPresent: tables.has("uranus_account_state")
      ? Boolean(await db.prepare("SELECT 1 FROM uranus_account_state WHERE id=1").first()) : false,
    maintenanceFrozen: state?.mode === "frozen",
    writesPerformed: false,
  }, null, 2));
} catch (error) {
  // Do not print raw configuration/binding errors or validation input.
  const code = ["INVALID_ARGUMENTS", "INVALID_INITIAL_CREDENTIALS"].includes(error?.message)
    ? error.message : "LOCAL_INITIALIZATION_CHECK_FAILED";
  console.error(code);
  process.exitCode = 1;
} finally {
  await proxy?.dispose();
}
