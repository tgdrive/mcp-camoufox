import { dlopen, FFIType } from "bun:ffi";
import type { Pixels, Rect } from "./checkbox.js";

// Capture X11 directly: browser screenshots can resize/reposition a headed
// Camoufox window. Restrict capture to the widget rather than the full desktop.
export function captureNative(rect: Rect): Pixels {
  const lib = dlopen("libX11.so.6", {
    XOpenDisplay: { args: [FFIType.ptr], returns: FFIType.ptr },
    XDefaultRootWindow: { args: [FFIType.ptr], returns: FFIType.u64 },
    XDisplayWidth: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    XDisplayHeight: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    XGetImage: { args: [FFIType.ptr, FFIType.u64, FFIType.i32, FFIType.i32, FFIType.u32, FFIType.u32, FFIType.u64, FFIType.i32], returns: FFIType.ptr },
    XGetPixel: { args: [FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.u64_fast },
    XDestroyImage: { args: [FFIType.ptr], returns: FFIType.i32 },
    XCloseDisplay: { args: [FFIType.ptr], returns: FFIType.i32 },
  });
  const x = lib.symbols, display = x.XOpenDisplay(null);
  if (!display) { lib.close(); throw new Error("Cannot open X11 DISPLAY"); }
  let image;
  try {
    const left = Math.floor(rect.left), top = Math.floor(rect.top);
    const width = Math.ceil(rect.width), height = Math.ceil(rect.height);
    if (left < 0 || top < 0 || width <= 0 || height <= 0 ||
        left + width > x.XDisplayWidth(display, 0) || top + height > x.XDisplayHeight(display, 0))
      throw new Error("Challenge widget is outside the visible X11 screen");
    image = x.XGetImage(display, x.XDefaultRootWindow(display), left, top, width, height, 0xffffffffffffffffn, 2);
    if (!image) throw new Error("XGetImage failed");
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let col = 0; col < width; col++) {
      const value = Number(x.XGetPixel(image, col, y)), i = (y * width + col) * 4;
      data[i] = (value >>> 16) & 255;
      data[i + 1] = (value >>> 8) & 255;
      data[i + 2] = value & 255;
      data[i + 3] = 255;
    }
    return { width, height, data };
  } finally {
    if (image) x.XDestroyImage(image);
    x.XCloseDisplay(display);
    lib.close();
  }
}
