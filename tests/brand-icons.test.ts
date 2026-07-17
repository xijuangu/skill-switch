import { createHash } from 'crypto'
import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { describe, expect, test } from 'vitest'
import { decodePng, pixelAt } from './helpers/png'

// vitest is invoked from the repo root by `npm test`, so cwd is the repo root.
const ROOT = process.cwd()
const ICON_DIR = join(ROOT, 'resources', 'icons')
const BRAND_DIR = join(ROOT, 'design', 'brand')
const SOURCE = join(BRAND_DIR, 'skill-switch-calico-source.png')

// Pinned in issue #66 authoritative comment: baseline commit b4bd5e2.
const EXPECTED_SOURCE_SHA256 =
  '7805d7f36ce6dc356c6fad3091b26e29f9b0a68f88de5042d4db70a924eb49bc'

interface BuildConfig {
  mac?: { icon?: string }
  win?: { icon?: string }
  linux?: { icon?: string }
}
interface PackageJson {
  build?: BuildConfig
}
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as PackageJson

function icoSizes(path: string): Array<[number, number]> {
  const buf = readFileSync(path)
  const count = buf.readUInt16LE(4)
  const sizes: Array<[number, number]> = []
  let off = 6
  for (let i = 0; i < count; i++) {
    let w = buf[off]
    let h = buf[off + 1]
    if (w === 0) w = 256
    if (h === 0) h = 256
    sizes.push([w, h])
    off += 16
  }
  return sizes
}

const ICNS_OST_SIZE: Record<string, number> = {
  ic04: 16,
  ic05: 32,
  ic06: 48,
  ic07: 128,
  ic08: 256,
  ic09: 512,
  ic10: 1024,
  ic11: 32,
  ic12: 64,
  ic13: 256,
  ic14: 512,
  icp4: 16,
  icp5: 32,
  icp6: 64,
  icp7: 128,
  icp8: 256,
  icp9: 512,
  icp10: 1024
}

function icnsSizes(path: string): number[] {
  const buf = readFileSync(path)
  if (buf.toString('latin1', 0, 4) !== 'icns') {
    throw new Error(`not an icns: ${path}`)
  }
  const sizes = new Set<number>()
  let off = 8
  while (off + 8 <= buf.length) {
    const ost = buf.toString('latin1', off, off + 4)
    const len = buf.readUInt32BE(off + 4)
    if (len < 8 || off + len > buf.length) break
    const s = ICNS_OST_SIZE[ost]
    if (s) sizes.add(s)
    off += len
  }
  return [...sizes].sort((a, b) => a - b)
}

describe('calico app icon source (issue #66)', () => {
  test('authoritative source image is unchanged from baseline b4bd5e2', () => {
    const sha = createHash('sha256').update(readFileSync(SOURCE)).digest('hex')
    expect(sha).toBe(EXPECTED_SOURCE_SHA256)
  })

  test('source is the expected 1254x1254 RGB PNG with no alpha channel', () => {
    const png = decodePng(SOURCE)
    expect(png.width).toBe(1254)
    expect(png.height).toBe(1254)
    expect(png.colorType).toBe(2) // RGB; the authoritative source carries no alpha
  })
})

describe('derived icon assets exist with correct dimensions (issue #66)', () => {
  test.each([
    ['icon-16.png', 16],
    ['icon-32.png', 32],
    ['icon-64.png', 64],
    ['icon-256.png', 256],
    ['icon-512.png', 512],
    ['icon-1024.png', 1024]
  ])('%s is a square %ix%i RGBA PNG', (name, size) => {
    const path = join(ICON_DIR, name)
    expect(existsSync(path)).toBe(true)
    const png = decodePng(path)
    expect(png.width).toBe(size)
    expect(png.height).toBe(size)
    expect(png.colorType).toBe(6) // RGBA, corners can be transparent
  })

  test('macOS .icns contains all required sizes including 1024 and 512', () => {
    const path = join(ICON_DIR, 'icon.icns')
    expect(existsSync(path)).toBe(true)
    const sizes = icnsSizes(path)
    for (const s of [16, 32, 64, 128, 256, 512, 1024]) {
      expect(sizes, `icns missing ${s}px`).toContain(s)
    }
  })

  test('Windows .ico contains all required multi-sizes', () => {
    const path = join(ICON_DIR, 'icon.ico')
    expect(existsSync(path)).toBe(true)
    const sizes = icoSizes(path)
    for (const s of [16, 32, 48, 64, 128, 256]) {
      expect(sizes, `ico missing ${s}px`).toContain([s, s])
    }
  })

  test('repository avatar is a 512x512 RGBA PNG', () => {
    const png = decodePng(join(BRAND_DIR, 'skill-switch-avatar.png'))
    expect(png.width).toBe(512)
    expect(png.height).toBe(512)
    expect(png.colorType).toBe(6)
  })
})

