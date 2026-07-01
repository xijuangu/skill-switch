// settings 服务:settings.json 读写 + 原子写 + 默认值合并
//
// settings.json 顶层结构(tools.presets / tools.custom / backupRetention / platform)。
// 写入采用原子写:先写同目录下临时文件,再 renameSync 覆盖(PRD 要求)。
// 读取时与默认值合并,缺字段自动补全,避免老配置文件部分字段缺失导致报错。

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import type { AppSettings, PlatformInfo } from '../types'

const DEFAULT_BACKUP_RETENTION = 20

/** 返回默认 settings(空 presets/custom,backupRetention=20,平台默认) */
export function defaultSettings(): AppSettings {
  return {
    tools: {
      presets: {},
      custom: []
    },
    backupRetention: DEFAULT_BACKUP_RETENTION,
    platform: defaultPlatform()
  }
}

/** 默认平台信息:platform 取当前,canSymlink 未知先填 false(探测后再覆盖),canJunction 仅 win32 */
function defaultPlatform(): PlatformInfo {
  return {
    platform: process.platform,
    canSymlink: false,
    canJunction: process.platform === 'win32'
  }
}

/**
 * 读取 settings.json;文件不存在或字段缺失时与默认值合并。
 * @param settingsPath settings.json 绝对路径
 */
export function readSettings(settingsPath: string): AppSettings {
  const base = defaultSettings()
  if (!existsSync(settingsPath)) {
    return base
  }
  const raw = readFileSync(settingsPath, 'utf-8')
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return base
  }
  return mergeWithDefaults(parsed)
}

/** 把部分解析结果与默认值合并 */
function mergeWithDefaults(parsed: Record<string, unknown>): AppSettings {
  const base = defaultSettings()
  const tools = (parsed.tools as { presets?: unknown; custom?: unknown } | undefined) ?? {}
  const presets = (tools.presets as Record<string, unknown> | undefined) ?? {}
  const custom = (tools.custom as AppSettings['tools']['custom'] | undefined) ?? []
  const backupRetention =
    typeof parsed.backupRetention === 'number' ? parsed.backupRetention : base.backupRetention
  const platform =
    (parsed.platform as Partial<PlatformInfo> | undefined) ?? {}
  return {
    tools: {
      presets: presets as AppSettings['tools']['presets'],
      custom
    },
    backupRetention,
    platform: {
      platform:
        typeof platform.platform === 'string'
          ? platform.platform
          : base.platform.platform,
      canSymlink:
        typeof platform.canSymlink === 'boolean'
          ? platform.canSymlink
          : base.platform.canSymlink,
      canJunction:
        typeof platform.canJunction === 'boolean'
          ? platform.canJunction
          : base.platform.canJunction
    }
  }
}

/**
 * 原子写入 settings.json:写到同目录临时文件后 renameSync 覆盖目标。
 * 目标目录不存在时会先 mkdir(中央仓库目录由 ensureCentralDir 保证,这里兜底)。
 * @param settingsPath settings.json 绝对路径
 * @param settings 待写入的 settings
 */
export function writeSettings(settingsPath: string, settings: AppSettings): void {
  const dir = dirname(settingsPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const tmpPath = join(dir, `.settings-${process.pid}-${Date.now()}.tmp`)
  writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8')
  renameSync(tmpPath, settingsPath)
}
