export type RateLimiterBinding = { limit(options: { key: string }): Promise<{ success: boolean }> };

export type Env = {
  DB: D1Database;
  UPLOADS: R2Bucket;
  LOGIN_RATE_LIMITER: RateLimiterBinding;
  SESSION_SECRET: string;
  APP_ORIGIN?: string;
  APP_ENV: "development" | "staging" | "production";
  SESSION_TTL_SECONDS?: string;
  REGISTRATION_ENABLED?: string;
};

export type AppVariables = {
  requestId: string;
  accountSession: import("./services/accountSessions").AccountSession | undefined;
};
