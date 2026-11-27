import { BrowserWorker } from "./worker-client.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { mkdtemp, rm, mkdir, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { PKG_VERSION } from "./helpers.js";
import { scrubErrorText } from "./redact.js";
import { camoufoxInstall } from "./install.js";
import { processesOnProfile } from "./lifecycle.js";

const restRequest = z.discriminatedUnion("cmd", [
  z.object({ cmd: z.literal("sessions.create") }).strict(),
  z.object({ cmd: z.literal("sessions.list") }).strict(),
  z.object({ cmd: z.literal("sessions.destroy"), session: z.string().uuid() }).strict(),
  z.object({
    cmd: z.literal("request.get"),
    url: z.url().refine(value => /^https?:\/\//i.test(value)),
    session: z.string().uuid().optional(),
    maxTimeout: z.number().int().min(5000).max(180000).default(60000),
  }).strict(),
]);

// Every remote session is a separate Bun IPC process with its own HOME/profile.
// The parent serializes tool execution because native mouse/X11 focus is global.
export async function startHttp() {
  const token = process.env.MCP_CAMOUFOX_API_KEY;
  if (!token || token.length < 24) throw new Error("MCP_CAMOUFOX_API_KEY must contain at least 24 characters");
  const digest = (s: string) => createHash("sha256").update(s).digest();
  const expected = digest(`Bearer ${token}`);
  const origins = new Set((process.env.MCP_CAMOUFOX_ALLOWED_ORIGINS || "").split(",").filter(Boolean));
  type Worker = {
    client: BrowserWorker; home: string;
    touched: number; busy: number; closed: boolean;
    server?: Server; http?: WebStandardStreamableHTTPServerTransport;
  };
  const rest = new Map<string, Worker>(), mcp = new Map<string, Worker>();
  const workers = new Set<Worker>();
  let tail: Promise<unknown> = Promise.resolve(), queued = 0, creating = 0, stopping = false;
  async function close(worker: Worker) {
    if (worker.closed) return;
    worker.closed = true;
    for (const map of [rest, mcp]) for (const [id, value] of map) if (value === worker) map.delete(id);
    await worker.client.close().catch(() => {});
    await worker.server?.close().catch(() => {});
    const profiles = await readdir(join(worker.home, ".camoufox-mcp")).catch(() => []);
    if (!profiles.some(profile => processesOnProfile(join(worker.home, ".camoufox-mcp", profile)).length))
      await rm(worker.home, { recursive: true, force: true });
    else console.error("[http] Preserving temporary profile: browser process still running");
    workers.delete(worker);
  }
  async function createWorker() {
    if (stopping || workers.size + creating >= 8) throw new Error("Session capacity reached");
    creating++;
    let home: string | undefined;
    try {
      home = await mkdtemp(join(tmpdir(), "mcp-camoufox-session-"));
      await mkdir(join(home, ".cache"));
      const install = await camoufoxInstall();
      await symlink(process.env.CAMOUFOX_INSTALL_DIR || install.dir, join(home, ".cache", "camoufox"));
    } catch (error) {
      if (home) await rm(home, { recursive: true, force: true });
      throw error;
    } finally { creating--; }
    const client = new BrowserWorker({ ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== "MCP_CAMOUFOX_API_KEY")), HOME: home });
    const worker: Worker = { client, home, touched: Date.now(), busy: 0, closed: false };
    workers.add(worker);
    try { await worker.client.connect(); }
    catch (error) { await close(worker); throw error; }
    return worker;
  }
  async function call(worker: Worker, name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    if (queued >= 16) throw new Error("Request queue is full");
    queued++; worker.busy++;
    const enqueued = Date.now();
    const work = tail.then(async () => {
      if (worker.closed) throw new Error("Session is closed");
      signal?.throwIfAborted();
      if (Date.now() - enqueued > 30000) throw new Error("Queue wait exceeded 30 seconds");
      try {
        const result = await worker.client.callTool({ name, arguments: args }, { timeout: 200000, signal });
        if (result.isError && JSON.stringify(result.content).includes("so it was abandoned")) await close(worker);
        return result;
      } catch (error) { await close(worker); throw error; }
    });
    tail = work.catch(() => {});
    try { return await work; }
    finally { queued--; worker.busy--; worker.touched = Date.now(); }
  }
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
  const listener = Bun.serve({
    hostname: process.env.MCP_CAMOUFOX_HOST || "127.0.0.1",
    port: Number(process.env.MCP_CAMOUFOX_PORT || 9377),
    idleTimeout: 255,
    maxRequestBodySize: 1024 * 1024,
    async fetch(request) {
      if (!timingSafeEqual(expected, digest(request.headers.get("authorization") || "")))
        return json({ error: "Unauthorized" }, 401);
      const origin = request.headers.get("origin");
      if (origin && !origins.has(origin)) return json({ error: "Origin not allowed" }, 403);
      const path = new URL(request.url).pathname;
      try {
        if (path === "/health" && request.method === "GET") return json({ status: "ok", version: PKG_VERSION });
        if (path === "/v1" && request.method === "POST") {
          const startTimestamp = Date.now();
          const parsed = restRequest.safeParse(await request.json());
          if (!parsed.success) return json({ status: "error", message: "Invalid or unsupported command/parameters" }, 400);
          const body = parsed.data;
          if (body.cmd === "sessions.create") {
            const id = randomUUID(); rest.set(id, await createWorker());
            return json({ status: "ok", session: id });
          }
          if (body.cmd === "sessions.list") return json({ status: "ok", sessions: [...rest.keys()] });
          if (body.cmd === "sessions.destroy") {
            const worker = rest.get(body.session);
            if (!worker) return json({ status: "error", message: "Unknown session" }, 404);
            if (worker.busy) return json({ status: "error", message: "Session is busy" }, 409);
            await close(worker);
            return json({ status: "ok" });
          }
          const worker = body.session ? rest.get(body.session) : await createWorker();
          if (!worker) return json({ status: "error", message: "Unknown session" }, 404);
          try {
            const result = await call(worker, "solve", { url: body.url, maxTimeout: body.maxTimeout, reveal_values: true }, request.signal);
            const text = (result.content as Array<{ type: string; text?: string }>).find(c => c.type === "text")?.text || "";
            if (result.isError) return json({ status: "error", message: text, startTimestamp, endTimestamp: Date.now() }, 502);
            return json({ status: "ok", message: "Challenge resolved", solution: JSON.parse(text), startTimestamp, endTimestamp: Date.now(), version: PKG_VERSION });
          } finally { if (!body.session) await close(worker); }
        }
        if (path === "/mcp") {
          const id = request.headers.get("mcp-session-id");
          let worker = id ? mcp.get(id) : undefined;
          if (!worker) {
            if (id) return json({ error: "Unknown session" }, 404);
            if (request.method !== "POST") return json({ error: "Initialize a session first" }, 400);
            const body = await request.clone().json();
            if (!isInitializeRequest(body)) return json({ error: "Initialize a session first" }, 400);
            worker = await createWorker();
            const current = worker;
            const server = new Server({ name: "camoufox-browser", version: PKG_VERSION }, { capabilities: { tools: {} } });
            server.setRequestHandler(ListToolsRequestSchema, () => current.client.listTools());
            server.setRequestHandler(CallToolRequestSchema, (req, extra) => call(current, req.params.name, req.params.arguments || {}, extra.signal) as any);
            const transport = new WebStandardStreamableHTTPServerTransport({
              sessionIdGenerator: randomUUID, enableJsonResponse: true,
              onsessioninitialized: session => { mcp.set(session, current); },
              onsessionclosed: () => { void close(current); },
            });
            current.server = server; current.http = transport;
            try { await server.connect(transport); }
            catch (error) { await close(current); throw error; }
          }
          worker.touched = Date.now();
          return await worker.http!.handleRequest(request);
        }
        return json({ error: "Not found" }, 404);
      } catch (error) {
        console.error("[http]", scrubErrorText(String(error)));
        return json({ status: "error", message: "Request failed; consult server diagnostics" }, 500);
      }
    },
  });
  const sweep = setInterval(() => {
    for (const worker of workers) if (!worker.busy && Date.now() - worker.touched > 15 * 60 * 1000) void close(worker);
  }, 60000);
  sweep.unref();
  const shutdown = async () => {
    stopping = true; clearInterval(sweep);
    await listener.stop(true);
    await Promise.allSettled([...workers].map(close));
  };
  // Worker signal handlers are not installed in HTTP mode.
  process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
  process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
  console.error(`[mcp-camoufox] Authenticated REST /v1 and MCP /mcp listening on ${listener.hostname}:${listener.port}`);
}
