import { test, expect, describe } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createTempDir, createTempDb } from './helpers/temp'
import { scanAllTools } from '../src/main/services/scan-all'
import { getSkillByName } from '../src/main/db/dao/skills'
import { getAllSkills } from '../src/main/db/dao/skills'
import { getSourcesBySkillId, upsertSource } from '../src/main/db/dao/skill-sources'
import type { ActiveScanDir } from '../src/main/services/tools-config'
import { executePreparedDeployment } from '../src/main/services/deployer'
import { upsertSkill } from '../src/main/db/dao/skills'

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

  test('successful rescan removes a deleted indexed skill without leaving an orphan skill', () => {
    const { dir, cleanup } = createTempDir()
    const { db, cleanup: cleanupDb } = createTempDb()
    const toolDir = join(dir, '.codex', 'skills')
    const skillDir = join(toolDir, 'obsolete')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: obsolete\n---\n'
    )
    const tools: ActiveScanDir[] = [
      { key: 'codex', displayName: 'Codex', paths: [toolDir] }
    ]

    scanAllTools(db, tools)
    rmSync(skillDir, { recursive: true, force: true })
    scanAllTools(db, tools)

    expect(getSkillByName(db, 'obsolete')).toBeUndefined()

    cleanup()
    cleanupDb()
  })

  test('temporarily missing scan directory preserves previously indexed sources', () => {
    const { dir, cleanup } = createTempDir()
    const { db, cleanup: cleanupDb } = createTempDb()
    const toolDir = join(dir, '.codex', 'skills')
    const skillDir = join(toolDir, 'keep-me')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: keep-me\n---\n'
    )
    const tools: ActiveScanDir[] = [
      { key: 'codex', displayName: 'Codex', paths: [toolDir] }
    ]

    scanAllTools(db, tools)
    const skill = getSkillByName(db, 'keep-me')!
    rmSync(toolDir, { recursive: true, force: true })
    scanAllTools(db, tools)

    expect(getSourcesBySkillId(db, skill.id)).toHaveLength(1)

    cleanup()
    cleanupDb()
  })

  test('copy deployment skips only its exact target path in a multi-path tool', () => {
    const root = createTempDir('scan-all-copy-skip-')
    const backups = createTempDir('scan-all-copy-backups-')
    const { db, cleanup: cleanupDb } = createTempDb()
    const source = join(root.dir, 'source', 'shared')
    const firstTool = join(root.dir, 'tool-a')
    const secondTool = join(root.dir, 'tool-b')
    mkdirSync(source, { recursive: true })
    mkdirSync(firstTool)
    mkdirSync(join(secondTool, 'shared'), { recursive: true })
    writeFileSync(join(source, 'SKILL.md'), '---\nname: shared\n---\nsource')
    writeFileSync(
      join(secondTool, 'shared', 'SKILL.md'),
      '---\nname: shared\n---\nexternal-second-path'
    )
    const skillId = upsertSkill(db, 'shared', source)
    upsertSource(db, skillId, source, 'fixture-hash', Date.now(), 'indexed')
    const sourceId = getSourcesBySkillId(db, skillId)[0].id
    executePreparedDeployment(db, {
      skillId,
      skillName: 'shared',
      targetTool: 'trae',
      mode: 'copy',
      sourcePath: source,
      targetDir: join(firstTool, 'shared'),
      backupsDir: backups.dir,
      canSymlink: true,
      canJunction: false,
      identity: { sourceId, targetId: 'trae-0' }
    })

    scanAllTools(db, [
      {
        key: 'trae',
        displayName: 'TRAE',
        paths: [firstTool, secondTool]
      }
    ])

    expect(getSourcesBySkillId(db, skillId).map((item) => item.path).sort()).toEqual([
      source,
      join(secondTool, 'shared')
    ].sort())

    root.cleanup()
    backups.cleanup()
    cleanupDb()
  })
})
