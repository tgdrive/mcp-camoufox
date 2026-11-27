// Shared test harness: drives isolated browser workers over Bun IPC and serves
// local fixtures. The rpc adapter preserves existing suite assertions.
import { BrowserWorker } from "../../dist/worker-client.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "fs";
import http from "http";
import { homedir, platform, tmpdir } from "os";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join } from "path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DIST = join(ROOT, "dist", "index.js");

/** Where camoufox-js keeps the browser under a given HOME (see its pkgman.js). */
export function camoufoxCache(home) {
  if (platform() === "darwin") return join(home, "Library", "Caches", "camoufox");
  if (platform() === "win32") return join(home, "AppData", "Local", "camoufox", "camoufox", "Cache");
  return join(home, ".cache", "camoufox");
}

/** A throwaway HOME that shares only the Camoufox binary with the real one, so no test
 *  can reach ~/.camoufox-mcp and the real logins in it. */
export function sandboxHome() {
  const home = mkdtempSync(join(tmpdir(), "mcp-camoufox-home-"));
  const real = process.env.CAMOUFOX_INSTALL_DIR || camoufoxCache(homedir());
  if (existsSync(real)) {
    const link = camoufoxCache(home);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(real, link);
  }
  return home;
}

/** Spawn the MCP server and return a client. `call` returns the flattened text
 *  of a tool result, prefixed with "IS_ERROR: " when the tool reported one, and
 *  "[IMAGE …]" when it returned image content. */
export async function startServer(distPath = DIST, { home: givenHome = null } = {}) {
  const home = givenHome || sandboxHome();
  const worker = new BrowserWorker({ ...process.env, HOME: home, USERPROFILE: home }, pathToFileURL(distPath));
  await worker.connect();
  const rpc = async (method, params) => {
    try {
      if (method === "tools/list") return { result: await worker.listTools() };
      if (method === "tools/call") return { result: await worker.callTool(params, { timeout: Number(process.env.MCPC_RPC_TIMEOUT_MS) || 180000 }) };
      throw new Error(`Unsupported test RPC: ${method}`);
    } catch (error) { return { error: { message: String(error?.message || error) } }; }
  };
  const call = async (name, args = {}) => {
    const r = await rpc("tools/call", { name, arguments: args });
    if (r.error) return `RPC_ERROR: ${r.error.message}`;
    const items = r.result?.content || [];
    const text = items.filter(c => c.type === "text").map(c => c.text).join("\n");
    const img = items.find(c => c.type === "image");
    return (r.result?.isError ? "IS_ERROR: " : "") + (img ? `[IMAGE ${img.mimeType} b64len=${img.data.length}]\n` : "") + text;
  };
  return { proc: worker.process, rpc, call, home, stderr: () => "", kill: async () => {
    await worker.close();
    try { rmSync(home, { recursive: true, force: true }); } catch {}
  } };
}

/** Minimal fixture server. `routes` maps a pathname to (req,res,state)=>void.
 *  The port is chosen by the OS: a fixed port meant one crashed run left the port
 *  bound and every later run died on EADDRINUSE with an unhandled error event. */
export async function fixtureServer(routes, _port) {
  const state = {};
  const server = http.createServer((req, res) => {
    const path = req.url.split("?")[0];
    const handler = routes[path] || routes["*"];
    if (!handler) { res.writeHead(404); return res.end("no route"); }
    handler(req, res, state);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);          // otherwise this throws as an unhandled event
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  // probe(): is the fixture itself still answering? When a navigation times out
  // this separates "the server went deaf" from "the browser page is wedged".
  const probe = () => new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${port}/`, res => { res.resume(); resolve(`HTTP ${res.statusCode}`); });
    req.setTimeout(3000, () => { req.destroy(); resolve("NO RESPONSE in 3s"); });
    req.on("error", e => resolve(`ERR ${e.message}`));
  });
  const sockets = () => new Promise(resolve => server.getConnections((e, n) => resolve(e ? `?${e.message}` : n)));
  return { url: `http://127.0.0.1:${port}`, port, state, probe, sockets, close: () => server.close() };
}

export function html(body, title = "Fixture") {
  return `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
}

/** Poll `fn` until it returns a truthy value, or give up. Replaces fixed sleeps:
 *  a hard-coded 1200ms both wastes a second when the event is instant and still
 *  fails on a slow machine. Returns the last value either way, so the caller's
 *  assertion — not a timeout — decides the verdict. */
export async function until(fn, timeoutMs = 5000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() >= deadline) return last;
    await new Promise(r => setTimeout(r, stepMs));
  }
}

/** Pull a snapshot ref out of browser_snapshot output by a substring match. */
export function refOf(snapshot, needle) {
  const line = (snapshot || "").split("\n").find(l => l.includes("ref=") && l.includes(needle));
  return line ? line.trim().split(/\s+/)[0].replace("ref=", "") : null;
}

const ONLY = (process.env.MCPC_ONLY || "").toLowerCase();

export function runner(suiteName) {
  const results = [];
  const check = async (name, fn) => {
    // MCPC_ONLY is a debugging aid, never a verification: checks share browser
    // state, so skipping earlier ones can make a later one pass or fail for the
    // wrong reason. test.mjs prints a banner whenever it is set.
    if (ONLY && !name.toLowerCase().includes(ONLY)) return;
    // MCPC_TRACE=1 names each check as it starts, so a hang shows where it is.
    if (process.env.MCPC_TRACE) console.error(`[trace ${new Date().toISOString().slice(11, 19)}] ${suiteName}: ${name}`);
    try {
      const [ok, detail] = await fn();
      results.push({ name, ok, detail: String(detail ?? "").replace(/\s+/g, " ").slice(0, 140) });
    } catch (e) {
      results.push({ name, ok: false, detail: "THREW: " + String(e?.message || e).replace(/\s+/g, " ").slice(0, 140) });
    }
    if (process.env.MCPC_TRACE) { const r = results.at(-1); console.error(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(52)} ${r.detail}`); }
  };
  const report = () => {
    const pass = results.filter(r => r.ok).length;
    console.log(`\n${"=".repeat(96)}\n${suiteName}`);
    for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(52)} ${r.detail}`);
    console.log(`${"=".repeat(96)}\n${suiteName}: ${pass}/${results.length} passed, ${results.length - pass} failed`);
    return { pass, total: results.length, failures: results.filter(r => !r.ok) };
  };
  return { check, report, results };
}
