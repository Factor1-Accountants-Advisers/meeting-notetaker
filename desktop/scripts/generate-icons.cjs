/**
 * One-shot icon generator.
 *
 * Rasterizes an embedded SVG (Lucide PenTool on a dark rounded square) into
 * the three PNG files Electron uses:
 *   assets/icon-installer.png — 256×256 app icon (Windows / Start Menu / taskbar)
 *   assets/icon-idle.png      —  32×32  tray icon, resting state
 *   assets/icon-recording.png —  32×32  tray icon, with a red "live" dot
 *
 * Run:   node scripts/generate-icons.cjs
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');

/**
 * Build the base SVG at a given pixel size, optionally with a recording dot.
 *
 * Palette:
 *   #0f0f10 background — near-black for strong contrast on both light and
 *                        dark Windows taskbars.
 *   #ffffff pen stroke — matches the Sign-in button inversion in the web UI.
 *   #ef4444 rec dot    — Tailwind red-500, the canonical "live" indicator.
 */
function buildSvg({ size, recording = false }) {
  const viewBox = 512;
  const corner = viewBox * 0.22;

  // Lucide "pen-tool" glyph, centered, sized to ~55% of the square.
  // Original 24×24 viewBox; we scale × 12 to fit a 288-unit block.
  const scale = 12;
  const offset = (viewBox - 24 * scale) / 2;

  // Small red dot in the lower-right when recording
  const dotBlock = recording
    ? `<circle cx="${viewBox - 90}" cy="${viewBox - 90}" r="72" fill="#ef4444" stroke="#0f0f10" stroke-width="24" />`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${viewBox} ${viewBox}">
    <rect x="0" y="0" width="${viewBox}" height="${viewBox}" rx="${corner}" ry="${corner}" fill="#0f0f10" />
    <g transform="translate(${offset} ${offset}) scale(${scale})"
       fill="none" stroke="#ffffff" stroke-width="2"
       stroke-linecap="round" stroke-linejoin="round">
      <path d="m12 19 7-7 3 3-7 7-3-3z"/>
      <path d="m18 13-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/>
      <path d="m2 2 7.586 7.586"/>
      <circle cx="11" cy="11" r="2"/>
    </g>
    ${dotBlock}
  </svg>`;
}

async function render(svg, outPath, size) {
  await sharp(Buffer.from(svg))
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(outPath);
  const stat = fs.statSync(outPath);
  console.log(`  ${path.basename(outPath).padEnd(22)} ${size}×${size}  ${stat.size} bytes`);
}

async function main() {
  if (!fs.existsSync(ASSETS_DIR)) {
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
  }

  console.log('Generating icons into', ASSETS_DIR);

  await render(
    buildSvg({ size: 256 }),
    path.join(ASSETS_DIR, 'icon-installer.png'),
    256,
  );
  await render(
    buildSvg({ size: 32 }),
    path.join(ASSETS_DIR, 'icon-idle.png'),
    32,
  );
  await render(
    buildSvg({ size: 32, recording: true }),
    path.join(ASSETS_DIR, 'icon-recording.png'),
    32,
  );

  console.log('Done.');
}

main().catch((err) => {
  console.error('Icon generation failed:', err);
  process.exit(1);
});
