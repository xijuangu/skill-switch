import { test, expect, describe } from 'vitest'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createTempDir, createTempDb } from './helpers/temp'
import { scanToolDir } from '../src/main/services/scanner'
import { scanAllTools } from '../src/main/services/scan-all'
import { computeConflict, getConflictStatus, getAllConflicts } from '../src/main/services/registry'
import { getSkillByName, getAllSkills } from '../src/main/db/dao/skills'
import { getSourcesBySkillId, upsertSource } from '../src/main/db/dao/skill-sources'
import { upsertSkill } from '../src/main/db/dao/skills'
import { runInTransaction } from '../src/main/db/database'
import type { ActiveScanDir } from '../src/main/services/tools-config'
import type { SkillSource } from '../src/main/types'

/** 测试用:构造完整 SkillSource(repo_url/commit_sha 默认 null) */
function mkSrc(partial: Partial<SkillSource> & Pick<SkillSource, 'id' | 'path' | 'hash'>): SkillSource {
  return {
    skill_id: 7,
    mtime: 100,
    source_type: 'indexed',
    discovered_at: '2026-01-01T00:00:00.000Z',
    repo_url: null,
    commit_sha: null,
    ...partial
  }
}

describe('registry service — multi-source identity + conflict detection', () => {
  describe('computeConflict (pure)', () => {
    test('empty sources → no conflict, primarySource null', () => {
      const status = computeConflict([], 1)
      expect(status.sourceCount).toBe(0)
      expect(status.distinctHashCount).toBe(0)
      expect(status.hasConflict).toBe(false)
      expect(status.primarySource).toBeNull()
    })

    test('single source → no conflict, primarySource = that source', () => {
      const src = mkSrc({ id: 1, path: '/a', hash: 'h1' })
      const status = computeConflict([src], 7)
      expect(status.sourceCount).toBe(1)
      expect(status.distinctHashCount).toBe(1)
      expect(status.hasConflict).toBe(false)
      expect(status.primarySource).toBe(src)
    })

    test('multiple sources same hash → no conflict, primarySource = first', () => {
      const srcA = mkSrc({ id: 1, path: '/a', hash: 'same', discovered_at: '2026-01-01T00:00:00.000Z' })
      const srcB = mkSrc({ id: 2, path: '/b', hash: 'same', mtime: 200, discovered_at: '2026-01-02T00:00:00.000Z' })
      const status = computeConflict([srcA, srcB], 7)
      expect(status.sourceCount).toBe(2)
      expect(status.distinctHashCount).toBe(1)
      expect(status.hasConflict).toBe(false)
      expect(status.primarySource).toBe(srcA)
    })

    test('multiple sources different hashes → conflict, primarySource undefined', () => {
      const srcA = mkSrc({ id: 1, path: '/a', hash: 'h1', discovered_at: '2026-01-01T00:00:00.000Z' })
      const srcB = mkSrc({ id: 2, path: '/b', hash: 'h2', mtime: 200, discovered_at: '2026-01-02T00:00:00.000Z' })
      const status = computeConflict([srcA, srcB], 7)
      expect(status.sourceCount).toBe(2)
      expect(status.distinctHashCount).toBe(2)
      expect(status.hasConflict).toBe(true)
      expect(status.primarySource).toBeNull()
    })

    test('three sources two distinct hashes → conflict', () => {
      const srcA = mkSrc({ id: 1, path: '/a', hash: 'h1', discovered_at: '2026-01-01T00:00:00.000Z' })
      const srcB = mkSrc({ id: 2, path: '/b', hash: 'h1', mtime: 200, discovered_at: '2026-01-02T00:00:00.000Z' })
      const srcC = mkSrc({ id: 3, path: '/c', hash: 'h2', mtime: 300, discovered_at: '2026-01-03T00:00:00.000Z' })
      const status = computeConflict([srcA, srcB, srcC], 7)
      expect(status.sourceCount).toBe(3)
      expect(status.distinctHashCount).toBe(2)
      expect(status.hasConflict).toBe(true)
      expect(status.primarySource).toBeNull()
    })
  })

  describe('multi-source upsert via scanner', () => {
    test('scanning same skill name from two tool dirs → 1 skill with 2 sources, no overwrite', () => {
      const { dir, cleanup } = createTempDir()
      const { db, cleanup: cleanupDb } = createTempDb()

      // 两个工具目录,各自有同名 skill(内容相同)
      mkdirSync(join(dir, 'codex', 'skills', 'shared'), { recursive: true })
      writeFileSync(
        join(dir, 'codex', 'skills', 'shared', 'SKILL.md'),
        '---\nname: shared\n---\n# shared\n'
      )
      mkdirSync(join(dir, 'agents', 'skills', 'shared'), { recursive: true })
      writeFileSync(
        join(dir, 'agents', 'skills', 'shared', 'SKILL.md'),
        '---\nname: shared\n---\n# shared\n'
      )

      const tools: ActiveScanDir[] = [
        { key: 'codex', displayName: 'Codex', paths: [join(dir, 'codex', 'skills')] },
        { key: 'agents', displayName: 'Agents', paths: [join(dir, 'agents', 'skills')] }
      ]
      scanAllTools(db, tools)

      const skill = getSkillByName(db, 'shared')
      expect(skill).toBeDefined()
      const sources = getSourcesBySkillId(db, skill!.id)
      expect(sources).toHaveLength(2)
      // 两个 source 路径不同,均保留
      const paths = sources.map((s) => s.path).sort()
      expect(paths).toEqual([
        join(dir, 'agents', 'skills', 'shared'),
        join(dir, 'codex', 'skills', 'shared')
      ].sort())
      // 内容一致 → hash 相同
      expect(sources[0].hash).toBe(sources[1].hash)

      cleanup()
      cleanupDb()
    })

    test('re-scan same dir does not duplicate source (idempotent upsert by skill_id+path)', () => {
      const { dir, cleanup } = createTempDir()
      const { db, cleanup: cleanupDb } = createTempDb()

      mkdirSync(join(dir, 'codex', 'skills', 'stable'), { recursive: true })
      writeFileSync(
        join(dir, 'codex', 'skills', 'stable', 'SKILL.md'),
        '---\nname: stable\n---\n'
      )
      const tools: ActiveScanDir[] = [
        { key: 'codex', displayName: 'Codex', paths: [join(dir, 'codex', 'skills')] }
      ]
      scanAllTools(db, tools)
      scanAllTools(db, tools)

      const skill = getSkillByName(db, 'stable')
      const sources = getSourcesBySkillId(db, skill!.id)
      expect(sources).toHaveLength(1)

      cleanup()
      cleanupDb()
    })

    test('new source for existing skill does NOT overwrite existing source rows', () => {
      const { dir, cleanup } = createTempDir()
      const { db, cleanup: cleanupDb } = createTempDb()

      // 第一次扫 codex 目录,登记 shared skill
      mkdirSync(join(dir, 'codex', 'skills', 'shared'), { recursive: true })
      writeFileSync(
        join(dir, 'codex', 'skills', 'shared', 'SKILL.md'),
        '---\nname: shared\n---\nv1\n'
      )
      const codexTools: ActiveScanDir[] = [
        { key: 'codex', displayName: 'Codex', paths: [join(dir, 'codex', 'skills')] }
      ]
      scanAllTools(db, codexTools)

      const skill = getSkillByName(db, 'shared')
      const sourcesBefore = getSourcesBySkillId(db, skill!.id)
      expect(sourcesBefore).toHaveLength(1)
      const codexSource = sourcesBefore[0]

      // 第二次扫 agents 目录,发现同名 skill 在不同路径 → upsert 新 source,不覆盖已有
      mkdirSync(join(dir, 'agents', 'skills', 'shared'), { recursive: true })
      writeFileSync(
        join(dir, 'agents', 'skills', 'shared', 'SKILL.md'),
        '---\nname: shared\n---\nv1\n'
      )
      const agentsTools: ActiveScanDir[] = [
        { key: 'agents', displayName: 'Agents', paths: [join(dir, 'agents', 'skills')] }
      ]
      scanAllTools(db, agentsTools)

      const sourcesAfter = getSourcesBySkillId(db, skill!.id)
      expect(sourcesAfter).toHaveLength(2)
      // 原有 codex source 仍然存在(同 path 同 hash)
      const stillCodex = sourcesAfter.find((s) => s.path === codexSource.path)
      expect(stillCodex).toBeDefined()
      expect(stillCodex!.hash).toBe(codexSource.hash)
      // 新增 agents source
      const agentsSource = sourcesAfter.find(
        (s) => s.path === join(dir, 'agents', 'skills', 'shared')
      )
      expect(agentsSource).toBeDefined()

      cleanup()
      cleanupDb()
    })
  })

  describe('getConflictStatus (with DB)', () => {
    test('consistent multi-source → no conflict, primarySource = first discovered', () => {
      const { dir, cleanup } = createTempDir()
      const { db, cleanup: cleanupDb } = createTempDb()

      mkdirSync(join(dir, 'codex', 'skills', 'dup'), { recursive: true })
      writeFileSync(join(dir, 'codex', 'skills', 'dup', 'SKILL.md'), '---\nname: dup\n---\nbody\n')
      mkdirSync(join(dir, 'agents', 'skills', 'dup'), { recursive: true })
      writeFileSync(join(dir, 'agents', 'skills', 'dup', 'SKILL.md'), '---\nname: dup\n---\nbody\n')

      const tools: ActiveScanDir[] = [
        { key: 'codex', displayName: 'Codex', paths: [join(dir, 'codex', 'skills')] },
        { key: 'agents', displayName: 'Agents', paths: [join(dir, 'agents', 'skills')] }
      ]
      scanAllTools(db, tools)

      const skill = getSkillByName(db, 'dup')!
      const status = getConflictStatus(db, skill.id)
      expect(status.sourceCount).toBe(2)
      expect(status.distinctHashCount).toBe(1)
      expect(status.hasConflict).toBe(false)
      expect(status.primarySource).toBeDefined()
      // primarySource 应是 sources 中按 discovered_at ASC 排序的第一个
      const sources = getSourcesBySkillId(db, skill.id)
      expect(status.primarySource).toEqual(sources[0])

      cleanup()
      cleanupDb()
    })

    test('conflicting multi-source → hasConflict, primarySource undefined, no auto-merge', () => {
      const { dir, cleanup } = createTempDir()
      const { db, cleanup: cleanupDb } = createTempDb()

      // 两个目录的同名 skill 内容不同
      mkdirSync(join(dir, 'codex', 'skills', 'diverged'), { recursive: true })
      writeFileSync(
        join(dir, 'codex', 'skills', 'diverged', 'SKILL.md'),
        '---\nname: diverged\n---\nV1\n'
      )
      mkdirSync(join(dir, 'agents', 'skills', 'diverged'), { recursive: true })
      writeFileSync(
        join(dir, 'agents', 'skills', 'diverged', 'SKILL.md'),
        '---\nname: diverged\n---\nV2-different\n'
      )

      const tools: ActiveScanDir[] = [
        { key: 'codex', displayName: 'Codex', paths: [join(dir, 'codex', 'skills')] },
        { key: 'agents', displayName: 'Agents', paths: [join(dir, 'agents', 'skills')] }
      ]
      scanAllTools(db, tools)

      const skill = getSkillByName(db, 'diverged')!
      const status = getConflictStatus(db, skill.id)
      expect(status.sourceCount).toBe(2)
      expect(status.distinctHashCount).toBe(2)
      expect(status.hasConflict).toBe(true)
      expect(status.primarySource).toBeNull()

      // 关键:不自动合并 — 两个 source 都保留,各自 hash 不变
      const sources = getSourcesBySkillId(db, skill.id)
      expect(sources).toHaveLength(2)
      expect(sources[0].hash).not.toBe(sources[1].hash)

      cleanup()
      cleanupDb()
    })

    test('single source → no conflict, primarySource = that source', () => {
      const { dir, cleanup } = createTempDir()
      const { db, cleanup: cleanupDb } = createTempDb()

      mkdirSync(join(dir, 'codex', 'skills', 'lonely'), { recursive: true })
      writeFileSync(join(dir, 'codex', 'skills', 'lonely', 'SKILL.md'), '---\nname: lonely\n---\n')
      scanToolDir(db, join(dir, 'codex', 'skills'))

      const skill = getSkillByName(db, 'lonely')!
      const status = getConflictStatus(db, skill.id)
      expect(status.sourceCount).toBe(1)
      expect(status.hasConflict).toBe(false)
      expect(status.primarySource).toBeDefined()
      expect(status.primarySource!.path).toBe(join(dir, 'codex', 'skills', 'lonely'))

      cleanup()
      cleanupDb()
    })

    test('skill with no sources → no conflict, primarySource null', () => {
      const { db, cleanup: cleanupDb } = createTempDb()
      // 直接插一个 skill 不带 source(边界情况,理论上不应发生但应安全处理)
      const skillId = runInTransaction(db, () => upsertSkill(db, 'orphan', '/nowhere'))
      const status = getConflictStatus(db, skillId)
      expect(status.sourceCount).toBe(0)
      expect(status.hasConflict).toBe(false)
      expect(status.primarySource).toBeNull()
      cleanupDb()
    })
  })

  describe('getAllConflicts', () => {
    test('returns only skills with conflicts, skips consistent and single-source', () => {
      const { dir, cleanup } = createTempDir()
      const { db, cleanup: cleanupDb } = createTempDb()

      // conflict: diverged in 2 dirs with different content
      mkdirSync(join(dir, 'codex', 'skills', 'diverged'), { recursive: true })
      writeFileSync(join(dir, 'codex', 'skills', 'diverged', 'SKILL.md'), '---\nname: diverged\n---\nA\n')
      mkdirSync(join(dir, 'agents', 'skills', 'diverged'), { recursive: true })
      writeFileSync(join(dir, 'agents', 'skills', 'diverged', 'SKILL.md'), '---\nname: diverged\n---\nB\n')

      // consistent: same in 2 dirs
      mkdirSync(join(dir, 'codex', 'skills', 'consistent'), { recursive: true })
      writeFileSync(join(dir, 'codex', 'skills', 'consistent', 'SKILL.md'), '---\nname: consistent\n---\nX\n')
      mkdirSync(join(dir, 'agents', 'skills', 'consistent'), { recursive: true })
      writeFileSync(join(dir, 'agents', 'skills', 'consistent', 'SKILL.md'), '---\nname: consistent\n---\nX\n')

      // single source
      mkdirSync(join(dir, 'codex', 'skills', 'lonely'), { recursive: true })
      writeFileSync(join(dir, 'codex', 'skills', 'lonely', 'SKILL.md'), '---\nname: lonely\n---\n')

      const tools: ActiveScanDir[] = [
        { key: 'codex', displayName: 'Codex', paths: [join(dir, 'codex', 'skills')] },
        { key: 'agents', displayName: 'Agents', paths: [join(dir, 'agents', 'skills')] }
      ]
      scanAllTools(db, tools)

      const all = getAllSkills(db)
      const conflicts = getAllConflicts(db, all.map((s) => s.id))

      expect(conflicts).toHaveLength(1)
      expect(conflicts[0].skillId).toBe(getSkillByName(db, 'diverged')!.id)
      expect(conflicts[0].hasConflict).toBe(true)

      cleanup()
      cleanupDb()
    })

    test('empty when no conflicts', () => {
      const { dir, cleanup } = createTempDir()
      const { db, cleanup: cleanupDb } = createTempDb()

      mkdirSync(join(dir, 'codex', 'skills', 'only-one'), { recursive: true })
      writeFileSync(join(dir, 'codex', 'skills', 'only-one', 'SKILL.md'), '---\nname: only-one\n---\n')
      scanToolDir(db, join(dir, 'codex', 'skills'))

      const all = getAllSkills(db)
      const conflicts = getAllConflicts(db, all.map((s) => s.id))
      expect(conflicts).toHaveLength(0)

      cleanup()
      cleanupDb()
    })
  })

  describe('source list query', () => {
    test('getSourcesBySkillId returns sources ordered by discovered_at ASC', () => {
      const { db, cleanup: cleanupDb } = createTempDb()
      const { dir, cleanup } = createTempDir()

      // 直接构造:同一 skill 三个 source,通过 upsertSource 逐个插
      const skillId = runInTransaction(db, () => upsertSkill(db, 'multi', '/first'))
      runInTransaction(db, () => {
        upsertSource(db, skillId, '/first', 'h1', 100, 'indexed')
      })
      // 稍后插第二、第三个(discovered_at 由 upsertSource 设为 new Date().toISOString())
      // 由于 ISO 时间戳精度到毫秒,顺序插值时 ASC 排序保留插入顺序
      runInTransaction(db, () => {
        upsertSource(db, skillId, '/second', 'h2', 200, 'indexed')
      })
      runInTransaction(db, () => {
        upsertSource(db, skillId, '/third', 'h3', 300, 'indexed')
      })

      const sources = getSourcesBySkillId(db, skillId)
      expect(sources).toHaveLength(3)
      expect(sources.map((s) => s.path)).toEqual(['/first', '/second', '/third'])

      // computeConflict 用 sources[0] 作 primarySource(无冲突时)
      const status = computeConflict(sources, skillId)
      expect(status.hasConflict).toBe(true) // 3 个不同 hash
      expect(status.primarySource).toBeNull()

      cleanup()
      cleanupDb()
    })

    test('source fields include path / hash / mtime / source_type / discovered_at', () => {
      const { dir, cleanup } = createTempDir()
      const { db, cleanup: cleanupDb } = createTempDb()

      mkdirSync(join(dir, 'codex', 'skills', 'field-check'), { recursive: true })
      writeFileSync(join(dir, 'codex', 'skills', 'field-check', 'SKILL.md'), '---\nname: field-check\n---\n')
      scanToolDir(db, join(dir, 'codex', 'skills'))

      const skill = getSkillByName(db, 'field-check')!
      const sources = getSourcesBySkillId(db, skill.id)
      expect(sources).toHaveLength(1)
      const s = sources[0]
      expect(typeof s.path).toBe('string')
      expect(s.path).toBe(join(dir, 'codex', 'skills', 'field-check'))
      expect(typeof s.hash).toBe('string')
      expect(s.hash.length).toBe(64) // sha256 hex
      expect(typeof s.mtime).toBe('number')
      expect(s.mtime).toBeGreaterThan(0)
      expect(s.source_type).toBe('indexed')
      expect(typeof s.discovered_at).toBe('string')
      // ISO 8601 格式
      expect(s.discovered_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)

      cleanup()
      cleanupDb()
    })
  })
})
