#!/usr/bin/env node
/**
 * Generates the theme-paired Windows tray icons (IN-472 fix).
 *
 * Source of truth is the two hand-drawn white masters in resources/:
 *   tray-icon-32.png (32x32) and tray-icon-16.png (16x16).
 * Only their ALPHA channel is used — the glyph colour is painted here, so the
 * masters stay a single monochrome silhouette and colour lives in one place.
 *
 * Emits two multi-size .ico files containing 16/20/24/32 px, the sizes Electron
 * documents for Windows small icons at 100/125/150/200% DPI:
 *   resources/tray-icon-light.ico  — dark glyph, for a LIGHT taskbar
 *   resources/tray-icon-dark.ico   — white glyph, for a DARK taskbar
 *
 * The suffix names the THEME THE ICON IS FOR, not the glyph colour.
 *
 * Zero dependencies (zlib only) so packaging never needs a native image lib.
 * Run: node scripts/generate-tray-icons.cjs
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const RESOURCES = path.join(__dirname, '..', 'resources')

/** Glyph colour per taskbar theme. Change these to restyle both icons. */
const GLYPH = {
  light: { r: 0x1f, g: 0x1f, b: 0x1f }, // near-black on a light taskbar
  dark: { r: 0xff, g: 0xff, b: 0xff } //  white on a dark taskbar
}

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

/** Decode an 8-bit RGBA PNG and return just its alpha mask. */
function readAlphaMask(file) {
  const buf = fs.readFileSync(file)
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
      if (data[8] !== 8) throw new Error(`${file}: expected 8-bit depth, got ${data[8]}`)
      colorType = data[9]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    off += 12 + len
  }

  if (colorType !== 6) throw new Error(`${file}: expected RGBA (colour type 6), got ${colorType}`)

  const channels = 4
  const stride = width * channels
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const pixels = Buffer.alloc(height * stride)

  // Undo the per-scanline PNG filters.
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
          throw new Error(`${file}: unsupported PNG filter ${filter}`)
      }
      pixels[y * stride + x] = out & 0xff
    }
    pos += stride
  }

  const alpha = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i++) alpha[i] = pixels[i * 4 + 3]
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

/** Paint `colour` through `alpha` and encode as an 8-bit RGBA PNG. */
function encodePng(size, alpha, colour) {
  const stride = size * 4
  const raw = Buffer.alloc(size * (stride + 1))
  for (let y = 0; y < size; y++) {
    const rowStart = y * (stride + 1)
    raw[rowStart] = 0 // filter: none — tiny images, keeps this readable
    for (let x = 0; x < size; x++) {
      const o = rowStart + 1 + x * 4
      raw[o] = colour.r
      raw[o + 1] = colour.g
      raw[o + 2] = colour.b
      raw[o + 3] = alpha[y * size + x]
    }
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

// --------------------------------------------------------------------- main

function main() {
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
    const ico = encodeIco(
      masks.map(({ size, alpha }) => ({ size, png: encodePng(size, alpha, colour) }))
    )
    const target = path.join(RESOURCES, `tray-icon-${theme}.ico`)
    fs.writeFileSync(target, ico)
    const hex = `#${colour.r.toString(16).padStart(2, '0')}${colour.g
      .toString(16)
      .padStart(2, '0')}${colour.b.toString(16).padStart(2, '0')}`
    console.log(
      `wrote ${path.relative(path.join(__dirname, '..'), target)} ` +
        `(${SIZES.join('/')}px, glyph ${hex}, ${ico.length} bytes)`
    )
  }
}

main()
