/**
 * Builds the carrier card artwork:
 *   public/assets/images/Networks/*.jpeg  ->  <carrier>.png (transparent)
 *
 * The problem
 * -----------
 * The source art is good but sits on a baked-in white rectangle, so on a dark
 * theme every card would show a white slab. Tracing it to flat SVG
 * silhouettes fixed the theme problem but threw away the gradients, gloss and
 * logo detail that make the art look good in the first place.
 *
 * What this does instead
 * ----------------------
 * Keeps the original pixels and removes only the white *background*, writing
 * real alpha. The artwork then composites onto any card colour, so a single
 * asset serves light and dark with nothing redrawn.
 *
 * How the background is removed
 * -----------------------------
 * Alpha is a soft ramp on how far each pixel sits from pure white, not a
 * yes/no cut. That matters because these waves FADE into the white ground:
 * a binary decision has to put the fade on one side or the other, and either
 * choice looks wrong (a hard edge, or a pale halo on dark cards). A ramp
 * makes the fade genuinely semi-transparent, which is what it always was —
 * a wash of colour over white — so it composites correctly onto any ground.
 *
 * A border flood fill was tried first and does not work here: the fade gives
 * a continuous near-white path from the border into the artwork, so the fill
 * crosses it and eats the wave from the inside out.
 *
 * The trade-off is that white INSIDE the art — the highlight sweep across the
 * wave, and the white "glo"/"airtel" wordmarks — also goes transparent, so on
 * a dark card those read dark instead of white. That is a fair price for art
 * that needs no second asset per theme, and at card scale it reads as detail.
 *
 * Cropping to the wave band
 * -------------------------
 * The source frames are square, and only their bottom quarter-to-third holds
 * real artwork — the wave and the carrier logo. The rest is empty ground,
 * plus (on MTN and Glo) a large pale wordmark ghosted through the middle.
 * Kept whole, a card had to either show the art at card-width — where that
 * ghost mark sat behind the price — or crop it in CSS, which cut the wave.
 *
 * So each frame is trimmed to where its own artwork actually starts, then
 * padded back up with transparency to one common band shape. That yields a
 * short, wide asset per carrier, all the same proportions, which the card
 * renders whole at full width: nothing covering the content, nothing cut off,
 * and one consistent strip height whichever carrier a card belongs to.
 *
 * The trim point is measured from the alpha channel rather than hardcoded, so
 * replacement source art re-measures itself instead of silently losing its
 * wave.
 *
 * Re-run after changing the source art:  node scripts/convert-network-art.js
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const DIR = path.join(__dirname, '..', 'public', 'assets', 'images', 'Networks');

const CARRIERS = [
  { key: 'mtn',    source: 'MTN.jpeg' },
  { key: 'glo',    source: 'glo.jpeg' },
  { key: 'airtel', source: 'airtel.jpeg' },
];

// Alpha ramp bounds, as distance-from-white (0 = white .. ~441 = black).
// Below ALPHA_MIN a pixel is treated as pure background; above ALPHA_MAX it
// is fully opaque artwork; in between it scales. ALPHA_MIN sits just above
// the JPEG noise floor in the white, so compression speckle does not become
// faint visible grain on dark cards.
const ALPHA_MIN = 12;
const ALPHA_MAX = 70;
// Cards render this art small, so the full 1254px is wasted bytes.
const OUTPUT_WIDTH = 600;

// A row counts as real artwork once this many of its pixels are near-opaque.
// Both thresholds sit above the faint ghost wordmarks — which peak well under
// SOLID_ALPHA and never cover much of a row — so together they separate
// "the wave starts here" from "there is a faint wash over this row".
const SOLID_ALPHA = 140;
const SOLID_ROW_FRACTION = 0.02;

// Room kept above the detected start of the artwork, as a fraction of frame
// height, so an anti-aliased leading edge is never clipped.
const TRIM_MARGIN = 0.02;

// Height added to the common band beyond the deepest carrier's own needs, so
// the tallest wave also gets a little clear space above it.
const BAND_MARGIN = 0.05;

/** Distance of a pixel from pure white: 0 (white) .. ~441 (black). */
function whiteDistance(data, i, ch) {
  const r = data[i * ch], g = data[i * ch + 1], b = data[i * ch + 2];
  return Math.sqrt((255 - r) ** 2 + (255 - g) ** 2 + (255 - b) ** 2);
}


