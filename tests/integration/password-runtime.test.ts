import { expect, it } from "vitest";

// Local capability check only: remote Workers impose a different limit.
// The mandatory remote gate is scripts/check-password-runtime.mjs.
it("local workerd supports the approved 10000 PBKDF2 iterations (not a remote release gate)", async () => {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("runtime-probe-not-a-user-password"), "PBKDF2", false, ["deriveBits"]);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  for (const iterations of [10_000]) {
    const start = performance.now();
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
    expect(bits.byteLength).toBe(32);
    console.info(`PBKDF2 runtime gate: iterations=${iterations}, elapsedMs=${Math.round(performance.now() - start)}`);
  }
});
