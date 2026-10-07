import { PALETTE } from "./palette";

const RGB = PALETTE.map((hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)));

// "Redmean" weighted distance: much closer to how different two colors
// look than plain RGB distance, for almost no extra cost.
function nearest(r: number, g: number, b: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < RGB.length; i++) {
    const [pr, pg, pb] = RGB[i];
    const rm = (r + pr) / 2;
    const dr = r - pr;
    const dg = g - pg;
    const db = b - pb;
    const d = (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Turns any image file into width x height palette indices, entirely in the
 * browser (nothing is uploaded). The picture is fitted inside the frame on
 * a white background. Dithering (Floyd-Steinberg) suits photos; plain
 * nearest-color suits logos and flat art.
 */
export async function pixelateImageFile(
  file: File,
  width: number,
  height: number,
  dither: boolean,
): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas not available");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  const scale = Math.min(width / bitmap.width, height / bitmap.height);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, (width - w) / 2, (height - h) / 2, w, h);
  bitmap.close();

  const data = ctx.getImageData(0, 0, width, height).data;
  const px = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    // Transparent areas become white, like the background.
    const a = data[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) px[i * 3 + c] = data[i * 4 + c] * a + 255 * (1 - a);
  }

  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const [r, g, b] = [0, 1, 2].map((c) => Math.max(0, Math.min(255, px[i * 3 + c])));
      const idx = nearest(r, g, b);
      out[i] = idx;
      if (!dither) continue;
      const err = [r - RGB[idx][0], g - RGB[idx][1], b - RGB[idx][2]];
      const spread = (dx: number, dy: number, f: number) => {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny >= height) return;
        const j = (ny * width + nx) * 3;
        for (let c = 0; c < 3; c++) px[j + c] += err[c] * f;
      };
      spread(1, 0, 7 / 16);
      spread(-1, 1, 3 / 16);
      spread(0, 1, 5 / 16);
      spread(1, 1, 1 / 16);
    }
  }
  return out;
}