/** Topmost row holding real artwork, as a fraction of the frame height. */
function findContentTop(rgba, w, h) {
  for (let y = 0; y < h; y++) {
    let solid = 0;
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3] >= SOLID_ALPHA) solid++;
    }
    if (solid > w * SOLID_ROW_FRACTION) return y / h;
  }
  return 0;   // nothing solid found — keep the whole frame rather than guess
}

(async () => {
  /* Pass 1: build the alpha for every carrier and measure where its artwork
     starts. The band shape cannot be picked until all three are known. */
  const built = [];
  for (const c of CARRIERS) {
    const file = path.join(DIR, c.source);
    if (!fs.existsSync(file)) { console.log('SKIP ' + c.source + ' (missing)'); continue; }

    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width: w, height: h, channels: ch } = info;

    // Original pixels kept as-is; only the alpha channel is computed.
    const rgba = Buffer.alloc(w * h * 4);
    let cleared = 0;
    for (let i = 0; i < w * h; i++) {
      const dist = whiteDistance(data, i, ch);
      let a;
      if (dist <= ALPHA_MIN) { a = 0; cleared++; }
      else if (dist >= ALPHA_MAX) a = 255;
      else a = Math.round(((dist - ALPHA_MIN) / (ALPHA_MAX - ALPHA_MIN)) * 255);

      rgba[i * 4]     = data[i * ch];
      rgba[i * 4 + 1] = data[i * ch + 1];
      rgba[i * 4 + 2] = data[i * ch + 2];
      rgba[i * 4 + 3] = a;
    }

    const contentTop = Math.max(0, findContentTop(rgba, w, h) - TRIM_MARGIN);
    built.push({ key: c.key, file, rgba, w, h, cleared, contentTop });
    console.log(
      c.key.padEnd(7) + 'artwork starts ' + (contentTop * 100).toFixed(1) + '% down' +
      '  (keeping the bottom ' + ((1 - contentTop) * 100).toFixed(1) + '%)',
    );
  }
  if (!built.length) return;

  /* One band shape for every carrier, set by whichever needs the most room.
     Without this each card would show a different strip height. */
  const deepest = Math.max(...built.map((b) => 1 - b.contentTop));
  const band = Math.min(1, deepest + BAND_MARGIN);
  const targetH = Math.round(OUTPUT_WIDTH * band);
  console.log(
    '\ncommon band ' + OUTPUT_WIDTH + 'x' + targetH +
    ' (' + (band * 100).toFixed(1) + '% of width) — .product-card__art in' +
    ' components.css must use this same aspect-ratio\n',
  );

  /* Pass 2: crop each frame to its own artwork, then pad the top back up to
     the common band with transparency. */
  for (const b of built) {
    const top = Math.round(b.contentTop * b.h);
    const cropped = await sharp(b.rgba, { raw: { width: b.w, height: b.h, channels: 4 } })
      .extract({ left: 0, top, width: b.w, height: b.h - top })
      .resize({ width: OUTPUT_WIDTH })
      .png()
      .toBuffer({ resolveWithObject: true });

    const padTop = Math.max(0, targetH - cropped.info.height);
    const out = path.join(DIR, b.key + '.png');
    await sharp(cropped.data)
      .extend({ top: padTop, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      // Palette PNG: this art is broad flat washes plus one gradient, which
      // quantises almost losslessly, and it came out both smaller than WebP
      // (25-52 KB vs 33-47 KB) and safe in every WebView. Full-colour PNG was
      // 143-277 KB for no visible gain.
      .png({ compressionLevel: 9, palette: true, quality: 82 })
      .toFile(out);

    const meta = await sharp(out).metadata();
    console.log(
      b.key.padEnd(7) +
      (meta.width + 'x' + meta.height).padEnd(10) +
      (fs.statSync(out).size / 1024).toFixed(1) + ' KB' +
      '  (source ' + (fs.statSync(b.file).size / 1024).toFixed(1) + ' KB)' +
      '  transparent top pad ' + padTop + 'px' +
      '  white cleared ' + ((b.cleared / (b.w * b.h)) * 100).toFixed(1) + '%',
    );
  }
})().catch((e) => { console.error(e); process.exit(1); });
