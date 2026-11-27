import { z } from "zod";
import { regTool, toolRegistry } from "../server.js";
import { S, getPage, PROFILE_DIR } from "../state.js";
import { gotoReady } from "../helpers.js";
import { nativeViewport, osClickViewport } from "../os-input.js";
import { visibleCheckbox } from "../checkbox.js";
import { maskHeaders, maskBody } from "../redact.js";

async function invoke(name: string, args: object) {
  const tool = toolRegistry.get(name);
  if (!tool) throw new Error(`Missing tool: ${name}`);
  const result = await tool.handler(z.object(tool.schema).parse(args), {});
  if (result.isError) throw new Error(result.content?.[0]?.text || `${name} failed`);
  return result;
}

regTool("solve", "Navigate, wait for challenges, and return final URL, HTML, browser user agent and all applicable cookies (including HttpOnly). Only click a visibly rendered empty checkbox; unresolved challenges are errors.", {
  url: z.url().refine(value => /^https?:\/\//i.test(value), "Only HTTP(S) URLs are supported"),
  maxTimeout: z.number().int().min(5000).max(180000).default(60000),
  reveal_values: z.boolean().default(false).describe("Return usable cookie values; defaults to masked values in MCP"),
}, async ({ url, maxTimeout, reveal_values }) => {
  if (!S.browserUp) await invoke("browser_launch", { headless: false, fresh_profile: true, geoip: false, ublock: false });
  const page = getPage();
  const deadline = Date.now() + maxTimeout;
  let status = 200, headers: Record<string, string> = {};
  const onResponse = (response: import("playwright-core").Response) => {
    if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
      status = response.status();
      headers = response.headers();
    }
  };
  page.on("response", onResponse);
  // A wedged evaluate must not leave a timed-out solver clicking in the background.
  const timer = setTimeout(() => { void page.close().catch(() => {}); }, maxTimeout);
  let clicks = 0, lastClick = 0, clearSince = 0;
  try {
    await page.bringToFront();
    await gotoReady(page, url, "domcontentloaded", Math.min(30000, maxTimeout));
    while (Date.now() < deadline) {
      const state = await page.evaluate(() => ({
        challenge: /just a moment|checking your browser|attention required|security verification/i.test(document.title) ||
          !!document.querySelector("#challenge-running, #challenge-stage"),
        token: !!(document.querySelector('input[name="cf-turnstile-response"]') as HTMLInputElement | null)?.value,
      }));
      let widget: any = null;
      try {
        const coords = await invoke("turnstile_coords", { wait_render_ms: 0 });
        widget = JSON.parse(coords.content[0].text);
      } catch { /* Missing widget does not mean a challenge has passed. */ }
      if (!state.challenge && (!widget || state.token) && status < 400) {
        clearSince ||= Date.now();
        if (Date.now() - clearSince >= 1000) {
          const cookies = await page.context().cookies(page.url());
          const result = {
            url: page.url(), status, headers: reveal_values ? headers : maskHeaders(headers),
            response: reveal_values ? await page.content() : maskBody(await page.content()),
            cookies: cookies.map(cookie => ({ ...cookie, value: reveal_values ? cookie.value : "••• masked" })),
            userAgent: await page.evaluate(() => navigator.userAgent),
          };
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }
      } else clearSince = 0;
      if (widget && clicks < 3 && Date.now() - lastClick > 8000) {
        const innerH = await page.evaluate(() => innerHeight);
        const origin = await nativeViewport(S.activeProfileDir || PROFILE_DIR, innerH);
        const box = { left: origin.left + widget.x - 30, top: origin.top + widget.y - Math.floor(widget.height / 2), width: widget.width, height: widget.height };
        // Separate frame inspection from native capture/input; do not screenshot
        // through Playwright or assume an estimated checkbox position is ready.
        await new Promise(resolve => setTimeout(resolve, 300));
        const { captureNative } = await import("../native-screen.js");
        const pixels = captureNative(box);
        const checkbox = visibleCheckbox(pixels, { left: 0, top: 0, width: pixels.width, height: pixels.height });
        if (checkbox) {
          const clicked = await osClickViewport(S.activeProfileDir || PROFILE_DIR,
            box.left + checkbox.x - origin.left, box.top + checkbox.y - origin.top, innerH);
          if (!clicked.ok) throw new Error(clicked.detail);
          clicks++;
          lastClick = Date.now();
        }
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`Challenge unresolved within ${maxTimeout}ms (${clicks} visible-checkbox clicks); no successful solution returned`);
  } finally {
    clearTimeout(timer);
    page.off("response", onResponse);
  }
});
