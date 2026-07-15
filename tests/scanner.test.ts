import { test, expect, describe } from 'vitest'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createTempDir, createTempDb } from './helpers/temp'
import { scanToolDir } from '../src/main/services/scanner'
import { getSkillByName } from '../src/main/db/dao/skills'
import { getSourcesBySkillId } from '../src/main/db/dao/skill-sources'

describe('scanner', () => {
  test.runIf(process.platform !== 'win32')('indexes a valid directory symlink while preserving its Discovery Target path', () => {
    const tool = createTempDir('scanner-link-tool-')
    const source = createTempDir('scanner-link-source-')
    const { db, cleanup: cleanupDb } = createTempDb()
    const realSkill = join(source.dir, 'to-tickets')
    const linkedSkill = join(tool.dir, 'to-tickets')
    mkdirSync(realSkill)
    writeFileSync(join(realSkill, 'SKILL.md'), '---\nname: to-tickets\n---\n')
    symlinkSync(realSkill, linkedSkill)

    const result = scanToolDir(db, tool.dir, new Set(), 'agents')

    expect(result).toMatchObject({ scanned: 1, upserted: 1, scannedPaths: [linkedSkill] })
    const skill = getSkillByName(db, 'to-tickets')
    expect(skill).toBeDefined()
    expect(getSourcesBySkillId(db, skill!.id)).toMatchObject([
      { path: linkedSkill, source_tool: 'agents', source_origin: 'scan' }
    ])

    tool.cleanup()
    source.cleanup()
    cleanupDb()
  })

  test.runIf(process.platform !== 'win32')('skips broken symlinks and symlinks to ordinary files without aborting the scan', () => {
    const tool = createTempDir('scanner-invalid-links-')
    const { db, cleanup: cleanupDb } = createTempDb()
    const file = join(tool.dir, 'plain.txt')
    writeFileSync(file, 'not a skill directory')
    symlinkSync(join(tool.dir, 'missing'), join(tool.dir, 'broken-skill'))
    symlinkSync(file, join(tool.dir, 'file-skill'))

    expect(scanToolDir(db, tool.dir, new Set(), 'agents')).toEqual({
      scanned: 0,
      upserted: 0,
      scannedPaths: []
    })

    tool.cleanup()
    cleanupDb()
  })

  test.runIf(process.platform !== 'win32')('registers distinct Source paths when two links discover the same real Skill', () => {
    const tool = createTempDir('scanner-multiple-links-')
    const source = createTempDir('scanner-shared-source-')
    const { db, cleanup: cleanupDb } = createTempDb()
    const realSkill = join(source.dir, 'shared')
    const firstLink = join(tool.dir, 'shared-a')
    const secondLink = join(tool.dir, 'shared-b')
    mkdirSync(realSkill)
    writeFileSync(join(realSkill, 'SKILL.md'), '---\nname: shared\n---\n')
    symlinkSync(realSkill, firstLink)
    symlinkSync(realSkill, secondLink)

    expect(scanToolDir(db, tool.dir, new Set(), 'agents').scanned).toBe(2)
    const skill = getSkillByName(db, 'shared')
    expect(getSourcesBySkillId(db, skill!.id).map((item) => item.path).sort()).toEqual(
      [firstLink, secondLink].sort()
    )

    tool.cleanup()
    source.cleanup()
    cleanupDb()
  })

  test.runIf(process.platform !== 'win32')('keeps copy Deployment skipPaths authoritative for linked entries', () => {
    const tool = createTempDir('scanner-skipped-link-')
    const source = createTempDir('scanner-skipped-source-')
    const { db, cleanup: cleanupDb } = createTempDb()
    const realSkill = join(source.dir, 'managed-copy')
    const linkedSkill = join(tool.dir, 'managed-copy')
    mkdirSync(realSkill)
    writeFileSync(join(realSkill, 'SKILL.md'), '---\nname: managed-copy\n---\n')
    symlinkSync(realSkill, linkedSkill)

    expect(scanToolDir(db, tool.dir, new Set([linkedSkill]), 'agents')).toEqual({
      scanned: 0,
      upserted: 0,
      scannedPaths: []
    })

    tool.cleanup()
    source.cleanup()
    cleanupDb()
  })

  test('scans tool dir and registers skill from SKILL.md frontmatter name', () => {
    const { dir, cleanup } = createTempDir()
    const { db, cleanup: cleanupDb } = createTempDb()

    // 创建 grilling skill 目录 + SKILL.md(带 name frontmatter)
    mkdirSync(join(dir, 'grilling'))
    writeFileSync(
      join(dir, 'grilling', 'SKILL.md'),
      '---\nname: grilling\n---\n# grilling skill\n'
    )

    const result = scanToolDir(db, dir, new Set(), 'codex')

    expect(result.scanned).toBe(1)
    const skill = getSkillByName(db, 'grilling')
    expect(skill).toBeDefined()
    expect(skill!.name).toBe('grilling')

    const sources = getSourcesBySkillId(db, skill!.id)
    expect(sources).toHaveLength(1)
    expect(sources[0].source_type).toBe('indexed')
    expect(sources[0].source_origin).toBe('scan')
    expect(sources[0].source_tool).toBe('codex')
    expect(sources[0].path).toBe(join(dir, 'grilling'))
    expect(sources[0].hash).toBeTruthy()
    expect(sources[0].mtime).toBeGreaterThan(0)

    cleanup()
    cleanupDb()
  })

  test('falls back to directory name when SKILL.md is missing', () => {
    const { dir, cleanup } = createTempDir()
    const { db, cleanup: cleanupDb } = createTempDb()

    mkdirSync(join(dir, 'my-skill-no-md'))
    writeFileSync(join(dir, 'my-skill-no-md', 'prompt.txt'), 'hello')

    const result = scanToolDir(db, dir)

    expect(result.scanned).toBe(1)
    const skill = getSkillByName(db, 'my-skill-no-md')
    expect(skill).toBeDefined()
    expect(skill!.name).toBe('my-skill-no-md')

    cleanup()
    cleanupDb()
  })

  test('falls back to directory name when SKILL.md has no name frontmatter', () => {
    const { dir, cleanup } = createTempDir()
    const { db, cleanup: cleanupDb } = createTempDb()

    mkdirSync(join(dir, 'no-name-skill'))
    writeFileSync(join(dir, 'no-name-skill', 'SKILL.md'), '---\ndescription: foo\n---\n# no name\n')

    scanToolDir(db, dir)

    const skill = getSkillByName(db, 'no-name-skill')
    expect(skill).toBeDefined()

    cleanup()
    cleanupDb()
  })

  test('repeated scan is idempotent (no duplicate records)', () => {
    const { dir, cleanup } = createTempDir()
    const { db, cleanup: cleanupDb } = createTempDb()

    mkdirSync(join(dir, 'stable'))
    writeFileSync(join(dir, 'stable', 'SKILL.md'), '---\nname: stable\n---\n')

    scanToolDir(db, dir)
    scanToolDir(db, dir)

    const skill = getSkillByName(db, 'stable')
    const sources = getSourcesBySkillId(db, skill!.id)
    expect(sources).toHaveLength(1)

    cleanup()
    cleanupDb()
  })

  test('updates hash when source content changes', () => {
    const { dir, cleanup } = createTempDir()
    const { db, cleanup: cleanupDb } = createTempDb()

    mkdirSync(join(dir, 'evolving'))
    const mdPath = join(dir, 'evolving', 'SKILL.md')
    writeFileSync(mdPath, '---\nname: evolving\n---\nv1\n')

    scanToolDir(db, dir)
    const before = getSourcesBySkillId(db, getSkillByName(db, 'evolving')!.id)
    const hashBefore = before[0].hash
    expect(hashBefore).toBeTruthy()

    // 内容变更后再扫
    writeFileSync(mdPath, '---\nname: evolving\n---\nv2 with more content\n')
    scanToolDir(db, dir)

    const after = getSourcesBySkillId(db, getSkillByName(db, 'evolving')!.id)
    expect(after).toHaveLength(1)
    expect(after[0].hash).not.toBe(hashBefore)

    cleanup()
    cleanupDb()
  })

  test('scan does not move or delete original files (index-only)', () => {
    const { dir, cleanup } = createTempDir()
    const { db, cleanup: cleanupDb } = createTempDb()

    mkdirSync(join(dir, 'preserved'))
    const mdContent = '---\nname: preserved\n---\noriginal content\n'
    const mdPath = join(dir, 'preserved', 'SKILL.md')
    writeFileSync(mdPath, mdContent)
    writeFileSync(join(dir, 'preserved', 'extra.txt'), 'extra file\n')

    scanToolDir(db, dir)

    // 原文件内容未变,结构未动
    expect(readFileSync(mdPath, 'utf-8')).toBe(mdContent)
    expect(existsSync(join(dir, 'preserved', 'extra.txt'))).toBe(true)
    expect(existsSync(join(dir, 'preserved', 'SKILL.md'))).toBe(true)

    cleanup()
    cleanupDb()
  })

  test('rejects a frontmatter name that could escape a managed root', () => {
    const tool = createTempDir('scanner-unsafe-name-')
    const { db, cleanup: cleanupDb } = createTempDb()
    const skillDir = join(tool.dir, 'safe-directory')
    mkdirSync(skillDir)
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: ../../escape\n---\n')

    expect(() => scanToolDir(db, tool.dir)).toThrow(/invalid skill name/)

    tool.cleanup()
    cleanupDb()
  })
})
