import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

// Read local credentials without including them in source or browser bundles.
export function testApiToken(): string {
  const provided = process.env.URANUS_TEST_API_TOKEN;
  if (provided) return provided;
  try {
    const token = parseEnv(readFileSync(".dev.vars", "utf8")).API_TOKEN;
    if (token) return token;
  } catch { /* Report configuration requirements, never credential contents. */ }
  throw new Error("浏览器测试需要 URANUS_TEST_API_TOKEN 或本地 .dev.vars 中的 API_TOKEN");
}
