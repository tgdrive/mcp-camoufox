import { beforeAll, afterAll, test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { randomUUID } from "node:crypto";

const key = randomUUID() + randomUUID();
const port = 19000 + Math.floor(Math.random() * 10000);
const base = `http://127.0.0.1:${port}`;
let child: ReturnType<typeof Bun.spawn>;
const auth = { Authorization: `Bearer ${key}` };
async function rest(body: unknown) {
  return fetch(`${base}/v1`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
beforeAll(async () => {
  child = Bun.spawn([process.execPath, "dist/index.js"], {
    env: { ...process.env, MCP_CAMOUFOX_API_KEY: key, MCP_CAMOUFOX_PORT: String(port) },
    stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`, { headers: auth })).ok) return; } catch {}
    await Bun.sleep(50);
  }
  throw new Error("HTTP server did not become ready");
}, 10000);
afterAll(async () => {
  child?.kill("SIGTERM");
  if (child) await child.exited;
});
test("all HTTP surfaces require authentication", async () => {
  for (const path of ["/health", "/v1", "/mcp"])
    expect((await fetch(base + path)).status).toBe(401);
  expect((await fetch(base + "/health", { headers: { ...auth, Origin: "https://untrusted.invalid" } })).status).toBe(403);
});
test("REST sessions have lifecycle and reject unsupported commands", async () => {
  const created = await (await rest({ cmd: "sessions.create" })).json();
  expect(created.status).toBe("ok");
  const sessions = await (await rest({ cmd: "sessions.list" })).json();
  expect(sessions.sessions).toContain(created.session);
  expect((await rest({ cmd: "request.post", url: "http://localhost" })).status).toBe(400);
  expect((await rest({ cmd: "request.get", url: "file:///etc/passwd" })).status).toBe(400);
  expect((await rest({ cmd: "sessions.destroy", session: created.session })).status).toBe(200);
  expect((await rest({ cmd: "sessions.destroy", session: created.session })).status).toBe(404);
});
test("HTTP MCP initializes, lists tools and calls a tool", async () => {
  const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: auth } });
  const client = new Client({ name: "fixture", version: "1" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.some(tool => tool.name === "solve")).toBe(true);
    const status = await client.callTool({ name: "server_status", arguments: {} });
    expect(status.isError).not.toBe(true);
    await transport.terminateSession();
  } finally { await client.close(); }
}, 10000);
