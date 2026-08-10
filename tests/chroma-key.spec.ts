import { test, expect } from "@playwright/test";
import {
  applyChromaKey,
  toChroma,
  KEY_COLOR,
  DEFAULTS,
  type Rgb,
} from "../src/lib/chromaKey";

// The avatar's backdrop, #557455. Its saturation is 0.267 — just under the 0.3
// cutoff the old hue+saturation key used, which is why it came out ~15% opaque
// green instead of transparent, and why compression noise made it flicker.
const BACKDROP: Rgb = KEY_COLOR;

const SKIN: Rgb = { r: 0xc6, g: 0x86, b: 0x42 };
const GREY: Rgb = { r: 0x67, g: 0x67, b: 0x67 }; // same luma as the backdrop
const DARK_HAIR: Rgb = { r: 0x14, g: 0x18, b: 0x14 }; // dark + slightly green

const W = 64;
const H = 64;

/** A frame that is all backdrop except a foreground block on the right half. */
function buildFrame(foreground: Rgb, jitter = 0): Uint8ClampedArray {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const isForeground = x >= W / 2;
      const c = isForeground ? foreground : BACKDROP;
      // Per-channel jitter, so this is genuine *chroma* noise. Offsetting all
      // three channels equally would only move luma, which a chroma key ignores
      // by construction — that would make this test pass for free.
      const j = (seed: number) =>
        jitter && !isForeground
          ? Math.round((((x * 7 + y * 13 + seed * 29) % (jitter * 2 + 1)) - jitter))
          : 0;
      data[i] = c.r + j(1);
      data[i + 1] = c.g + j(2);
      data[i + 2] = c.b + j(3);
      data[i + 3] = 255;
    }
  }
  return data;
}

/** Alpha at a pixel, avoiding the 1px border the feather pass can't cover. */
function alphaAt(data: Uint8ClampedArray, x: number, y: number): number {
  return data[(y * W + x) * 4 + 3];
}

test.describe("chroma key against the #557455 backdrop", () => {
  test("keys the backdrop fully transparent, not a 15% haze", () => {
    const data = buildFrame(SKIN);
    applyChromaKey(data, W, H, { feather: false });

    // Sample well inside the backdrop half.
    expect(alphaAt(data, 10, 32)).toBe(0);
    expect(alphaAt(data, 20, 10)).toBe(0);
  });

  test("regression: the old hue+saturation key left it partly opaque", () => {
    // Reproduces the previous algorithm to pin down what was actually wrong.
    const { r, g, b } = BACKDROP;
    const max = Math.max(r, g, b) / 255;
    const min = Math.min(r, g, b) / 255;
    const saturation = max === 0 ? 0 : (max - min) / max;

    expect(saturation).toBeGreaterThan(0.08); // above the ramp floor...
    expect(saturation).toBeLessThan(0.3); // ...but below "fully transparent"

    const t = (saturation - 0.08) / (0.3 - 0.08);
    const oldAlpha = Math.round(255 * (1 - t));
    expect(oldAlpha).toBeGreaterThan(30); // the visible green haze

    // The new key resolves the same colour to fully transparent.
    const data = buildFrame(SKIN);
    applyChromaKey(data, W, H, { feather: false });
    expect(alphaAt(data, 10, 32)).toBe(0);
  });

  test("keeps skin, neutral grey and dark hair opaque", () => {
    for (const fg of [SKIN, GREY, DARK_HAIR]) {
      const data = buildFrame(fg);
      applyChromaKey(data, W, H, { feather: false });
      expect(alphaAt(data, W - 10, 32)).toBe(255);
    }
  });

  test("compression noise on the backdrop does not flicker", () => {
    // Every backdrop pixel must land at alpha 0 despite +/-6 of RGB jitter. Any
    // partial value here is a pixel that would shimmer frame to frame.
    const data = buildFrame(SKIN, 6);
    applyChromaKey(data, W, H, { feather: false });

    const partial: number[] = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W / 2; x++) {
        const a = alphaAt(data, x, y);
        if (a !== 0) partial.push(a);
      }
    }
    expect(partial).toEqual([]);
  });

  test("neutral grey sits outside the key radius", () => {
    // The safety margin that stops her hair and clothes dissolving.
    const [kb, kr] = toChroma(BACKDROP.r, BACKDROP.g, BACKDROP.b);
    const [gb, gr] = toChroma(GREY.r, GREY.g, GREY.b);
    const distance = Math.hypot(gb - kb, gr - kr);
    expect(distance).toBeGreaterThan(DEFAULTS.outerRadius);
  });

  test("renders in a real browser canvas with no green fringe", async ({ page }) => {
    const before = Array.from(buildFrame(SKIN));
    const keyed = buildFrame(SKIN);
    applyChromaKey(keyed, W, H);

    // Put the keyed frame on a real canvas over a magenta ground: any surviving
    // backdrop shows up as green contamination in the composite.
    const sampled = await page.evaluate(
      ({ pixels, w, h }) => {
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d")!;

        ctx.fillStyle = "#ff00ff";
        ctx.fillRect(0, 0, w, h);

        const layer = document.createElement("canvas");
        layer.width = w;
        layer.height = h;
        const lctx = layer.getContext("2d")!;
        const img = lctx.createImageData(w, h);
        img.data.set(new Uint8ClampedArray(pixels));
        lctx.putImageData(img, 0, 0);
        ctx.drawImage(layer, 0, 0);

        const out = ctx.getImageData(0, 0, w, h).data;
        const at = (x: number, y: number) => {
          const i = (y * w + x) * 4;
          return [out[i], out[i + 1], out[i + 2]];
        };
        return { backdrop: at(10, 32), foreground: at(w - 10, 32) };
      },
      { pixels: Array.from(keyed), w: W, h: H }
    );

    // Backdrop area composites to pure magenta — the avatar's ground is gone.
    expect(sampled.backdrop).toEqual([255, 0, 255]);
    // Foreground still reads as skin, not magenta.
    expect(sampled.foreground[0]).toBeGreaterThan(sampled.foreground[2]);

    expect(before.length).toBe(W * H * 4);
  });
});
