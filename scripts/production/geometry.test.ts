import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { osClickViewport } from "../../src/os-input.js";

test("native input uses absolute client origin and fails closed on missing geometry", async () => {
  if (process.platform !== "linux") return;
  const root = mkdtempSync(join(tmpdir(), "camoufox-geometry-"));
  const oldPath = process.env.PATH;
  const log = join(root, "calls");
  try {
    process.env.PATH = `${root}:${oldPath}`;
    writeFileSync(join(root, "ps"), "#!/bin/sh\necho '123 /opt/camoufox/camoufox -profile /tmp/geometry-fixture'\n", { mode: 0o755 });
    writeFileSync(join(root, "xdotool"), `#!/bin/sh
echo "$*" >> '${log}'
case "$1" in
 search) echo 4194307 ;;
 getwindowgeometry) printf 'X=642\\nY=356\\nWIDTH=1280\\nHEIGHT=805\\n' ;;
esac
`, { mode: 0o755 });
    writeFileSync(join(root, "xwininfo"), "#!/bin/sh\nprintf 'Absolute upper-left X: 641\\nAbsolute upper-left Y: 338\\nWidth: 1280\\nHeight: 805\\n'\n", { mode: 0o755 });
    const result = await osClickViewport("/tmp/geometry-fixture", 230, 225, 720);
    expect(result.ok).toBe(true);
    expect(result.screenX).toBe(871);
    expect(result.screenY).toBe(648);
    expect(readFileSync(log, "utf8")).toContain("mousemove --sync 871 648");
    writeFileSync(log, "");
    writeFileSync(join(root, "xwininfo"), "#!/bin/sh\necho unavailable\n", { mode: 0o755 });
    expect((await osClickViewport("/tmp/geometry-fixture", 230, 225, 720)).ok).toBe(false);
    expect(readFileSync(log, "utf8")).not.toContain("click 1");
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
});
