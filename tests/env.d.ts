import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      UPGRADE_DB: D1Database;
      UPLOADS: R2Bucket;
      TEST_MIGRATIONS: D1Migration[];
      SESSION_SECRET: string;
      APP_ENV: "development";
      APP_ORIGIN: "http://uranus.test";
      SESSION_TTL_SECONDS: string;
      LOGIN_RATE_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> };
    }
  }
}

export {};
