import type { CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "node:url";

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void };

export class BrowserWorker {
  readonly process: ReturnType<typeof Bun.spawn>;
  private pending = new Map<number, Pending>();
  private nextId = 0;
  private stopped = false;
  private closing?: Promise<void>;
  private ready: Promise<void>;

  constructor(env: Record<string, string>, entry = new URL("./index.js", import.meta.url)) {
    let ready!: () => void, fail!: (error: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
    this.process = Bun.spawn([process.execPath, fileURLToPath(entry), "--worker"], {
      env, stdin: "ignore", stdout: "ignore", stderr: "inherit",
      serialization: "advanced",
      ipc: message => {
        if (message?.ready === true) { ready(); return; }
        const pending = this.pending.get(message?.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (typeof message.error === "string") pending.reject(new Error(message.error));
        else pending.resolve(message.result);
      },
    });
    void this.process.exited.then(code => {
      this.stopped = true;
      const error = new Error(`Browser worker exited (${code})`);
      fail(error);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  async connect() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.ready, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Browser worker startup timed out")), 10000);
      })]);
    } finally { clearTimeout(timer); }
  }

  private request(method: "list" | "call" | "shutdown", fields: object = {}, options: { timeout?: number; signal?: AbortSignal } = {}): Promise<any> {
    if (this.stopped) return Promise.reject(new Error("Browser worker is closed"));
    if (options.signal?.aborted) return Promise.reject(new Error("Browser worker request cancelled"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); this.pending.delete(id); };
      const abort = () => { cleanup(); reject(new Error("Browser worker request cancelled")); };
      const timer = setTimeout(() => { cleanup(); reject(new Error("Browser worker request timed out")); }, options.timeout ?? 200000);
      this.pending.set(id, {
        resolve: value => { cleanup(); resolve(value); },
        reject: error => { cleanup(); reject(error); },
      });
      options.signal?.addEventListener("abort", abort, { once: true });
      try { this.process.send({ id, method, ...fields }); }
      catch (error) { cleanup(); reject(error); }
    });
  }

  listTools(): Promise<ListToolsResult> { return this.request("list"); }
  callTool(params: { name: string; arguments?: Record<string, unknown> }, options?: { timeout?: number; signal?: AbortSignal }): Promise<CallToolResult> {
    return this.request("call", { name: params.name, args: params.arguments || {} }, options);
  }

  close(): Promise<void> {
    return this.closing ??= this.stop();
  }

  private async stop() {
    if (this.stopped) return;
    await this.request("shutdown", {}, { timeout: 20000 }).catch(() => {});
    const wait = async (ms: number) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([this.process.exited, new Promise(resolve => { timer = setTimeout(resolve, ms); })]); }
      finally { clearTimeout(timer); }
    };
    await wait(1000);
    if (!this.stopped) { this.process.kill("SIGTERM"); await wait(2000); }
    if (!this.stopped) { this.process.kill("SIGKILL"); await this.process.exited; }
  }
}
