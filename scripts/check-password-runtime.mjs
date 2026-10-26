import { unstable_DevEnv } from "wrangler";

// Run with `node --use-env-proxy scripts/check-password-runtime.mjs`.
// Uses an ephemeral remote preview, never deploys or attaches application data.
const dev = new unstable_DevEnv();
const reloaded = new Promise((resolve) => dev.once("reloadComplete", resolve));
try {
  await dev.startWorker({
    config: "scripts/password-runtime.wrangler.jsonc",
    dev: { remote: true, server: { hostname: "127.0.0.1", port: 8788 } },
  });
  const event = await reloaded;
  const url = new URL("https://localhost/");
  Object.assign(url, event.proxyData.userWorkerUrl);
  // Use Node's proxy-aware fetch; the local workerd proxy may bypass OS proxies.
  // Never print the preview credentials, headers, or private preview URL.
  const response = await fetch(url, {
    headers: event.proxyData.headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Runtime probe HTTP ${response.status}`);
  const report = await response.json();
  console.log(JSON.stringify(report, null, 2));
  if (!report.results?.some((result) => result.iterations === 10_000 && result.supported)) process.exitCode = 1;
} finally {
  await dev.teardown();
}
