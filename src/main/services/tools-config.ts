// tools-config 服务:多工具发现 + 内置预设 + 自定义工具 + 路径探测
//
// 内置 5 个预设(TRAE / Codex / Claude Code / Agents / Gemini CLI),每个预设
// 有 displayName + internal key + defaultPaths(基于 homeDir 计算,跨平台)。
// settings.json 存 enabled / paths 覆盖;无覆盖时用默认值。
// 探测时逐路径 existsSync,保留存在的;TRAE 任一路径存在即视为该工具存在。

import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { AppSettings, CustomTool, ToolConfig, ToolPreset } from '../types'
import { reconcileTargetPaths, targetsForLegacyPaths } from './target-identity'

/** 内置预设 key 列表(顺序稳定) */
export const PRESET_KEYS = [
  'trae',
  'codex',
  'claude-code',
  'agents',
  'gemini-cli'
] as const

/**
 * 根据 homeDir 计算内置预设列表。homeDir 参数便于测试用临时目录替换真实 home。
 * TRAE 包含 domestic(~/.trae-cn/skills)与国际版(~/.trae/skills)两个路径。
 */
export function getBuiltinPresets(homeDir: string): ToolPreset[] {
  return [
    {
      key: 'trae',
      displayName: 'TRAE',
      defaultPaths: [
        join(homeDir, '.trae-cn', 'skills'),
        join(homeDir, '.trae', 'skills')
      ]
    },
    {
      key: 'codex',
      displayName: 'Codex',
      defaultPaths: [join(homeDir, '.codex', 'skills')]
    },
    {
      key: 'claude-code',
      displayName: 'Claude Code',
      defaultPaths: [join(homeDir, '.claude', 'skills')]
    },
    {
      key: 'agents',
      displayName: 'Agents',
      defaultPaths: [join(homeDir, '.agents', 'skills')]
    },
    {
      key: 'gemini-cli',
      displayName: 'Gemini CLI',
      defaultPaths: [join(homeDir, '.gemini', 'skills')]
    }
  ]
}

/** 生产环境内置预设(基于真实 home) */
export const BUILTIN_PRESETS: ToolPreset[] = getBuiltinPresets(homedir())

/** 解析单个内置预设的有效配置:无 settings 覆盖时用 defaultPaths + enabled=true */
function resolvePreset(
  preset: ToolPreset,
  settings: AppSettings
): { enabled: boolean; paths: string[]; targets: ToolConfig['targets'] } {
  const override = settings.tools.presets[preset.key]
  if (override) {
    return {
      enabled: override.enabled,
      paths: override.paths.length > 0 ? override.paths : preset.defaultPaths,
      targets:
        override.targets ?? targetsForLegacyPaths(`preset:${preset.key}`, override.paths)
    }
  }
  return {
    enabled: true,
    paths: preset.defaultPaths,
    targets: targetsForLegacyPaths(`preset:${preset.key}`, preset.defaultPaths)
  }
}

/** 探测路径列表中实际存在的路径(保留顺序) */
function probeExisting(paths: string[]): string[] {
  return paths.filter((p) => existsSync(p))
}

/**
 * 把内置预设 + 自定义工具 + settings + 磁盘探测合并成统一 ToolConfig 列表。
 * @param settings 当前 settings
 * @param homeDir home 目录(预设默认路径基于此,测试可传临时目录)
 */
export function resolveToolConfigs(
  settings: AppSettings,
  homeDir: string
): ToolConfig[] {
  const presets = getBuiltinPresets(homeDir)
  const configs: ToolConfig[] = []

  for (const preset of presets) {
    const { enabled, paths, targets } = resolvePreset(preset, settings)
    const existingPaths = probeExisting(paths)
    configs.push({
      key: preset.key,
      displayName: preset.displayName,
      enabled,
      paths,
      existingPaths,
      targets,
      existingTargets: targets.filter((target) => existsSync(target.path)),
      isCustom: false,
      exists: existingPaths.length > 0
    })
  }

  for (const custom of settings.tools.custom) {
    const existingPaths = probeExisting(custom.paths)
    const targets = custom.targets ?? targetsForLegacyPaths(`custom:${custom.key}`, custom.paths)
    configs.push({
      key: custom.key,
      displayName: custom.displayName,
      enabled: true,
      paths: custom.paths,
      existingPaths,
      targets,
      existingTargets: targets.filter((target) => existsSync(target.path)),
      isCustom: true,
      exists: existingPaths.length > 0
    })
  }

  return configs
}

/** 切换内置预设的 enabled 状态,返回新的 settings(不可变) */
export function setPresetEnabled(
  settings: AppSettings,
  key: string,
  enabled: boolean
): AppSettings {
  const preset = BUILTIN_PRESETS.find((p) => p.key === key)
  const existing = settings.tools.presets[key]
  const paths = existing?.paths ?? (preset?.defaultPaths ?? [])
  const targets =
    existing?.targets ?? targetsForLegacyPaths(`preset:${key}`, paths)
  const presets: AppSettings['tools']['presets'] = {
    ...settings.tools.presets,
    [key]: { enabled, paths, targets }
  }
  return {
    ...settings,
    tools: { ...settings.tools, presets }
  }
}

/** 覆盖内置预设的 paths,返回新的 settings(enabled 默认 true) */
export function setPresetPaths(
  settings: AppSettings,
  key: string,
  paths: string[]
): AppSettings {
  const existing = settings.tools.presets[key]
  const enabled = existing?.enabled ?? true
  const preset = BUILTIN_PRESETS.find((candidate) => candidate.key === key)
  const previousPaths = existing?.paths ?? preset?.defaultPaths ?? []
  const previousTargets =
    existing?.targets ?? targetsForLegacyPaths(`preset:${key}`, previousPaths)
  const presets: AppSettings['tools']['presets'] = {
    ...settings.tools.presets,
    [key]: { enabled, paths, targets: reconcileTargetPaths(previousTargets, paths) }
  }
  return {
    ...settings,
    tools: { ...settings.tools, presets }
  }
}

/** 添加自定义工具,返回新的 settings(不可变) */
export function addCustomTool(
  settings: AppSettings,
  tool: CustomTool
): AppSettings {
  const custom = settings.tools.custom.filter((c) => c.key !== tool.key)
  custom.push({
    ...tool,
    targets: tool.targets ?? reconcileTargetPaths([], tool.paths)
  })
  return {
    ...settings,
    tools: { ...settings.tools, custom }
  }
}

/** 按 key 删除自定义工具,返回新的 settings(未知 key 为 no-op) */
export function removeCustomTool(
  settings: AppSettings,
  key: string
): AppSettings {
  if (!settings.tools.custom.some((c) => c.key === key)) {
    return settings
  }
  const custom = settings.tools.custom.filter((c) => c.key !== key)
  return {
    ...settings,
    tools: { ...settings.tools, custom }
  }
}

/** 单个工具待扫描的有效目录(存在的路径,去重保序) */
export interface ActiveScanDir {
  key: string
  displayName: string
  paths: string[]
}

/**
 * 返回当前可扫描的工具目录列表:enabled + 至少一个路径存在。
 * @param settings 当前 settings
 * @param homeDir home 目录(预设默认路径基于此)
 */
export function getActiveScanDirs(
  settings: AppSettings,
  homeDir: string
): ActiveScanDir[] {
  const configs = resolveToolConfigs(settings, homeDir)
  const active: ActiveScanDir[] = []
  for (const cfg of configs) {
    if (!cfg.enabled || !cfg.exists) continue
    active.push({
      key: cfg.key,
      displayName: cfg.displayName,
      paths: cfg.existingPaths
    })
  }
  return active
}
