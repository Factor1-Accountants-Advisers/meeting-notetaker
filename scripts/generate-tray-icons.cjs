#!/usr/bin/env node
/**
 * Generates the theme-paired Windows tray icons (IN-472 fix) and the
 * recording variants used to swap the tray icon while capturing (IN-495).
 *
 * Source of truth is the two hand-drawn white masters in resources/:
 *   tray-icon-32.png (32x32) and tray-icon-16.png (16x16).
 * Only their ALPHA channel is used — the glyph colour is painted here, so the
 * masters stay a single monochrome silhouette and colour lives in one place.
 *
 * Emits multi-size .ico files containing 16/20/24/32 px, the sizes Electron
 * documents for Windows small icons at 100/125/150/200% DPI:
 *   resources/tray-icon-light.ico      — dark glyph, for a LIGHT taskbar
 *   resources/tray-icon-dark.ico       — white glyph, for a DARK taskbar
 *   resources/tray-icon-light-rec.ico  — light-theme glyph + red recording dot
 *   resources/tray-icon-dark-rec.ico   — dark-theme glyph + red recording dot
 *
 * The taskbar button's recording dot is an overlay badge drawn at runtime
 * (src/main/window.ts), so build/icon.ico needs no recording twin.
 *
 * The suffix names the THEME THE ICON IS FOR, not the glyph colour.
 *
 * Zero dependencies (zlib only) so packaging never needs a native image lib.
 * Run: node scripts/generate-tray-icons.cjs
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const ROOT = path.join(__dirname, '..')
const RESOURCES = path.join(ROOT, 'resources')

/** Glyph colour per taskbar theme. Change these to restyle both icons. */
const GLYPH = {
  light: { r: 0x1f, g: 0x1f, b: 0x1f }, // near-black on a light taskbar
  dark: { r: 0xff, g: 0xff, b: 0xff } //  white on a dark taskbar
}

/** Recording indicator. Same red on every icon so idle/recording is a clean swap. */
const REC_DOT = { r: 0xe0, g: 0x2b, b: 0x2b }

/** Sizes Windows asks for at 100/125/150/200% DPI. */
const SIZES = [16, 20, 24, 32]

// ---------------------------------------------------------------- PNG decode

function crcTable() {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
}
const CRC_TABLE = crcTable()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/**
 * Decode an 8-bit RGB or RGBA PNG to a tightly packed RGBA buffer.
 * RGB (colour type 2) is expanded with opaque alpha — that is how build/icon.ico
 * stores the app icon.
 */
function decodePng(buf, label) {
  let off = 8
  let width = 0
  let height = 0
  let colorType = 0
  const idat = []

  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8) throw new Error(`${label}: expected 8-bit depth, got ${data[8]}`)
      colorType = data[9]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    off += 12 + len
  }

  if (colorType !== 2 && colorType !== 6) {
    throw new Error(`${label}: expected RGB or RGBA, got colour type ${colorType}`)
  }

  const channels = colorType === 6 ? 4 : 3
  const stride = width * channels
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const pixels = Buffer.alloc(height * stride)

  let pos = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]
    for (let x = 0; x < stride; x++) {
      const value = raw[pos + x]
      const left = x >= channels ? pixels[y * stride + x - channels] : 0
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0
      const upLeft = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0
      let out
      switch (filter) {
        case 0:
          out = value
          break
        case 1:
          out = value + left
          break
        case 2:
          out = value + up
          break
        case 3:
          out = value + ((left + up) >> 1)
          break
        case 4: {
          const p = left + up - upLeft
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - upLeft)
          out = value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)
          break
        }
        default:
          throw new Error(`${label}: unsupported PNG filter ${filter}`)
      }
      pixels[y * stride + x] = out & 0xff
    }
    pos += stride
  }

  if (channels === 4) return { width, height, rgba: pixels }

  const rgba = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = pixels[i * 3]
    rgba[i * 4 + 1] = pixels[i * 3 + 1]
    rgba[i * 4 + 2] = pixels[i * 3 + 2]
    rgba[i * 4 + 3] = 0xff
  }
  return { width, height, rgba }
}

/** Decode an 8-bit RGBA PNG and return just its alpha mask. */
function readAlphaMask(file) {
  const { width, height, rgba } = decodePng(fs.readFileSync(file), file)
  const alpha = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i++) alpha[i] = rgba[i * 4 + 3]
  return { width, height, alpha }
}

// ------------------------------------------------------------------- resize

/**
 * Area-average ("box") downscale of an alpha mask. The masters are hard-edged
 * (zero partial alpha), so this is what introduces the anti-aliasing that the
 * old single-PNG tray icon never had.
 */
function resizeAlpha(mask, targetSize) {
  const { width, height, alpha } = mask
  if (width === targetSize && height === targetSize) return alpha

  const out = new Uint8Array(targetSize * targetSize)
  const scaleX = width / targetSize
  const scaleY = height / targetSize

  for (let y = 0; y < targetSize; y++) {
    const y0 = y * scaleY
    const y1 = (y + 1) * scaleY
    for (let x = 0; x < targetSize; x++) {
      const x0 = x * scaleX
      const x1 = (x + 1) * scaleX

      let sum = 0
      let weight = 0
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        const coverY = Math.min(y1, sy + 1) - Math.max(y0, sy)
        if (coverY <= 0) continue
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const coverX = Math.min(x1, sx + 1) - Math.max(x0, sx)
          if (coverX <= 0) continue
          const w = coverX * coverY
          sum += alpha[sy * width + sx] * w
          weight += w
        }
      }
      out[y * targetSize + x] = weight > 0 ? Math.round(sum / weight) : 0
    }
  }
  return out
}

