import { test, expect, describe } from 'vitest'
import { mkdirSync } from 'fs'
import { isAbsolute, join } from 'path'
import { createTempDir } from './helpers/temp'
import { defaultSettings } from '../src/main/services/settings'
import {
  BUILTIN_PRESETS,
  PRESET_KEYS,
  getBuiltinPresets,
  resolveToolConfigs,
  setPresetEnabled,
  setPresetPaths,
  addCustomTool,
  removeCustomTool,
  getActiveScanDirs
} from '../src/main/services/tools-config'
import type { AppSettings, CustomTool } from '../src/main/types'

describe('tools-config service', () => {
  describe('builtin presets', () => {
    test('exports the 5 required presets with stable keys', () => {
      expect(PRESET_KEYS).toEqual([
        'trae',
        'codex',
        'claude-code',
        'agents',
        'gemini-cli'
      ])
      const byKey = new Map(BUILTIN_PRESETS.map((p) => [p.key, p]))
      expect(byKey.get('trae')?.displayName).toBe('TRAE')
      expect(byKey.get('codex')?.displayName).toBe('Codex')
      expect(byKey.get('claude-code')?.displayName).toBe('Claude Code')
      expect(byKey.get('agents')?.displayName).toBe('Agents')
      expect(byKey.get('gemini-cli')?.displayName).toBe('Gemini CLI')
    })

    test('TRAE preset has TWO default paths (domestic + international)', () => {
      const trae = getBuiltinPresets('/fake-home').find((p) => p.key === 'trae')!
      expect(trae.defaultPaths).toHaveLength(2)
      expect(trae.defaultPaths.some((p) => p === join('/fake-home', '.trae-cn', 'skills'))).toBe(true)
      expect(trae.defaultPaths.some((p) => p === join('/fake-home', '.trae', 'skills'))).toBe(true)
    })

    test('each non-TRAE preset has exactly one default path under the given home', () => {
      const presets = getBuiltinPresets('/fake-home')
      const codex = presets.find((p) => p.key === 'codex')!
      expect(codex.defaultPaths).toEqual([join('/fake-home', '.codex', 'skills')])
      const claude = presets.find((p) => p.key === 'claude-code')!
      expect(claude.defaultPaths).toEqual([join('/fake-home', '.claude', 'skills')])
      const agents = presets.find((p) => p.key === 'agents')!
      expect(agents.defaultPaths).toEqual([join('/fake-home', '.agents', 'skills')])
      const gemini = presets.find((p) => p.key === 'gemini-cli')!
      expect(gemini.defaultPaths).toEqual([join('/fake-home', '.gemini', 'skills')])
    })

    test('all default paths are absolute (cross-platform via path.join)', () => {
      for (const p of getBuiltinPresets('/fake-home')) {
        for (const path of p.defaultPaths) {
          expect(isAbsolute(path)).toBe(true)
        }
      }
    })
  })

  describe('resolveToolConfigs (probing)', () => {
    test('presets default to enabled, existing paths included, non-existent hidden', () => {
      const { dir, cleanup } = createTempDir()
      // 在临时 home 下只创建 codex 目录
      mkdirSync(join(dir, '.codex', 'skills'), { recursive: true })

      const configs = resolveToolConfigs(defaultSettings(), dir)

      const codexCfg = configs.find((c) => c.key === 'codex')!
      expect(codexCfg.enabled).toBe(true)
      expect(codexCfg.exists).toBe(true)
      expect(codexCfg.existingPaths).toEqual([join(dir, '.codex', 'skills')])

      // trae 两个路径都不存在 -> 整体不存在
      const traeCfg = configs.find((c) => c.key === 'trae')!
      expect(traeCfg.exists).toBe(false)
      expect(traeCfg.existingPaths).toEqual([])

      cleanup()
    })

    test('TRAE included if EITHER of its two paths exists', () => {
      const { dir, cleanup } = createTempDir()
      // 只创建 trae 国际版路径
      const traeIntl = join(dir, '.trae', 'skills')
      mkdirSync(traeIntl, { recursive: true })

      const configs = resolveToolConfigs(defaultSettings(), dir)
      const traeCfg = configs.find((c) => c.key === 'trae')!
      expect(traeCfg.exists).toBe(true)
      expect(traeCfg.existingPaths).toEqual([traeIntl])
      cleanup()
    })

    test('TRAE excluded if NEITHER path exists', () => {
      const { dir, cleanup } = createTempDir()
      const configs = resolveToolConfigs(defaultSettings(), dir)
      const traeCfg = configs.find((c) => c.key === 'trae')!
      expect(traeCfg.exists).toBe(false)
      cleanup()
    })

    test('custom tools are included and probed like presets', () => {
      const { dir, cleanup } = createTempDir()
      const myDir = join(dir, 'mytool', 'skills')
      mkdirSync(myDir, { recursive: true })

      const tool: CustomTool = {
        key: 'mytool',
        displayName: 'My Tool',
        paths: [myDir]
      }
      const settings = addCustomTool(defaultSettings(), tool)
      const configs = resolveToolConfigs(settings, dir)
      const mine = configs.find((c) => c.key === 'mytool')!
      expect(mine.isCustom).toBe(true)
      expect(mine.exists).toBe(true)
      expect(mine.existingPaths).toEqual([myDir])
      cleanup()
    })
  })

  describe('enable/disable', () => {
    test('setPresetEnabled toggles enabled and is reflected in resolved config', () => {
      const { dir, cleanup } = createTempDir()
      mkdirSync(join(dir, '.codex', 'skills'), { recursive: true })

      const settings = setPresetEnabled(defaultSettings(), 'codex', false)
      const configs = resolveToolConfigs(settings, dir)
      const codexCfg = configs.find((c) => c.key === 'codex')!
      expect(codexCfg.enabled).toBe(false)
      cleanup()
    })

    test('disabled presets are excluded from active scan dirs even if path exists', () => {
      const { dir, cleanup } = createTempDir()
      mkdirSync(join(dir, '.codex', 'skills'), { recursive: true })

      const settings = setPresetEnabled(defaultSettings(), 'codex', false)
      const active = getActiveScanDirs(settings, dir)
      expect(active.find((a) => a.key === 'codex')).toBeUndefined()
      cleanup()
    })
  })

  describe('path modify', () => {
    test('editing a configured path preserves its target ID', () => {
      const first = setPresetPaths(defaultSettings(), 'codex', ['/before'])
      const targetId = first.tools.presets.codex.targets![0].id
      const edited = setPresetPaths(first, 'codex', ['/after'])
      expect(edited.tools.presets.codex.targets).toEqual([{ id: targetId, path: '/after' }])
    })

    test('deleting and later re-adding a path creates a new target ID', () => {
      const first = setPresetPaths(defaultSettings(), 'trae', ['/one', '/two'])
      const removedId = first.tools.presets.trae.targets![1].id
      const removed = setPresetPaths(first, 'trae', ['/one'])
      const readded = setPresetPaths(removed, 'trae', ['/one', '/two'])
      expect(readded.tools.presets.trae.targets![1].id).not.toBe(removedId)
    })

    test('setPresetPaths overrides a preset paths and persists in settings', () => {
      const settings = setPresetPaths(defaultSettings(), 'codex', ['/custom/codex/skills'])
      expect(settings.tools.presets['codex']?.paths).toEqual(['/custom/codex/skills'])
      expect(settings.tools.presets['codex']?.enabled).toBe(true)
    })

    test('modified path is honored when probing (Codex in non-default location)', () => {
      const { dir, cleanup } = createTempDir()
      const customCodex = join(dir, 'elsewhere', 'codex', 'skills')
      mkdirSync(customCodex, { recursive: true })

      const settings = setPresetPaths(defaultSettings(), 'codex', [customCodex])
      const configs = resolveToolConfigs(settings, dir)
      const codexCfg = configs.find((c) => c.key === 'codex')!
      expect(codexCfg.exists).toBe(true)
      expect(codexCfg.existingPaths).toEqual([customCodex])
      cleanup()
    })
  })

  describe('custom tool add/remove', () => {
    test('addCustomTool appends a custom tool', () => {
      const settings = addCustomTool(defaultSettings(), {
        key: 'mytool',
        displayName: 'My Tool',
        paths: ['/x']
      })
      expect(settings.tools.custom).toHaveLength(1)
      expect(settings.tools.custom[0].key).toBe('mytool')
    })

    test('added custom tool is scanned (appears in active scan dirs when path exists)', () => {
      const { dir, cleanup } = createTempDir()
      const myDir = join(dir, 'mytool', 'skills')
      mkdirSync(myDir, { recursive: true })

      const settings = addCustomTool(defaultSettings(), {
        key: 'mytool',
        displayName: 'My Tool',
        paths: [myDir]
      })
      const active = getActiveScanDirs(settings, dir)
      expect(active.find((a) => a.key === 'mytool')).toBeDefined()
      expect(active.find((a) => a.key === 'mytool')!.paths).toEqual([myDir])
      cleanup()
    })

    test('removeCustomTool removes a custom tool by key', () => {
      let settings = addCustomTool(defaultSettings(), {
        key: 'mytool',
        displayName: 'My Tool',
        paths: ['/x']
      })
      settings = removeCustomTool(settings, 'mytool')
      expect(settings.tools.custom).toHaveLength(0)
    })

    test('removeCustomTool on unknown key is a no-op', () => {
      const before = defaultSettings()
      const after = removeCustomTool(before, 'nope')
      expect(after).toEqual(before)
    })
  })

  describe('getActiveScanDirs', () => {
    test('only returns enabled + existing tool dirs', () => {
      const { dir, cleanup } = createTempDir()
      mkdirSync(join(dir, '.codex', 'skills'), { recursive: true })
      mkdirSync(join(dir, '.agents', 'skills'), { recursive: true })

      let settings = defaultSettings()
      settings = setPresetEnabled(settings, 'gemini-cli', false)

      const active = getActiveScanDirs(settings, dir)
      const keys = active.map((a) => a.key).sort()
      expect(keys).toEqual(['agents', 'codex'])
      // trae / claude-code / gemini 目录不存在 -> 不出现
      expect(active.find((a) => a.key === 'trae')).toBeUndefined()
      expect(active.find((a) => a.key === 'claude-code')).toBeUndefined()
      expect(active.find((a) => a.key === 'gemini-cli')).toBeUndefined()
      cleanup()
    })
  })

  test('empty AppSettings type sanity (no compile errors expected)', () => {
    const s: AppSettings = defaultSettings()
    expect(s.tools.presets).toBeDefined()
  })
})
