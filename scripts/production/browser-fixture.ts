// Explicit integration test: requires a real bundled browser, Xvfb, Openbox,
// xdotool and xwininfo. Uses only loopback fixtures, never external websites.
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";

const display = ":94";
const env = { ...process.env, DISPLAY: display };
const xvfb = Bun.spawn(["Xvfb", display, "-screen", "0", "1920x1080x24", "-nolisten", "tcp"], { env, stdout: "ignore", stderr: "inherit" });
let wm: ReturnType<typeof Bun.spawn> | undefined, gateway: ReturnType<typeof Bun.spawn> | undefined;
const token = randomUUID() + randomUUID();
const fixture = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/plain") return new Response("<title>fixture</title><h1>Ready</h1>", {
      headers: { "Content-Type": "text/html", "Set-Cookie": "fixture_secret=full-value; HttpOnly; SameSite=Lax; Path=/" },
    });
    if (path === "/empty") return new Response("<title>fixture</title>", { headers: { "Content-Type": "text/html" } });
    if (path === "/solved") return new Response("<title>fixture complete</title><h1>Passed</h1>", {
      headers: { "Content-Type": "text/html", "Set-Cookie": "fixture_clearance=trusted-click; HttpOnly; SameSite=Lax; Path=/" },
    });
    // Local rendered-widget fixture. The spinner is present first, and clicks
    // before the actual checkbox appears are recorded as failures.
    if (path === "/challenge") return new Response(`<!doctype html><title>Just a moment</title>
      <style>body{margin:100px}#widget{width:300px;height:65px;background:white;position:relative}
      #spinner{position:absolute;left:20px;top:20px;width:20px;height:20px;border:3px solid green;border-radius:50%}
      #box{position:absolute;left:20px;top:20px;width:24px;height:24px;box-sizing:border-box;border:1px solid #646464;background:white}</style>
      <div data-testid="challenge-widget" id="widget"><div id="spinner"></div></div>
      <script>
      let early=false;
      widget.onclick=()=>{early=true};
      setTimeout(()=>{spinner.remove();const box=document.createElement('div');box.id='box';
      widget.onclick=null;widget.append(box);
      box.onclick=e=>{if(e.isTrusted&&!early)location.href='/solved'}},2500);
      </script>`, { headers: { "Content-Type": "text/html" } });
    if (path === "/stuck") return new Response("<title>Just a moment</title><h1>Verifying...</h1>", { headers: { "Content-Type": "text/html" } });
    return new Response("not found", { status: 404 });
  },
});
try {
  for (let i = 0; ; i++) {
    if (Bun.spawnSync(["xdpyinfo", "-display", display], { stdout: "ignore", stderr: "ignore" }).exitCode === 0) break;
    if (i > 50) throw new Error("Xvfb unavailable");
    await Bun.sleep(100);
  }
  wm = Bun.spawn(["openbox"], { env, stdout: "ignore", stderr: "inherit" });
  gateway = Bun.spawn([process.execPath, "dist/index.js"], {
    env: { ...env, MCP_CAMOUFOX_PORT: "19378", MCP_CAMOUFOX_API_KEY: token }, stdin: "ignore", stdout: "ignore", stderr: "inherit",
  });
  const base = "http://127.0.0.1:19378";
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  for (let i = 0; ; i++) {
    try { if ((await fetch(base + "/health", { headers })).ok) break; } catch {}
    if (i > 100) throw new Error("Gateway unavailable");
    await Bun.sleep(100);
  }
  async function rest(body: object) {
    const response = await fetch(base + "/v1", { method: "POST", headers, body: JSON.stringify(body) });
    const result = await response.json();
    return { code: response.status, ...result };
  }
  const session = (await rest({ cmd: "sessions.create" })).session;
  assert.ok(session);
  const plain = await rest({ cmd: "request.get", url: fixture.url + "plain", session });
  assert.equal(plain.status, "ok", JSON.stringify(plain));
  assert.ok(plain.solution.userAgent.includes("Firefox/"));
  assert.equal(plain.solution.url, fixture.url + "plain");
  assert.ok(plain.solution.response.includes("Ready"));
  assert.ok(plain.solution.cookies.some((cookie: any) => cookie.name === "fixture_secret" && cookie.value === "full-value" && cookie.httpOnly && cookie.sameSite === "Lax"));
  const isolated = await rest({ cmd: "request.get", url: fixture.url + "empty" });
  assert.equal(isolated.status, "ok", JSON.stringify(isolated));
  assert.equal(isolated.solution.cookies.length, 0, "Cookies leaked between sessions");
  const challenge = await rest({ cmd: "request.get", url: fixture.url + "challenge", session });
  assert.equal(challenge.status, "ok", JSON.stringify(challenge));
  assert.ok(challenge.solution.url.endsWith("/solved"));
  assert.ok(challenge.solution.cookies.some((cookie: any) => cookie.name === "fixture_clearance" && cookie.value === "trusted-click" && cookie.httpOnly));
  const stuck = await rest({ cmd: "request.get", url: fixture.url + "stuck", maxTimeout: 5000 });
  assert.equal(stuck.status, "error");
  assert.equal(stuck.code, 502);
  assert.equal(stuck.solution, undefined);
  await rest({ cmd: "sessions.destroy", session });
  console.log("PASS: real browser REST cookies, isolation, delayed rendered-checkbox native click, unresolved timeout");
} finally {
  gateway?.kill("SIGTERM");
  if (gateway) await gateway.exited;
  wm?.kill("SIGTERM");
  if (wm) await wm.exited;
  xvfb.kill("SIGTERM");
  await xvfb.exited;
  await fixture.stop(true);
}
