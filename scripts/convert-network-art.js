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

/** Distance of a pixel from pure white: 0 (white) .. ~441 (black). */
function whiteDistance(data, i, ch) {
  const r = data[i * ch], g = data[i * ch + 1], b = data[i * ch + 2];
  return Math.sqrt((255 - r) ** 2 + (255 - g) ** 2 + (255 - b) ** 2);
}


(async () => {
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

    const out = path.join(DIR, c.key + '.png');
    await sharp(rgba, { raw: { width: w, height: h, channels: 4 } })
      .resize(OUTPUT_WIDTH)
      // Palette PNG: this art is broad flat washes plus one gradient, which
      // quantises almost losslessly, and it came out both smaller than WebP
      // (25-52 KB vs 33-47 KB) and safe in every WebView. Full-colour PNG was
      // 143-277 KB for no visible gain.
      .png({ compressionLevel: 9, palette: true, quality: 82 })
      .toFile(out);

    console.log(
      c.key.padEnd(7) +
      (fs.statSync(out).size / 1024).toFixed(1) + ' KB' +
      '  (source ' + (fs.statSync(file).size / 1024).toFixed(1) + ' KB)' +
      '  fully transparent: ' + ((cleared / (w * h)) * 100).toFixed(1) + '% of pixels',
    );
  }
})().catch((e) => { console.error(e); process.exit(1); });
