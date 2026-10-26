import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
// Credentials stay in the local test process and are never printed.
export function testEmail() { return process.env.URANUS_TEST_EMAIL || "admin@admin.com"; }
export function testPassword(): string {
  const provided = process.env.URANUS_TEST_PASSWORD;
  if (provided) return provided;
  const password = parseEnv(readFileSync(".dev.vars", "utf8")).ADMIN_INITIAL_PASSWORD;
  if (!password) throw new Error("Browser tests require URANUS_TEST_PASSWORD or local ADMIN_INITIAL_PASSWORD");
  return password;
}
