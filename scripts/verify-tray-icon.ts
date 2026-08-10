import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import zlib from 'node:zlib'
import {
  parseRegDword,
  resolveTrayTheme,
  trayIconFileName,
  trayIconPath,
  type TrayTheme,
  type TrayThemeSignals
} from '../src/main/tray-icon'

// Overridable so the negative case (a wrongly-coloured icon set) can be proven
// to fail without touching the real assets.
const RESOURCES = process.env.TRAY_ICON_DIR ?? join(__dirname, '..', 'resources')

function signals(partial: Partial<TrayThemeSignals> = {}): TrayThemeSignals {
  return {
    systemUsesLightTheme: null,
    appsUseLightTheme: null,
    electronPrefersDark: false,
    ...partial
  }
}

// ------------------------------------------------------------- asset decode

interface IcoEntry {
  size: number
  visiblePixels: number
  partialAlphaPixels: number
  colours: Set<string>
  meanLuminance: number
}

/**
 * Minimal ICO + PNG reader for asset assertions. Deliberately only supports
 * filter type 0, which is what generate-tray-icons.cjs emits — anything else
 * fails loudly rather than silently passing on an unexpected encoding.
 */
function readIco(file: string): IcoEntry[] {
  const buf = readFileSync(file)
  assert.equal(buf.readUInt16LE(0), 0, `${file}: ICONDIR reserved must be 0`)
  assert.equal(buf.readUInt16LE(2), 1, `${file}: ICONDIR type must be 1 (icon)`)
  const count = buf.readUInt16LE(4)

  const entries: IcoEntry[] = []
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16
    const declaredSize = buf[at]
    const length = buf.readUInt32LE(at + 8)
    const offset = buf.readUInt32LE(at + 12)
    const png = buf.subarray(offset, offset + length)

    assert.equal(png[0], 0x89, `${file}: entry ${i} is not PNG-encoded`)
    assert.equal(png.toString('ascii', 1, 4), 'PNG', `${file}: entry ${i} is not PNG-encoded`)

    // Walk PNG chunks.
    let off = 8
    let width = 0
    let height = 0
    const idat: Buffer[] = []
    while (off < png.length) {
      const len = png.readUInt32BE(off)
      const type = png.toString('ascii', off + 4, off + 8)
      const data = png.subarray(off + 8, off + 8 + len)
      if (type === 'IHDR') {
        width = data.readUInt32BE(0)
        height = data.readUInt32BE(4)
        assert.equal(data[8], 8, `${file}: entry ${i} must be 8-bit`)
        assert.equal(data[9], 6, `${file}: entry ${i} must be RGBA`)
      } else if (type === 'IDAT') {
        idat.push(Buffer.from(data))
      } else if (type === 'IEND') {
        break
      }
      off += 12 + len
    }

    assert.equal(width, declaredSize, `${file}: entry ${i} dir size != IHDR width`)
    assert.equal(height, declaredSize, `${file}: entry ${i} dir size != IHDR height`)

    const raw = zlib.inflateSync(Buffer.concat(idat))
    const stride = width * 4
    let visiblePixels = 0
    let partialAlphaPixels = 0
    let luminanceSum = 0
    const colours = new Set<string>()

    for (let y = 0; y < height; y++) {
      const rowStart = y * (stride + 1)
      assert.equal(raw[rowStart], 0, `${file}: entry ${i} row ${y} must use PNG filter 0`)
      for (let x = 0; x < width; x++) {
        const o = rowStart + 1 + x * 4
        const [r, g, b, a] = [raw[o], raw[o + 1], raw[o + 2], raw[o + 3]]
        if (a === 0) continue
        if (a < 255) partialAlphaPixels++
        visiblePixels++
        colours.add(`${r},${g},${b}`)
        luminanceSum += 0.2126 * r + 0.7152 * g + 0.0722 * b
      }
    }

    entries.push({
      size: width,
      visiblePixels,
      partialAlphaPixels,
      colours,
      meanLuminance: visiblePixels > 0 ? luminanceSum / visiblePixels : 0
    })
  }
  return entries
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------- 1. paths
  assert.equal(trayIconFileName('light'), 'tray-icon-light.ico')
  assert.equal(trayIconFileName('dark'), 'tray-icon-dark.ico')

  assert.equal(
    trayIconPath('dark', {
      isPackaged: true,
      resourcesPath: join('C:', 'app', 'resources'),
      mainDir: join('C:', 'app', 'resources', 'app.asar', 'out', 'main')
    }),
    join('C:', 'app', 'resources', 'tray-icon-dark.ico'),
    'packaged builds read extraResources from resourcesPath root'
  )
  assert.equal(
    trayIconPath('light', {
      isPackaged: false,
      resourcesPath: join('C:', 'unused'),
      mainDir: join('C:', 'repo', 'out', 'main')
    }),
    join('C:', 'repo', 'resources', 'tray-icon-light.ico'),
    'dev builds resolve out/main/../../resources'
  )

  // ------------------------------------------------------- 2. REG_DWORD parse
  assert.equal(
    parseRegDword('    AppsUseLightTheme    REG_DWORD    0x1', 'AppsUseLightTheme'),
    true
  )
  assert.equal(
    parseRegDword('    AppsUseLightTheme    REG_DWORD    0x0', 'AppsUseLightTheme'),
    false
  )
  assert.equal(
    parseRegDword('    SystemUsesLightTheme    REG_DWORD    0x0', 'AppsUseLightTheme'),
    null,
    'a different value name must not match'
  )
  assert.equal(
    parseRegDword('ERROR: The system was unable to find the specified registry key', 'Apps'),
    null,
    'reg.exe error output must parse as null, not throw'
  )
  assert.equal(parseRegDword('', 'AppsUseLightTheme'), null)

  // Assets first: they are independent of the resolver, so they keep reporting
  // while resolveTrayTheme is still being written.
  checkAssets()
  checkResolver()

  console.log('Tray icon verification passed')
}

