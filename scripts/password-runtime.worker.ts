// Isolated v6 design probe. No bindings, credentials, user data or app routes.
export default {
  async fetch() {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("runtime-probe-not-a-user-password"), "PBKDF2", false, ["deriveBits"]);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const results = [];
    // Explicitly approved v6 cost; lower than OWASP's recommendation.
    for (const iterations of [10_000]) {
      const start = performance.now();
      try {
        const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
        results.push({ iterations, supported: bits.byteLength === 32, elapsedMs: performance.now() - start });
      } catch (error) {
        results.push({ iterations, supported: false, error: error instanceof Error ? error.message : "Derivation failed" });
      }
    }
    return Response.json({ results }, { headers: { "Cache-Control": "no-store" } });
  },
};
