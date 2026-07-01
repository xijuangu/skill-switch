import { test, expect, describe } from 'vitest'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createTempDir, createTempDb } from './helpers/temp'
import { scanAllTools } from '../src/main/services/scan-all'
import { getSkillByName } from '../src/main/db/dao/skills'
import { getAllSkills } from '../src/main/db/dao/skills'
import type { ActiveScanDir } from '../src/main/services/tools-config'

describe('scan-all service', () => {
  test('scans a single tool dir and returns aggregated result', () => {
    const { dir, cleanup } = createTempDir()
    const { db, cleanup: cleanupDb } = createTempDb()

    mkdirSync(join(dir, 'codex', 'skills', 'alpha'), { recursive: true })
    writeFileSync(
      join(dir, 'codex', 'skills', 'alpha', 'SKILL.md'),
      '---\nname: alpha\n---\n# alpha\n'
    )

    const tools: ActiveScanDir[] = [
      { key: 'codex', displayName: 'Codex', paths: [join(dir, 'codex', 'skills')] }
    ]
    const result = scanAllTools(db, tools)

    expect(result.totalScanned).toBe(1)
    expect(result.totalUpserted).toBe(1)
    expect(result.tools).toHaveLength(1)
    expect(result.tools[0].key).toBe('codex')
    expect(result.tools[0].path).toBe(join(dir, 'codex', 'skills'))
    expect(result.tools[0].scanned).toBe(1)
    expect(result.tools[0].upserted).toBe(1)

    expect(getSkillByName(db, 'alpha')).toBeDefined()

    cleanup()
    cleanupDb()
  })

  test('scans multiple enabled+existing dirs in one call (concurrent scan)', () => {
    const { dir, cleanup } = createTempDir()
    const { db, cleanup: cleanupDb } = createTempDb()

    // 三个不同工具目录,每个一个 skill
    mkdirSync(join(dir, '.codex', 'skills', 'codex-skill'), { recursive: true })
    writeFileSync(
      join(dir, '.codex', 'skills', 'codex-skill', 'SKILL.md'),
      '---\nname: codex-skill\n---\n'
    )
    mkdirSync(join(dir, '.agents', 'skills', 'agents-skill'), { recursive: true })
    writeFileSync(
      join(dir, '.agents', 'skills', 'agents-skill', 'SKILL.md'),
      '---\nname: agents-skill\n---\n'
    )
    mkdirSync(join(dir, '.gemini', 'skills', 'gemini-skill'), { recursive: true })
    writeFileSync(
      join(dir, '.gemini', 'skills', 'gemini-skill', 'SKILL.md'),
      '---\nname: gemini-skill\n---\n'
    )

    const tools: ActiveScanDir[] = [
      { key: 'codex', displayName: 'Codex', paths: [join(dir, '.codex', 'skills')] },
      { key: 'agents', displayName: 'Agents', paths: [join(dir, '.agents', 'skills')] },
      { key: 'gemini-cli', displayName: 'Gemini CLI', paths: [join(dir, '.gemini', 'skills')] }
    ]
    const result = scanAllTools(db, tools)

    expect(result.totalScanned).toBe(3)
    expect(result.totalUpserted).toBe(3)
    expect(result.tools).toHaveLength(3)

    for (const name of ['codex-skill', 'agents-skill', 'gemini-skill']) {
      expect(getSkillByName(db, name)).toBeDefined()
    }

    cleanup()
    cleanupDb()
  })

  test('skips non-existent dirs gracefully (empty result entry, no throw)', () => {
    const { dir, cleanup } = createTempDir()
    const { db, cleanup: cleanupDb } = createTempDb()

    // 只创建 codex,agents 路径不存在
    mkdirSync(join(dir, '.codex', 'skills', 'only-one'), { recursive: true })
    writeFileSync(
      join(dir, '.codex', 'skills', 'only-one', 'SKILL.md'),
      '---\nname: only-one\n---\n'
    )

    const tools: ActiveScanDir[] = [
      { key: 'codex', displayName: 'Codex', paths: [join(dir, '.codex', 'skills')] },
      { key: 'agents', displayName: 'Agents', paths: [join(dir, '.agents', 'skills')] }
    ]
    const result = scanAllTools(db, tools)

    // codex 扫到 1,agents 路径不存在 -> 该工具 0 扫描(不应抛错)
    expect(result.totalScanned).toBe(1)
    const agentsEntry = result.tools.find((t) => t.key === 'agents')!
    expect(agentsEntry.scanned).toBe(0)
    expect(getSkillByName(db, 'only-one')).toBeDefined()

    cleanup()
    cleanupDb()
  })

  test('TRAE multiple paths are scanned as separate entries', () => {
    const { dir, cleanup } = createTempDir()
    const { db, cleanup: cleanupDb } = createTempDb()

    // trae 两个路径各放一个 skill
    mkdirSync(join(dir, '.trae-cn', 'skills', 'cn-skill'), { recursive: true })
    writeFileSync(
      join(dir, '.trae-cn', 'skills', 'cn-skill', 'SKILL.md'),
      '---\nname: cn-skill\n---\n'
    )
    mkdirSync(join(dir, '.trae', 'skills', 'intl-skill'), { recursive: true })
    writeFileSync(
      join(dir, '.trae', 'skills', 'intl-skill', 'SKILL.md'),
      '---\nname: intl-skill\n---\n'
    )

    const tools: ActiveScanDir[] = [
      {
        key: 'trae',
        displayName: 'TRAE',
        paths: [
          join(dir, '.trae-cn', 'skills'),
          join(dir, '.trae', 'skills')
        ]
      }
    ]
    const result = scanAllTools(db, tools)

    expect(result.totalScanned).toBe(2)
    expect(result.tools).toHaveLength(2) // 两个路径各一个条目
    expect(result.tools.map((t) => t.path).sort()).toEqual(
      [join(dir, '.trae', 'skills'), join(dir, '.trae-cn', 'skills')].sort()
    )

    const skills = getAllSkills(db).map((s) => s.name)
    expect(skills).toContain('cn-skill')
    expect(skills).toContain('intl-skill')

    cleanup()
    cleanupDb()
  })

  test('empty tools list yields empty result', () => {
    const { db, cleanup: cleanupDb } = createTempDb()
    const result = scanAllTools(db, [])
    expect(result.totalScanned).toBe(0)
    expect(result.totalUpserted).toBe(0)
    expect(result.tools).toEqual([])
    cleanupDb()
  })

  test('repeated scan is idempotent (no duplicate skills/sources)', () => {
    const { dir, cleanup } = createTempDir()
    const { db, cleanup: cleanupDb } = createTempDb()

    mkdirSync(join(dir, '.codex', 'skills', 'stable'), { recursive: true })
    writeFileSync(
      join(dir, '.codex', 'skills', 'stable', 'SKILL.md'),
      '---\nname: stable\n---\n'
    )

    const tools: ActiveScanDir[] = [
      { key: 'codex', displayName: 'Codex', paths: [join(dir, '.codex', 'skills')] }
    ]
    scanAllTools(db, tools)
    scanAllTools(db, tools)

    const skill = getSkillByName(db, 'stable')
    expect(skill).toBeDefined()
    // 同一 skill 不会重复创建(name UNIQUE);source 也只有一条
    const all = getAllSkills(db).filter((s) => s.name === 'stable')
    expect(all).toHaveLength(1)

    cleanup()
    cleanupDb()
  })
})