/** 3. Resolver truth table — depends on your resolveTrayTheme implementation. */
function checkResolver(): void {
  // These rows encode the recommended policy: the tray sits ON THE TASKBAR, so
  // SystemUsesLightTheme is authoritative whenever it is readable. Change a row
  // if you decide on a different policy — but keep rows 3a/3b, they are the
  // Custom-colour-mode cases that a naive implementation gets backwards.

  assert.equal(
    resolveTrayTheme(signals({ systemUsesLightTheme: true, appsUseLightTheme: true })),
    'light',
    'everything light -> light icon (dark glyph)'
  )
  assert.equal(
    resolveTrayTheme(signals({ systemUsesLightTheme: false, appsUseLightTheme: false })),
    'dark',
    'everything dark -> dark icon (white glyph)'
  )

  // 3a. Custom mode: light taskbar, dark app windows.
  assert.equal(
    resolveTrayTheme(
      signals({
        systemUsesLightTheme: true,
        appsUseLightTheme: false,
        electronPrefersDark: true
      })
    ),
    'light',
    'Custom mode: taskbar is LIGHT, so the icon must be the light-theme one even ' +
      'though Electron reports dark (it tracks the APP theme)'
  )

  // 3b. Custom mode: dark taskbar, light app windows.
  assert.equal(
    resolveTrayTheme(
      signals({
        systemUsesLightTheme: false,
        appsUseLightTheme: true,
        electronPrefersDark: false
      })
    ),
    'dark',
    'Custom mode: taskbar is DARK, so the icon must be the dark-theme one'
  )

  // 3c. Registry unreadable — must fall back, never throw.
  assert.equal(
    resolveTrayTheme(signals({ electronPrefersDark: true })),
    'dark',
    'no registry access: fall back to Electron reporting dark'
  )
  assert.equal(
    resolveTrayTheme(signals({ electronPrefersDark: false })),
    'light',
    'no registry access: fall back to Electron reporting light'
  )

  // 3d. Exhaustive: must always return a valid theme and never throw.
  const tri = [true, false, null]
  for (const systemUsesLightTheme of tri) {
    for (const appsUseLightTheme of tri) {
      for (const electronPrefersDark of [true, false]) {
        const input = { systemUsesLightTheme, appsUseLightTheme, electronPrefersDark }
        let result: TrayTheme
        try {
          result = resolveTrayTheme(input)
        } catch (error) {
          assert.fail(`resolveTrayTheme threw on ${JSON.stringify(input)}: ${String(error)}`)
        }
        assert.ok(
          result === 'light' || result === 'dark',
          `resolveTrayTheme returned ${JSON.stringify(result)} for ${JSON.stringify(input)}`
        )
      }
    }
  }

}

/** 4. Asset regression checks — independent of the resolver. */
function checkAssets(): void {
  // The original bug was a shipped icon whose glyph was pure white, invisible
  // on a light taskbar. These assertions fail the build if that recurs.
  const expectedSizes = [16, 20, 24, 32]

  for (const theme of ['light', 'dark'] as const) {
    const file = join(RESOURCES, trayIconFileName(theme))
    const entries = readIco(file)

    assert.deepEqual(
      entries.map((e) => e.size),
      expectedSizes,
      `${theme}: must ship 16/20/24/32 px for 100/125/150/200% DPI`
    )

    for (const entry of entries) {
      assert.ok(
        entry.visiblePixels > 0,
        `${theme} @${entry.size}: icon is fully transparent — nothing would render`
      )
      assert.equal(
        entry.colours.size,
        1,
        `${theme} @${entry.size}: glyph must be a single flat colour, got ${entry.colours.size}`
      )
    }

    const meanLuminance =
      entries.reduce((sum, e) => sum + e.meanLuminance, 0) / entries.length

    if (theme === 'light') {
      assert.ok(
        meanLuminance < 96,
        `IN-472 REGRESSION: the light-theme icon must be DARK to contrast with a ` +
          `light taskbar, but its mean luminance is ${meanLuminance.toFixed(1)}. ` +
          `A white glyph here is invisible for every user not on dark mode.`
      )
    } else {
      assert.ok(
        meanLuminance > 160,
        `the dark-theme icon must be LIGHT to contrast with a dark taskbar, ` +
          `but its mean luminance is ${meanLuminance.toFixed(1)}`
      )
    }
  }

  // The two variants must actually differ — a copy-paste slip that shipped the
  // same file twice would otherwise pass every check above.
  const lightBytes = readFileSync(join(RESOURCES, 'tray-icon-light.ico'))
  const darkBytes = readFileSync(join(RESOURCES, 'tray-icon-dark.ico'))
  assert.ok(
    !lightBytes.equals(darkBytes),
    'the light and dark tray icons are byte-identical — the theme swap is a no-op'
  )

  // Anti-aliasing: the pre-fix asset had zero partial-alpha pixels at every
  // size. The downscaled sizes should now be smooth.
  for (const theme of ['light', 'dark'] as const) {
    const entries = readIco(join(RESOURCES, trayIconFileName(theme)))
    const downscaled = entries.filter((e) => e.size === 20 || e.size === 24)
    for (const entry of downscaled) {
      assert.ok(
        entry.partialAlphaPixels > 0,
        `${theme} @${entry.size}: expected anti-aliased edges from the downscale`
      )
    }
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
