import { test, expect } from "bun:test";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("bundled mode refuses missing browser without starting a downloader", async () => {
  const home = await mkdtemp(join(tmpdir(), "camoufox-bundled-test-"));
  const marker = join(home, "download-attempted");
  try {
    const child = Bun.spawn([process.execPath, "-e",
      'import { ensureCamoufoxBinary } from "./dist/install.js"; await ensureCamoufoxBinary();',
    ], {
      env: { ...process.env, HOME: home, XDG_CACHE_HOME: join(home, ".cache"), MCP_CAMOUFOX_BUNDLED: "1",
        MCP_CAMOUFOX_FETCH_COMMAND: JSON.stringify([process.execPath, "-e", `await Bun.write(${JSON.stringify(marker)}, "unexpected");`]) },
      stdout: "pipe", stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).not.toBe(0);
    expect(stderr).toContain("runtime browser downloads are disabled");
    expect(await access(marker).then(() => true, () => false)).toBe(false);
  } finally { await rm(home, { recursive: true, force: true }); }
});