// ---------------------------------------------------------------- PNG encode

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData), 0)
  return Buffer.concat([len, typeAndData, crc])
}

/** Encode a tightly packed RGBA buffer as an 8-bit RGBA PNG (filter none). */
function encodePngFromRgba(size, rgba) {
  const stride = size * 4
  const raw = Buffer.alloc(size * (stride + 1))
  for (let y = 0; y < size; y++) {
    const rowStart = y * (stride + 1)
    raw[rowStart] = 0
    rgba.copy(raw, rowStart + 1, y * stride, y * stride + stride)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // non-interlaced

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** Paint `colour` through `alpha` and encode as an 8-bit RGBA PNG. */
function encodePng(size, alpha, colour) {
  return encodePngFromRgba(size, paintGlyphRgba(size, alpha, colour))
}

function paintGlyphRgba(size, alpha, colour) {
  const rgba = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    const o = i * 4
    rgba[o] = colour.r
    rgba[o + 1] = colour.g
    rgba[o + 2] = colour.b
    rgba[o + 3] = alpha[i]
  }
  return rgba
}

/**
 * Composite a recording dot in the bottom-right. Coverage is a cheap analytic
 * anti-alias so 16px tray sizes still read as a circle rather than a square.
 * Half the icon wide, with a transparent gap cut into the glyph around it: at
 * 16px a smaller dot merged into the mic and was hard to spot (IN-495 test).
 */
function overlayRedDot(width, height, rgba) {
  const short = Math.min(width, height)
  const radius = Math.max(3, short * 0.25)
  const gap = Math.max(1, short * 0.06)
  const inset = 0
  const cx = width - inset - radius
  const cy = height - inset - radius

  // Knock the glyph out of a ring around the dot so the badge stands apart.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
      const knock = Math.max(0, Math.min(1, radius + gap + 0.5 - d))
      if (knock <= 0) continue
      const o = (y * width + x) * 4
      rgba[o + 3] = Math.round(rgba[o + 3] * (1 - knock))
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cover = Math.max(0, Math.min(1, radius + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy)))
      if (cover <= 0) continue
      const o = (y * width + x) * 4
      const ia = 1 - cover
      rgba[o] = Math.round(REC_DOT.r * cover + rgba[o] * ia)
      rgba[o + 1] = Math.round(REC_DOT.g * cover + rgba[o + 1] * ia)
      rgba[o + 2] = Math.round(REC_DOT.b * cover + rgba[o + 2] * ia)
      rgba[o + 3] = Math.max(rgba[o + 3], Math.round(255 * cover))
    }
  }
}

// ---------------------------------------------------------------- ICO encode

/** Wrap PNG entries in an ICO container (PNG-in-ICO is Vista+; fine on Win 10/11). */
function encodeIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)

  const directory = Buffer.alloc(16 * entries.length)
  let offset = header.length + directory.length

  entries.forEach((entry, i) => {
    const at = i * 16
    directory[at] = entry.size >= 256 ? 0 : entry.size
    directory[at + 1] = entry.size >= 256 ? 0 : entry.size
    directory[at + 2] = 0 // palette colours
    directory[at + 3] = 0 // reserved
    directory.writeUInt16LE(1, at + 4) // colour planes
    directory.writeUInt16LE(32, at + 6) // bits per pixel
    directory.writeUInt32LE(entry.png.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += entry.png.length
  })

  return Buffer.concat([header, directory, ...entries.map((e) => e.png)])
}

function rel(file) {
  return path.relative(ROOT, file)
}

// --------------------------------------------------------------------- main

function writeTrayIcons() {
  const master32 = readAlphaMask(path.join(RESOURCES, 'tray-icon-32.png'))
  const master16 = readAlphaMask(path.join(RESOURCES, 'tray-icon-16.png'))

  if (master32.width !== 32) throw new Error('tray-icon-32.png must be 32x32')
  if (master16.width !== 16) throw new Error('tray-icon-16.png must be 16x16')

  // 16px uses the hand-drawn master (tuned to the pixel grid); 20/24/32 come
  // from the 32px master so the larger sizes stay crisp.
  const masks = SIZES.map((size) => ({
    size,
    alpha: size === 16 ? master16.alpha : resizeAlpha(master32, size)
  }))

  for (const [theme, colour] of Object.entries(GLYPH)) {
    const idle = encodeIco(
      masks.map(({ size, alpha }) => ({ size, png: encodePng(size, alpha, colour) }))
    )
    const idleTarget = path.join(RESOURCES, `tray-icon-${theme}.ico`)
    fs.writeFileSync(idleTarget, idle)

    const rec = encodeIco(
      masks.map(({ size, alpha }) => {
        const rgba = paintGlyphRgba(size, alpha, colour)
        overlayRedDot(size, size, rgba)
        return { size, png: encodePngFromRgba(size, rgba) }
      })
    )
    const recTarget = path.join(RESOURCES, `tray-icon-${theme}-rec.ico`)
    fs.writeFileSync(recTarget, rec)

    const hex = `#${colour.r.toString(16).padStart(2, '0')}${colour.g
      .toString(16)
      .padStart(2, '0')}${colour.b.toString(16).padStart(2, '0')}`
    console.log(
      `wrote ${rel(idleTarget)} and ${rel(recTarget)} ` +
        `(${SIZES.join('/')}px, glyph ${hex}, idle ${idle.length}b / rec ${rec.length}b)`
    )
  }
}

function main() {
  writeTrayIcons()
}

main()
