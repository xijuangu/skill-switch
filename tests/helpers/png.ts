import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

export interface PngImage {
  width: number
  height: number
  colorType: number
  channels: number
  bitDepth: number
  data: Buffer
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const COLOR_TYPE_CHANNELS: Record<number, number> = {
  0: 1,
  2: 3,
  3: 1,
  4: 2,
  6: 4
}

/**
 * Minimal, dependency-free PNG decoder for 8-bit non-interlaced PNGs.
 *
 * Used only by brand-icon tests so the suite can assert on actual pixel data
 * (dimensions, color type, alpha, sampled colors) without pulling in a native
 * image dependency. Handles all five PNG row filters.
 */
export function decodePng(path: string): PngImage {
  const buf = readFileSync(path)
  if (buf.subarray(0, 8).compare(PNG_SIGNATURE) !== 0) {
    throw new Error(`not a PNG: ${path}`)
  }
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idatChunks: Buffer[] = []
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('latin1', offset + 4, offset + 8)
    const dataStart = offset + 8
    const data = buf.subarray(dataStart, dataStart + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') {
      idatChunks.push(Buffer.from(data))
    } else if (type === 'IEND') {
      break
    }
    offset = dataStart + length + 4
  }
  const channels = COLOR_TYPE_CHANNELS[colorType]
  if (!channels) {
    throw new Error(`unsupported PNG color type ${colorType}: ${path}`)
  }
  if (bitDepth !== 8) {
    throw new Error(`unsupported PNG bit depth ${bitDepth}: ${path}`)
  }
  const raw = inflateSync(Buffer.concat(idatChunks))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  let prev = Buffer.alloc(stride)
  let inOffset = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[inOffset++]
    const row = Buffer.alloc(stride)
    for (let i = 0; i < stride; i++) {
      const x = raw[inOffset++]
      const a = i >= channels ? row[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      let recon: number
      switch (filter) {
        case 0:
          recon = x
          break
        case 1:
          recon = (x + a) & 0xff
          break
        case 2:
          recon = (x + b) & 0xff
          break
        case 3:
          recon = (x + ((a + b) >> 1)) & 0xff
          break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
          recon = (x + pred) & 0xff
          break
        }
        default:
          throw new Error(`unknown PNG filter ${filter} at row ${y}`)
      }
      row[i] = recon
    }
    out.set(row, y * stride)
    prev = row
  }
  return { width, height, colorType, channels, bitDepth, data: out }
}

export function pixelAt(png: PngImage, x: number, y: number): number[] {
  const i = (y * png.width + x) * png.channels
  return Array.from(png.data.subarray(i, i + png.channels))
}
