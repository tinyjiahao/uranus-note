import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context } from "hono";
import type { Env, AppVariables } from "../types";
import { readAccountSession, type AccountSession } from "./accountSessions";

type AccountContext = Context<{ Bindings: Env; Variables: AppVariables }>;
export const MAX_REMEMBERED_ACCOUNTS = 5;
const COOKIE = "uranus_accounts";
export type RememberedAccount = { token: string; session: AccountSession };

// Only already signed, independently revocable credentials live in this
// HttpOnly cookie. User ids supplied by the browser never authorize a switch.
export async function rememberedAccounts(c: AccountContext): Promise<RememberedAccount[]> {
  const raw = getCookie(c, COOKIE) ?? "";
  const tokens = raw.length <= 1000 ? raw.split("~").slice(0, MAX_REMEMBERED_ACCOUNTS) : [];
  const active = getCookie(c, "uranus_session");
  if (active) tokens.unshift(active);
  const result: RememberedAccount[] = [];
  for (const token of new Set(tokens)) {
    const session = await readAccountSession(c.env.DB, c.env.SESSION_SECRET, token);
    if (session && !result.some(entry => entry.session.user.id === session.user.id)) result.push({ token, session });
    if (result.length === MAX_REMEMBERED_ACCOUNTS) break;
  }
  return result;
}

export function writeRememberedAccounts(c: AccountContext, entries: { token: string; session: Pick<AccountSession, "expiresAt"> }[]) {
  const options = { httpOnly: true, secure: c.env.APP_ENV !== "development", sameSite: "Strict" as const, path: "/" };
  if (!entries.length) { deleteCookie(c, COOKIE, options); return; }
  const expires = Math.max(...entries.map(entry => entry.session.expiresAt));
  setCookie(c, COOKIE, entries.map(entry => entry.token).join("~"), {
    ...options, maxAge: Math.max(0, Math.floor((expires - Date.now()) / 1000)), expires: new Date(expires),
  });
}
