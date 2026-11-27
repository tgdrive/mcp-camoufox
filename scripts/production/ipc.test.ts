import { test, expect } from "bun:test";
import { BrowserWorker } from "../../src/worker-client.js";

const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
function fixture() { return new BrowserWorker(env, new URL("./ipc-fixture.ts", import.meta.url)); }
test("Bun IPC correlates concurrent replies and ignores stdout", async () => {
  const worker = fixture();
  try {
    await worker.connect();
    const [first, second] = await Promise.all([
      worker.callTool({ name: "echo", arguments: { value: "first", delay: 100 } }),
      worker.callTool({ name: "echo", arguments: { value: "second" } }),
    ]);
    expect(first.content).toEqual([{ type: "text", text: "first" }]);
    expect(second.content).toEqual([{ type: "text", text: "second" }]);
  } finally { await worker.close(); }
  expect(await worker.process.exited).toBe(0);
  await expect(worker.callTool({ name: "echo" })).rejects.toThrow("closed");
});
test("worker crashes reject in-flight calls rather than hanging", async () => {
  const worker = fixture();
  try {
    await worker.connect();
    const waiting = worker.callTool({ name: "hang" });
    const crashed = worker.callTool({ name: "crash" });
    const results = await Promise.allSettled([waiting, crashed]);
    expect(results.every(result => result.status === "rejected")).toBe(true);
    expect(await worker.process.exited).toBe(17);
  } finally { await worker.close(); }
});
test("IPC requests have deadlines and honour cancellation", async () => {
  const worker = fixture();
  try {
    await worker.connect();
    await expect(worker.callTool({ name: "hang" }, { timeout: 20 })).rejects.toThrow("timed out");
    const controller = new AbortController();
    const call = worker.callTool({ name: "hang" }, { signal: controller.signal });
    controller.abort();
    await expect(call).rejects.toThrow("cancelled");
    await expect(worker.callTool({ name: "hang" }, { signal: controller.signal })).rejects.toThrow("cancelled");
  } finally { await worker.close(); }
  expect(await worker.process.exited).toBe(0);
});
test("workers refuse startup without a Bun IPC parent", async () => {
  const child = Bun.spawn([process.execPath, "dist/index.js", "--worker"], {
    stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  expect(await child.exited).not.toBe(0);
});
