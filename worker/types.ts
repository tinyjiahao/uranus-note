export type RateLimiterBinding = { limit(options: { key: string }): Promise<{ success: boolean }> };

export type Env = {
  DB: D1Database;
  UPLOADS: R2Bucket;
  LOGIN_RATE_LIMITER: RateLimiterBinding;
  API_TOKEN: string;
  SESSION_SECRET: string;
  APP_ORIGIN?: string;
  APP_ENV: "development" | "staging" | "production";
  SESSION_TTL_SECONDS?: string;
};

export type AppVariables = {
  requestId: string;
  session: SessionPayload;
};

export type SessionPayload = {
  sid: string;
  iat: number;
  exp: number;
  tokenFingerprint: string;
  csrf: string;
};
