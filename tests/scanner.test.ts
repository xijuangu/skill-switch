import { test, expect, describe } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createTempDir, createTempDb } from './helpers/temp'
import { scanToolDir } from '../src/main/services/scanner'
import { getSkillByName } from '../src/main/db/dao/skills'
import { getSourcesBySkillId } from '../src/main/db/dao/skill-sources'

describe('scanner', () => {
  test('scans tool dir and registers skill from SKILL.md frontmatter name', () => {
    const { dir, cleanup } = createTempDir()
    const { db, cleanup: cleanupDb } = createTempDb()

    // 创建 grilling skill 目录 + SKILL.md(带 name frontmatter)
    mkdirSync(join(dir, 'grilling'))
    writeFileSync(
      join(dir, 'grilling', 'SKILL.md'),
      '---\nname: grilling\n---\n# grilling skill\n'
    )

    const result = scanToolDir(db, dir)

    expect(result.scanned).toBe(1)
    const skill = getSkillByName(db, 'grilling')
    expect(skill).toBeDefined()
    expect(skill!.name).toBe('grilling')

    const sources = getSourcesBySkillId(db, skill!.id)
    expect(sources).toHaveLength(1)
    expect(sources[0].source_type).toBe('indexed')
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
})
