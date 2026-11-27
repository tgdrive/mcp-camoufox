export interface Pixels { width: number; height: number; data: Uint8Array }
export interface Rect { left: number; top: number; width: number; height: number }

// Require four straight neutral edges and an empty light centre. Widget
// coordinates alone, a spinner, or "Verifying..." are never click readiness.
export function visibleCheckbox(image: Pixels, widget: Rect) {
  const pixel = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return [255, 255, 255];
    const i = (Math.round(y) * image.width + Math.round(x)) * 4;
    return [image.data[i], image.data[i + 1], image.data[i + 2]];
  };
  const border = (x: number, y: number) => {
    const c = pixel(x, y);
    return Math.max(...c) - Math.min(...c) < 45 && Math.max(...c) < 205;
  };
  for (let size = 18; size <= 30; size++) {
    for (let y = Math.ceil(Math.max(0, widget.top + 6)); y < Math.min(image.height, widget.top + widget.height) - size - 5; y++) {
      for (let x = Math.ceil(Math.max(0, widget.left + 8)); x < Math.min(image.width - size, widget.left + 48); x++) {
        const edges = [0, 0, 0, 0], span = size - 6;
        for (let d = 3; d < size - 3; d++) {
          edges[0] += Number(border(x + d, y));
          edges[1] += Number(border(x + d, y + size - 1));
          edges[2] += Number(border(x, y + d));
          edges[3] += Number(border(x + size - 1, y + d));
        }
        if (edges.some(count => count / span < 0.85)) continue;
        let light = 0, total = 0;
        for (let dy = 5; dy < size - 5; dy++) for (let dx = 5; dx < size - 5; dx++) {
          total++;
          light += Number(Math.min(...pixel(x + dx, y + dy)) > 220);
        }
        if (light / total > 0.95) return { x: x + (size - 1) / 2, y: y + (size - 1) / 2 };
      }
    }
  }
  return null;
}
