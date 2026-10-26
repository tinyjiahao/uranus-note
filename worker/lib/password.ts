import { passwordSchema } from "../../shared/account.ts";
import { base64url, fromBase64url, timingSafeEqual } from "./crypto.ts";

// Explicit deployment decision, plan_v6 §5.2. Never reinterpret existing records
// using a new default. This cost is below the OWASP recommendation.
export const PASSWORD_ITERATIONS = 10_000;
export type PasswordRecord = {
  password_algorithm: "pbkdf2-sha256-v1";
  password_iterations: number;
  password_salt: string;
  password_hash: string;
};

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(salt), iterations }, key, 256);
  return base64url(new Uint8Array(bits));
}

export async function hashPassword(password: string): Promise<PasswordRecord> {
  passwordSchema.parse(password);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return {
    password_algorithm: "pbkdf2-sha256-v1", password_iterations: PASSWORD_ITERATIONS,
    password_salt: base64url(salt), password_hash: await derive(password, salt, PASSWORD_ITERATIONS),
  };
}

export async function verifyPassword(password: string, record: PasswordRecord | null): Promise<boolean> {
  // Unknown accounts still perform the same derivation. No real credential is
  // retained globally, and the dummy result can never authenticate a user.
  const dummy = record === null;
  const candidate = record ?? {
    password_algorithm: "pbkdf2-sha256-v1", password_iterations: PASSWORD_ITERATIONS,
    password_salt: base64url(new Uint8Array(16)), password_hash: base64url(new Uint8Array(32)),
  };
  if (candidate.password_algorithm !== "pbkdf2-sha256-v1"
    || !Number.isSafeInteger(candidate.password_iterations)
    || candidate.password_iterations < PASSWORD_ITERATIONS || candidate.password_iterations > 100_000
    || !/^[A-Za-z0-9_-]{22}$/.test(candidate.password_salt)
    || !/^[A-Za-z0-9_-]{43}$/.test(candidate.password_hash)) return false;
  const salt = fromBase64url(candidate.password_salt);
  if (base64url(salt) !== candidate.password_salt) return false;
  const result = await derive(password, salt, candidate.password_iterations);
  return timingSafeEqual(result, candidate.password_hash) && !dummy;
}
