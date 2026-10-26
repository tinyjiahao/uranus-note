import { env } from "cloudflare:workers";
import { initializeDefaultAccount } from "../worker/services/initializeAccount";
export const testAccount = { email: "admin@example.com", password: "test-account-password" };
export async function initializeTestAccount() {
  if (await env.DB.prepare("SELECT 1 FROM uranus_account_state WHERE id=1").first()) return;
  await env.DB.prepare("UPDATE uranus_runtime_state SET mode='frozen',maintenance_id='test-fixture' WHERE id=1").run();
  await initializeDefaultAccount(env.DB, { ...testAccount, maintenanceId: "test-fixture" });
  await env.DB.prepare("UPDATE uranus_runtime_state SET mode='normal',maintenance_id=NULL WHERE id=1").run();
}
