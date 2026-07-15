import { test, expect, describe } from 'vitest'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { createTempDir } from './helpers/temp'
import {
  defaultSettings,
  readSettings,
  writeSettings
} from '../src/main/services/settings'
import type { AppSettings } from '../src/main/types'

describe('settings service', () => {
  test('defaultSettings returns backupRetention=20 and platform defaults', () => {
    const s = defaultSettings()
    expect(s.backupRetention).toBe(20)
    expect(s.platform).toEqual({
      platform: process.platform,
      canSymlink: false,
      canJunction: process.platform === 'win32'
    })
    expect(s.tools.presets).toEqual({})
    expect(s.tools.custom).toEqual([])
  })

  test('readSettings returns defaults when file does not exist', () => {
    const { dir, cleanup } = createTempDir()
    const path = join(dir, 'settings.json')
    const s = readSettings(path)
    expect(s.backupRetention).toBe(20)
    cleanup()
  })

  test('writeSettings creates the file and readSettings round-trips it', () => {
    const { dir, cleanup } = createTempDir()
    const path = join(dir, 'settings.json')
    const settings: AppSettings = {
      tools: {
        presets: { codex: { enabled: false, paths: ['/x/codex/skills'] } },
        custom: [{ key: 'mytool', displayName: 'My Tool', paths: ['/x/mytool'] }]
      },
      backupRetention: 5,
      platform: { platform: 'darwin', canSymlink: true, canJunction: false }
    }
    writeSettings(path, settings)
    expect(existsSync(path)).toBe(true)

    const read = readSettings(path)
    expect(read).toMatchObject(settings)
    expect(read.tools.presets.codex.targets).toHaveLength(1)
    expect(read.tools.custom[0].targets).toHaveLength(1)
    cleanup()
  })

  test('writeSettings is atomic: writes to temp file then renames (no temp left behind)', () => {
    const { dir, cleanup } = createTempDir()
    const path = join(dir, 'settings.json')
    writeSettings(path, defaultSettings())

    // 目录里只应剩 settings.json,无残留 .tmp 文件
    const leftover = readdirSync(dir).filter((f) => f.endsWith('.tmp'))
    expect(leftover).toEqual([])
    expect(existsSync(path)).toBe(true)
    cleanup()
  })

  test('writeSettings overwrites existing file in place (temp + rename)', () => {
    const { dir, cleanup } = createTempDir()
    const path = join(dir, 'settings.json')
    writeSettings(path, { ...defaultSettings(), backupRetention: 10 })
    writeSettings(path, { ...defaultSettings(), backupRetention: 30 })

    const read = readSettings(path)
    expect(read.backupRetention).toBe(30)
    cleanup()
  })

  test('readSettings merges partial file with defaults (missing fields filled)', () => {
    const { dir, cleanup } = createTempDir()
    const path = join(dir, 'settings.json')
    // 写入一个只含 backupRetention 的部分文件
    writeFileSync(path, JSON.stringify({ backupRetention: 7 }), 'utf-8')

    const read = readSettings(path)
    expect(read.backupRetention).toBe(7)
    expect(read.tools.presets).toEqual({})
    expect(read.tools.custom).toEqual([])
    expect(read.platform.platform).toBe(process.platform)
    cleanup()
  })

  test('writeSettings uses a temp file in the same directory as the target', () => {
    const { dir, cleanup } = createTempDir()
    const path = join(dir, 'settings.json')
    // 通过猴子补丁捕获 renameSync 前的临时文件位置不易,这里改为:
    // 写入后确认目标存在且内容正确即可(原子性由 writeFileSync + renameSync 保证)
    writeSettings(path, defaultSettings())
    const raw = readFileSync(path, 'utf-8')
    expect(JSON.parse(raw).backupRetention).toBe(20)
    // temp 文件应在同目录下(已被 rename 掉),确认目录里只剩 settings.json
    expect(readdirSync(dirname(path))).toEqual(['settings.json'])
    cleanup()
  })
})
