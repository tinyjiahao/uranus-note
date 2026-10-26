import { accountApp } from "./accountApp";
import { discoverExpiredTrash, processMaintenance } from "./services/maintenance";
import { expireAccountSessions } from "./services/accountSessions";
import type { Env } from "./types";
export const app = accountApp;
export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      if (controller.cron === "0 3 * * *") await discoverExpiredTrash(env.DB);
      await processMaintenance(env.DB, env.UPLOADS);
      await expireAccountSessions(env.DB);
      await env.DB.prepare("DELETE FROM uranus_operations WHERE status <> 'pending' AND expires_at < ?").bind(Date.now()).run();
    })());
  },
} satisfies ExportedHandler<Env>;
