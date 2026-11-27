import { expect, test } from "bun:test";
import { SessionGet, type BrowserResponse } from "../../src/session-get.js";

const response = (status = 200, challenge = false): BrowserResponse => ({
  url: "https://example.com/api", status,
  headers: challenge ? { "cf-mitigated": "challenge" } : {},
  response: [],
});
test("30 calls share initial solve, fetch concurrently, and share expiry recovery", async () => {
  let solves = 0, active = 0, peak = 0, expired = false;
  const get = new SessionGet(async () => {
    active++; peak = Math.max(peak, active);
    const challenge = expired;
    await Bun.sleep(10);
    active--;
    return response(challenge ? 403 : 200, challenge);
  }, async () => {
    expect(active).toBe(0);
    solves++;
    await Bun.sleep(10);
    expired = false;
  });
  const batch = () => Promise.all(Array.from({ length: 30 }, () => get.get("https://example.com/api")));
  expect((await batch()).every(r => r.status === 200)).toBe(true);
  expect(solves).toBe(1);
  expect(peak).toBe(30);
  expired = true;
  expect((await batch()).every(r => r.status === 200)).toBe(true);
  expect(solves).toBe(2);
});
test("ordinary HTTP errors do not solve; persistent challenge retries only once", async () => {
  let solves = 0, challenge = false;
  const get = new SessionGet(async () => response(403, challenge), async () => { solves++; });
  expect((await get.get("https://example.com/api")).status).toBe(403);
  expect(solves).toBe(1);
  challenge = true;
  await expect(get.get("https://example.com/api")).rejects.toThrow("Challenge unresolved");
  expect(solves).toBe(2);
});
