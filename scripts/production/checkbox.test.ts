import { test, expect } from "bun:test";
import { visibleCheckbox, type Pixels } from "../../src/checkbox.js";

function fixture(kind: "empty" | "spinner" | "checked" | "blank"): Pixels {
  const width = 300, height = 65, data = new Uint8Array(width * height * 4).fill(255);
  const draw = (x: number, y: number, c: number[]) => data.set([...c, 255], (y * width + x) * 4);
  if (kind === "empty" || kind === "checked") {
    for (let y = 20; y < 44; y++) for (let x = 20; x < 44; x++)
      if (x === 20 || x === 43 || y === 20 || y === 43) draw(x, y, [100, 100, 100]);
    if (kind === "checked") for (let y = 25; y < 39; y++) for (let x = 25; x < 39; x++) draw(x, y, [40, 120, 60]);
  }
  if (kind === "spinner") {
    for (let y = 15; y < 50; y++) for (let x = 15; x < 50; x++)
      if (Math.abs(Math.hypot(x - 32, y - 32) - 11) < 2) draw(x, y, [40, 160, 70]);
  }
  return { width, height, data };
}
const box = { left: 0, top: 0, width: 300, height: 65 };
test("only a rendered empty checkbox is ready", () => {
  expect(visibleCheckbox(fixture("empty"), box)).toEqual({ x: 31.5, y: 31.5 });
  for (const kind of ["spinner", "checked", "blank"] as const)
    expect(visibleCheckbox(fixture(kind), box)).toBeNull();
});
test("offscreen regions do not produce a checkbox", () => {
  expect(visibleCheckbox(fixture("empty"), { ...box, left: 500 })).toBeNull();
});
