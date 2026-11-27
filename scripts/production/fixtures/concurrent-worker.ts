import { toolRegistry } from "../../../src/server.js";
import { startWorker } from "../../../src/worker.js";

let active = 0, peak = 0;
toolRegistry.set("browser_fetch", {
  description: "Concurrency fixture", schema: {},
  handler: async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 100));
    active--;
    return { content: [{ type: "text", text: String(peak) }] };
  },
} as any);
toolRegistry.set("navigate", {
  description: "Exclusive fixture", schema: {},
  handler: async () => ({ content: [] }),
} as any);
startWorker(async () => {});
