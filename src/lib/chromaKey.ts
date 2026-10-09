// Chroma-key for the Simli avatar's studio backdrop.
//
// Why not hue+saturation: the previous version keyed on hue 80-160 with a
// saturation cutoff of 0.3. That worked for a vivid green screen, but the
// current face (3d1cf1cf) renders on #557455 — a *desaturated* green whose
// saturation is 0.267, just under the cutoff. Every backdrop pixel landed in
// the soft-edge ramp instead of going transparent, leaving a ~15% opaque green
// haze, and frame-to-frame compression noise tipping pixels across 0.3 made it
// flicker.
//
// Instead we measure distance from the known backdrop colour in *chroma* (Cb/Cr)
// only, ignoring brightness. Chroma is what stays constant across the shadows
// and vignetting on a studio backdrop, so a tight radius keys the whole cloth
// while leaving neutral greys — which sit ~16 units away — untouched.

export type Rgb = { r: number; g: number; b: number };

/** The backdrop colour the avatar renders on. */
export const KEY_COLOR: Rgb = { r: 0x55, g: 0x74, b: 0x55 }; // #557455

export type ChromaKeyOptions = {
  /** Backdrop colour to remove. */
  key?: Rgb;
  /** Chroma distance fully inside the backdrop -> alpha 0. */
  innerRadius?: number;
  /** Chroma distance fully outside -> alpha 255. Between the two, ramp. */
  outerRadius?: number;
  /** Pixels darker than this (0..1) are never keyed — protects hair shadows. */
  valueFloor?: number;
  /** Blur the alpha channel to smooth the cutout edge. */
  feather?: boolean;
};

// Tight on purpose. A neutral grey is ~16.5 chroma units from #557455, so
// outerRadius must stay well under that or her hair and clothes start
// dissolving. Widen only if the backdrop itself shows fringing.
export const DEFAULTS = {
  innerRadius: 7,
  outerRadius: 14,
  valueFloor: 0.15,
  feather: true,
} as const;

/** BT.601 chroma. Luma is deliberately discarded. */
export function toChroma(r: number, g: number, b: number): [number, number] {
  const cb = -0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 0.5 * r - 0.418688 * g - 0.081312 * b;
  return [cb, cr];
}

/**
 * Knock the backdrop out of an RGBA frame, in place.
 *
 * Returns the same buffer for convenience. Exported separately from the React
 * component so it can be tested against synthetic frames without a live avatar.
 */
export function applyChromaKey(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options: ChromaKeyOptions = {}
): Uint8ClampedArray {
  const key = options.key ?? KEY_COLOR;
  const inner = options.innerRadius ?? DEFAULTS.innerRadius;
  const outer = options.outerRadius ?? DEFAULTS.outerRadius;
  const valueFloor = options.valueFloor ?? DEFAULTS.valueFloor;
  const feather = options.feather ?? DEFAULTS.feather;

  const [keyCb, keyCr] = toChroma(key.r, key.g, key.b);
  const span = Math.max(outer - inner, 1e-6);

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    // Very dark pixels carry almost no reliable chroma, so keying them would
    // punch holes in shadowed hair.
    if (Math.max(r, g, b) / 255 < valueFloor) continue;

    const [cb, cr] = toChroma(r, g, b);
    const dist = Math.hypot(cb - keyCb, cr - keyCr);

    if (dist >= outer) continue; // clearly foreground, leave opaque

    if (dist <= inner) {
      data[i + 3] = 0;
      continue;
    }

    // Edge pixel: ramp alpha, and pull the backdrop colour out of it so the
    // remaining fringe doesn't glow green against the panorama.
    const t = (dist - inner) / span;
    data[i + 3] = Math.round(255 * t);
    const avg = (r + b) / 2;
    if (g > avg) data[i + 1] = Math.round(avg + (g - avg) * 0.4);
  }

  if (feather) featherAlpha(data, width, height);
  return data;
}

/**
 * 3x3 box blur over the alpha channel only, so the cutout edge fades instead of
 * stepping pixel-by-pixel. RGB is untouched, so the image stays sharp.
 */
export function featherAlpha(
  data: Uint8ClampedArray,
  width: number,
  height: number
): void {
  const alpha = new Uint8ClampedArray(width * height);
  for (let p = 0, a = 0; p < data.length; p += 4, a++) alpha[a] = data[p + 3];

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const a = y * width + x;
      const sum =
        alpha[a - width - 1] + alpha[a - width] + alpha[a - width + 1] +
        alpha[a - 1] + alpha[a] + alpha[a + 1] +
        alpha[a + width - 1] + alpha[a + width] + alpha[a + width + 1];
      data[a * 4 + 3] = (sum / 9) | 0;
    }
  }
}
