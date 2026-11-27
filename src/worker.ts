import { z } from "zod";
import { toolRegistry } from "./server.js";
import { scrubErrorText } from "./redact.js";

const request = z.discriminatedUnion("method", [
  z.object({ id: z.number().int(), method: z.literal("list") }),
  z.object({ id: z.number().int(), method: z.literal("call"), name: z.string(), args: z.record(z.string(), z.unknown()) }),
  z.object({ id: z.number().int(), method: z.literal("shutdown") }),
]);

// Private Bun IPC, not MCP or newline-delimited JSON on stdin/stdout.
export function startWorker(shutdown: () => Promise<void>) {
  if (!process.send || !process.connected) throw new Error("Browser workers require a Bun IPC parent");
  let busy = false, fetching = 0, stopping = false;
  process.on("message", async message => {
    const parsed = request.safeParse(message);
    if (!parsed.success) return;
    const req = parsed.data;
    const send = (response: object) => { if (process.connected) process.send!({ id: req.id, ...response }); };
    try {
      if (req.method === "shutdown") {
        stopping = true;
        await shutdown();
        send({ result: null });
        process.disconnect?.();
        return;
      }
      if (stopping) throw new Error("Worker is shutting down");
      if (req.method === "list") {
        send({ result: { tools: [...toolRegistry].map(([name, tool]) => ({
          name, description: tool.description,
          inputSchema: z.toJSONSchema(z.object(tool.schema), { target: "draft-7", io: "input", unrepresentable: "any" }),
        })) } });
        return;
      }
      const concurrent = req.name === "browser_fetch";
      if (busy || (!concurrent && fetching > 0)) throw new Error("Worker is busy");
      if (concurrent && fetching >= 32) throw new Error("Fetch capacity reached");
      const tool = toolRegistry.get(req.name);
      if (!tool) throw new Error("Unknown tool");
      const args = z.object(tool.schema).parse(req.args);
      if (concurrent) fetching++; else busy = true;
      try { send({ result: await tool.handler(args, {}) }); }
      finally { if (concurrent) fetching--; else busy = false; }
    } catch (error) { send({ error: scrubErrorText(String(error)) }); }
  });
  process.send({ ready: true });
}
