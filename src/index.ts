#!/usr/bin/env bun
/**
 * MCP Camoufox — authenticated HTTP MCP and REST browser server on Bun.
 *
 * Tools: browser control (Camoufox/Firefox via Playwright's
 * Juggler) plus a browserless HTTP path that presents the same Firefox TLS
 * fingerprint, so routine fetching never has to pay for a browser launch.
 *
 * Layout
 *   state.ts     the single mutable runtime record + page bookkeeping
 *   helpers.ts   refs, clicks, fills, snapshots, paths, TOTP
 *   server.ts    the McpServer instance and the regTool registry
 *   tools/*.ts   the tools themselves, grouped by area
 *
 * Usage: bun dist/index.js (requires MCP_CAMOUFOX_API_KEY).
 * --worker is private gateway IPC, not a public stdio transport.
 */

import { shutdownBrowser } from "./tools/browser.js";
import { stopDownload } from "./install.js";

// Each tool module registers itself on import. Import order only affects the
// order tools appear in tools/list, never their behaviour.
import "./tools/browser.js";
import "./tools/input.js";
import "./tools/tabs.js";
import "./tools/capture.js";
import "./tools/inspect.js";
import "./tools/extract.js";
import "./tools/session.js";
import "./tools/http.js";
import "./tools/ergonomics.js";
import "./tools/solver.js";

async function main() {
  if (!process.argv.includes("--worker")) {
    const { startHttp } = await import("./http-server.js");
    await startHttp();
    return;
  }
  const { startWorker } = await import("./worker.js");
  startWorker(async () => { stopDownload(); await shutdownBrowser(); });
}

// An IPC disconnect means the gateway disappeared. Close the browser even
// though its pipes would otherwise keep this worker alive.
let exiting = false;
function exitCleanly() {
  if (exiting) return;
  exiting = true;
  // Never let a wedged browser keep the process alive.
  setTimeout(() => process.exit(0), 20000).unref();
  stopDownload();
  shutdownBrowser().catch(() => {}).finally(() => process.exit(0));
}
if (process.argv.includes("--worker")) {
  process.on("SIGINT", exitCleanly);
  process.on("SIGTERM", exitCleanly);
  process.on("SIGHUP", exitCleanly);
  process.on("disconnect", exitCleanly);
}

main().catch((err) => {
  console.error("[mcp-camoufox] Fatal:", err);
  process.exit(1);
});
