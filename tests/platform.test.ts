import { test, expect, describe } from 'vitest'
import { existsSync } from 'fs'
import { join } from 'path'
import { createTempDir } from './helpers/temp'
import { detectPlatform } from '../src/main/services/platform'

describe('platform service', () => {
  test('detects current platform string from process.platform', () => {
    const { dir, cleanup } = createTempDir()
    const info = detectPlatform(dir)
    expect(info.platform).toBe(process.platform)
    cleanup()
  })

  test('canSymlink is true when symlink creation succeeds', () => {
    const { dir, cleanup } = createTempDir()
    const info = detectPlatform(dir)
    // 在正常 CI / 开发机上(非受限环境)应能创建符号链接
    expect(info.canSymlink).toBe(true)
    cleanup()
  })

  test('canSymlink is false when symlink creation throws', () => {
    const { dir, cleanup } = createTempDir()
    // 用一个不存在的目录作为测试 dir,触发 symlink 失败
    const badDir = join(dir, 'does-not-exist')
    const info = detectPlatform(badDir)
    expect(info.canSymlink).toBe(false)
    cleanup()
  })

  test('canJunction is true only on win32', () => {
    const { dir, cleanup } = createTempDir()
    const info = detectPlatform(dir)
    expect(info.canJunction).toBe(process.platform === 'win32')
    cleanup()
  })

  test('cleans up temp symlink files after detection', () => {
    const { dir, cleanup } = createTempDir()
    detectPlatform(dir)
    // 探测后目录里不应残留 src/link 文件
    const remaining = [
      'platform-probe-src.txt',
      'platform-probe-link.txt'
    ].filter((f) => existsSync(join(dir, f)))
    expect(remaining).toEqual([])
    cleanup()
  })

  test('result shape is exactly {platform, canSymlink, canJunction}', () => {
    const { dir, cleanup } = createTempDir()
    const info = detectPlatform(dir)
    expect(Object.keys(info).sort()).toEqual(['canJunction', 'canSymlink', 'platform'])
    cleanup()
  })
})
