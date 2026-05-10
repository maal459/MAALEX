/**
 * Brand asset generator for MAALEX / Maal Solutions.
 *
 * Produces three files using the in-app palette:
 *   assets/icon.png             1024 × 1024 — solid navy bg, cyan M, no transparency
 *   assets/adaptive-icon.png    1024 × 1024 — transparent bg, cyan M centered in safe zone
 *   assets/images/logo.png      1242 × 1242 — transparent bg, M + "Maal Solutions" wordmark
 *
 * Run: node tools/generate-brand-assets.cjs
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const NAVY = '#0f172a';
const CYAN = '#22d3ee';
const CYAN_DEEP = '#0891b2';
const ACCENT = '#a855f7';
const WHITE = '#f8fafc';

// Geometric "M" letterform path on a 1000x1000 viewBox, centered.
// Drawn with rounded line joins/caps so it reads cleanly at small sizes.
const MARK_PATH = 'M 180 820 L 180 180 L 500 620 L 820 180 L 820 820';

// ── 1. App icon ─────────────────────────────────────────────────────────
// Full-bleed navy with a cyan M. iOS will round the corners automatically.
const iconSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="mGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${CYAN}"/>
      <stop offset="100%" stop-color="${ACCENT}"/>
    </linearGradient>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${NAVY}"/>
      <stop offset="100%" stop-color="#1e293b"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" fill="url(#bgGrad)"/>
  <g transform="translate(12,12) scale(1)">
    <path d="${MARK_PATH}"
          stroke="url(#mGrad)"
          stroke-width="140"
          stroke-linecap="round"
          stroke-linejoin="round"
          fill="none"/>
  </g>
  <circle cx="500" cy="800" r="22" fill="${CYAN}"/>
</svg>`;

// ── 2. Adaptive icon foreground ─────────────────────────────────────────
// Transparent bg, cyan M sized to fit Android's inner ~660px safe zone.
const adaptiveSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="mGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${CYAN}"/>
      <stop offset="100%" stop-color="${ACCENT}"/>
    </linearGradient>
  </defs>
  <g transform="translate(212,212) scale(0.6)">
    <path d="${MARK_PATH}"
          stroke="url(#mGrad)"
          stroke-width="160"
          stroke-linecap="round"
          stroke-linejoin="round"
          fill="none"/>
    <circle cx="500" cy="800" r="32" fill="${CYAN}"/>
  </g>
</svg>`;

// ── 3. Splash logo ──────────────────────────────────────────────────────
// Transparent bg (Expo paints navy behind it), centered M glyph above the
// "Maal Solutions" wordmark. We draw the wordmark with system fonts via
// SVG <text>; libvips/pango on the host machine handles font fallback.
const splashSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1242" height="1242" viewBox="0 0 1242 1242">
  <defs>
    <linearGradient id="mGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${CYAN}"/>
      <stop offset="100%" stop-color="${ACCENT}"/>
    </linearGradient>
    <linearGradient id="textGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="${WHITE}"/>
      <stop offset="100%" stop-color="${CYAN}"/>
    </linearGradient>
  </defs>

  <!-- Mark (M glyph) centered horizontally, upper third -->
  <g transform="translate(371,260) scale(0.5)">
    <path d="${MARK_PATH}"
          stroke="url(#mGrad)"
          stroke-width="160"
          stroke-linecap="round"
          stroke-linejoin="round"
          fill="none"/>
    <circle cx="500" cy="800" r="32" fill="${CYAN}"/>
  </g>

  <!-- Wordmark -->
  <text x="621" y="900"
        text-anchor="middle"
        font-family="'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif"
        font-weight="800"
        font-size="120"
        letter-spacing="2"
        fill="${WHITE}">MAAL</text>
  <text x="621" y="1010"
        text-anchor="middle"
        font-family="'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif"
        font-weight="500"
        font-size="64"
        letter-spacing="14"
        fill="${CYAN}">SOLUTIONS</text>

  <!-- Decorative underline -->
  <rect x="521" y="1050" width="200" height="6" rx="3" fill="${CYAN_DEEP}"/>
</svg>`;

const root = path.join(__dirname, '..');

async function render(svg, outPath, w, h) {
  const buf = Buffer.from(svg);
  await sharp(buf, { density: 300 })
    .resize(w, h, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(outPath);
  const { size } = fs.statSync(outPath);
  console.log(`  ✓ ${path.relative(root, outPath)}  (${w}×${h}, ${(size / 1024).toFixed(1)} KB)`);
}

(async () => {
  console.log('Generating brand assets…');
  await render(iconSvg,     path.join(root, 'assets', 'icon.png'),                1024, 1024);
  await render(adaptiveSvg, path.join(root, 'assets', 'adaptive-icon.png'),       1024, 1024);
  await render(splashSvg,   path.join(root, 'assets', 'images', 'logo.png'),      1242, 1242);
  console.log('Done.');
})().catch((err) => {
  console.error('Asset generation failed:', err);
  process.exit(1);
});