describe('derivation preserves the cream base plate and cat (#66 / #114)', () => {
  test('white corners outside the cream rounded base plate are transparent', () => {
    const png = decodePng(join(ICON_DIR, 'icon-1024.png'))
    expect(pixelAt(png, 0, 0)[3]).toBe(0)
    expect(pixelAt(png, 1023, 0)[3]).toBe(0)
    expect(pixelAt(png, 0, 1023)[3]).toBe(0)
    expect(pixelAt(png, 1023, 1023)[3]).toBe(0)
  })

  test('cream base plate stays opaque and keeps its original cream color', () => {
    const png = decodePng(join(ICON_DIR, 'icon-1024.png'))
    let cream: number[] | null = null
    // The cream plate touches the canvas edges on its straight sides; sample
    // along the top edge between the two rounded corners.
    for (let x = 64; x < png.width - 64; x++) {
      const px = pixelAt(png, x, 4)
      if (
        px[3] === 255 &&
        px[0] >= 250 &&
        px[1] >= 235 &&
        px[1] <= 245 &&
        px[2] >= 210 &&
        px[2] <= 225
      ) {
        cream = px
        break
      }
    }
    expect(cream, 'expected an opaque cream plate pixel along the top edge').not.toBeNull()
  })

  test('the cat subject at the center stays opaque (never turned transparent)', () => {
    const png = decodePng(join(ICON_DIR, 'icon-1024.png'))
    expect(pixelAt(png, 512, 512)[3]).toBe(255)
  })

  test('16px tiny size keeps a transparent corner and an opaque center', () => {
    const png = decodePng(join(ICON_DIR, 'icon-16.png'))
    expect(pixelAt(png, 0, 0)[3]).toBe(0)
    expect(pixelAt(png, 8, 8)[3]).toBe(255)
  })
})

describe('electron-builder packaging references the custom icons (issue #66)', () => {
  test('mac, win and linux build configs each point at a generated icon asset', () => {
    const macIcon = pkg.build?.mac?.icon
    const winIcon = pkg.build?.win?.icon
    const linuxIcon = pkg.build?.linux?.icon
    expect(macIcon, 'build.mac.icon must be set').toBeTruthy()
    expect(winIcon, 'build.win.icon must be set').toBeTruthy()
    expect(linuxIcon, 'build.linux.icon must be set').toBeTruthy()
    expect(existsSync(join(ROOT, macIcon!))).toBe(true)
    expect(existsSync(join(ROOT, winIcon!))).toBe(true)
    expect(existsSync(join(ROOT, linuxIcon!))).toBe(true)
  })

  test('provenance and derivation rules are documented in design/brand/README.md', () => {
    const path = join(BRAND_DIR, 'README.md')
    expect(existsSync(path)).toBe(true)
    const text = readFileSync(path, 'utf8')
    expect(text).toContain(EXPECTED_SOURCE_SHA256)
    expect(text.toLowerCase()).toContain('generate_icons.py')
  })

  test('the derivation script is checked in and non-empty', () => {
    const path = join(BRAND_DIR, 'generate_icons.py')
    expect(existsSync(path)).toBe(true)
    expect(statSync(path).size).toBeGreaterThan(0)
  })
})
