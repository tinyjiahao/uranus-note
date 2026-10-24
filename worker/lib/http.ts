import type { Context } from "hono";
import type { Env, AppVariables } from "../types";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}

export function errorJson(c: Context<{ Bindings: Env; Variables: AppVariables }>, error: ApiError) {
  return c.json({ error: { code: error.code, message: error.message, requestId: c.get("requestId"), ...error.extra } }, error.status as 400);
}

export function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export const jsonHeaders = { "Cache-Control": "no-store", "Content-Type": "application/json; charset=UTF-8" };
