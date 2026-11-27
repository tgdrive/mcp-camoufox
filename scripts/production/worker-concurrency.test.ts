import { expect, test } from "bun:test";
import { BrowserWorker } from "../../src/worker-client.js";

test("one IPC worker handles 30 fetches concurrently and survives admission errors", async () => {
  const worker = new BrowserWorker(
    Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    new URL("./fixtures/concurrent-worker.ts", import.meta.url),
  );
  try {
    await worker.connect();
    const calls = Array.from({ length: 30 }, () => worker.callTool({ name: "browser_fetch" }));
    await expect(worker.callTool({ name: "navigate" })).rejects.toThrow("Worker is busy");
    const results = await Promise.all(calls);
    expect(results).toHaveLength(30);
    expect(results.every(result => result.content.some(item => item.type === "text" && item.text === "30"))).toBe(true);
    await expect(worker.callTool({ name: "navigate" })).resolves.toBeDefined();
  } finally {
    await worker.close();
  }
});
