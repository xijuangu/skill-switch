import { test, expect, describe } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createTempDir, createTempDb } from './helpers/temp'
import { scanToolDir } from '../src/main/services/scanner'
import { scanAllTools } from '../src/main/services/scan-all'
import {
  computeConflict,
  getConflictStatus,
  getAllConflicts,
  assertRegisteredSkillSource,
  removeFromRegistry,
  reconcileIndexedSources,
  filterSourcesByEnabledTools
} from '../src/main/services/registry'
import { getSkillByName, getSkillById, getAllSkills, upsertSkill } from '../src/main/db/dao/skills'
import { getSourcesBySkillId, upsertSource } from '../src/main/db/dao/skill-sources'
import { getDeploymentById, getDeploymentsBySkillId } from '../src/main/db/dao/deployments'
import { deploySkill, undeployDeployment } from '../src/main/services/deployer'
import { listBackups } from '../src/main/services/backup'
import { runInTransaction } from '../src/main/db/database'
import type { ActiveScanDir } from '../src/main/services/tools-config'
import type { SkillSource, ToolConfig } from '../src/main/types'

function undeployForTest(db: import('../src/main/db/database').DB) {
  return async (deploymentId: number) => {
    const deployment = getDeploymentById(db, deploymentId)
    if (!deployment) return { status: 'rejected' as const, message: 'missing deployment' }
    undeployDeployment(db, deployment)
    return { status: 'completed' as const }
  }
}

/** 测试用:构造完整 SkillSource(repo_url/commit_sha 默认 null) */
function mkSrc(partial: Partial<SkillSource> & Pick<SkillSource, 'id' | 'path' | 'hash'>): SkillSource {
  return {
    skill_id: 7,
    mtime: 100,
    source_type: 'indexed',
    source_origin: 'legacy',
    source_tool: null,
    discovered_at: '2026-01-01T00:00:00.000Z',
    repo_url: null,
    commit_sha: null,
    ...partial
  }
}

describe('registry service — multi-source identity + conflict detection', () => {
  test('only accepts source paths registered to the requested skill', () => {
    const { db, cleanup } = createTempDb()
    const root = createTempDir('registry-source-guard-')
    const owned = join(root.dir, 'owned')
    const other = join(root.dir, 'other')
    mkdirSync(owned)
    mkdirSync(other)
    const skillId = upsertSkill(db, 'owned', owned)
    const otherSkillId = upsertSkill(db, 'other', other)
    upsertSource(db, skillId, owned, 'hash-a', 1, 'indexed')
    upsertSource(db, otherSkillId, other, 'hash-b', 1, 'indexed')

    expect(assertRegisteredSkillSource(db, skillId, owned)).toBe(owned)
    expect(() => assertRegisteredSkillSource(db, skillId, other)).toThrow(
      /not registered/
    )

    root.cleanup()
    cleanup()
  })

  test('removed tool path drops its source and promotes the remaining source', () => {
    const { db, cleanup } = createTempDb()
    const first = createTempDir('registry-old-tool-')
    const second = createTempDir('registry-new-tool-')
    const firstSkill = join(first.dir, 'shared')
    const secondSkill = join(second.dir, 'shared')
    mkdirSync(firstSkill)
    mkdirSync(secondSkill)
    writeFileSync(join(firstSkill, 'SKILL.md'), '---\nname: shared\n---\none')
    writeFileSync(join(secondSkill, 'SKILL.md'), '---\nname: shared\n---\ntwo')
    scanToolDir(db, first.dir)
    scanToolDir(db, second.dir)
    const skill = getSkillByName(db, 'shared')!

    expect(reconcileIndexedSources(db, [first.dir], [])).toBe(1)
    expect(getSourcesBySkillId(db, skill.id).map((source) => source.path)).toEqual([
      secondSkill
    ])
    expect(getSkillById(db, skill.id)?.primary_source_path).toBe(secondSkill)

    first.cleanup()
    second.cleanup()
    cleanup()
  })

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

// helper:在 dir 下创建一个含 SKILL.md 的 skill 目录,返回其路径
function writeSkillDir(parent: string, name: string, content: string): string {
  const skillDir = join(parent, name)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), content)
  return skillDir
}

/** 测试用:构造 ToolConfig(默认 enabled + exists=true) */
function mkTool(partial: Partial<ToolConfig> & Pick<ToolConfig, 'key' | 'paths'>): ToolConfig {
  const targets = partial.targets ?? partial.paths.map((path, index) => ({ id: `${partial.key}-${index}`, path }))
  return {
    displayName: partial.key ?? 'Tool',
    enabled: true,
    existingPaths: partial.paths,
    targets,
    existingTargets: partial.existingTargets ?? targets,
    isCustom: false,
    exists: true,
    ...partial
  }
}

// issue #20:禁用预设工具后,技能页应隐藏仅来自该工具配置路径的 source
describe('filterSourcesByEnabledTools (issue #20)', () => {
  test('single source from enabled tool → kept', () => {
    const toolDir = '/home/u/.codex/skills'
    const src = mkSrc({ id: 1, path: `${toolDir}/grilling`, hash: 'h1', source_origin: 'scan', source_tool: 'codex' })
    const tools = [mkTool({ key: 'codex', paths: [toolDir] })]
    expect(filterSourcesByEnabledTools([src], tools)).toEqual([src])
  })

  test('single source from disabled tool → hidden (empty result)', () => {
    const toolDir = '/home/u/.codex/skills'
    const src = mkSrc({ id: 1, path: `${toolDir}/grilling`, hash: 'h1', source_origin: 'scan', source_tool: 'codex' })
    const tools = [mkTool({ key: 'codex', paths: [toolDir], enabled: false })]
    expect(filterSourcesByEnabledTools([src], tools)).toEqual([])
  })

  test('multi-source: enabled + disabled → only enabled source shown', () => {
    const codexDir = '/home/u/.codex/skills'
    const agentsDir = '/home/u/.agents/skills'
    const codexSrc = mkSrc({ id: 1, path: `${codexDir}/shared`, hash: 'h1', source_origin: 'scan', source_tool: 'codex', discovered_at: '2026-01-01T00:00:00.000Z' })
    const agentsSrc = mkSrc({ id: 2, path: `${agentsDir}/shared`, hash: 'h1', source_origin: 'scan', source_tool: 'agents', mtime: 200, discovered_at: '2026-01-02T00:00:00.000Z' })
    const tools = [
      mkTool({ key: 'codex', paths: [codexDir] }),
      mkTool({ key: 'agents', paths: [agentsDir], enabled: false })
    ]
    const result = filterSourcesByEnabledTools([codexSrc, agentsSrc], tools)
    expect(result).toEqual([codexSrc])
  })

  test('conflicting sources: disabled conflicting source hidden → conflict recomputed as none', () => {
    const codexDir = '/home/u/.codex/skills'
    const agentsDir = '/home/u/.agents/skills'
    const codexSrc = mkSrc({ id: 1, path: `${codexDir}/diverged`, hash: 'hA', source_origin: 'scan', source_tool: 'codex', discovered_at: '2026-01-01T00:00:00.000Z' })
    const agentsSrc = mkSrc({ id: 2, path: `${agentsDir}/diverged`, hash: 'hB', source_origin: 'scan', source_tool: 'agents', mtime: 200, discovered_at: '2026-01-02T00:00:00.000Z' })
    const tools = [
      mkTool({ key: 'codex', paths: [codexDir] }),
      mkTool({ key: 'agents', paths: [agentsDir], enabled: false })
    ]
    // 未过滤前两个 source 内容冲突
    expect(computeConflict([codexSrc, agentsSrc], 7).hasConflict).toBe(true)
    // 过滤后只剩 codex source,冲突消失
    const visible = filterSourcesByEnabledTools([codexSrc, agentsSrc], tools)
    expect(visible).toEqual([codexSrc])
    expect(computeConflict(visible, 7).hasConflict).toBe(false)
  })

  test('central-repo source always kept regardless of tool state', () => {
    const centralDir = '/home/u/.skill-switch/skills'
    const centralSrc = mkSrc({
      id: 1,
      path: `${centralDir}/grilling`,
      hash: 'h1',
      source_type: 'central-repo'
    })
    // 即使所有工具都禁用,central-repo 仍保留
    const tools = [
      mkTool({ key: 'codex', paths: ['/home/u/.codex/skills'], enabled: false })
    ]
    expect(filterSourcesByEnabledTools([centralSrc], tools)).toEqual([centralSrc])
  })

  test('central-repo + disabled-tool indexed source → only central-repo kept', () => {
    const centralDir = '/home/u/.skill-switch/skills'
    const codexDir = '/home/u/.codex/skills'
    const centralSrc = mkSrc({
      id: 1,
      path: `${centralDir}/grilling`,
      hash: 'h1',
      source_type: 'central-repo',
      discovered_at: '2026-01-01T00:00:00.000Z'
    })
    const codexSrc = mkSrc({
      id: 2,
      path: `${codexDir}/grilling`,
      hash: 'h1',
      source_origin: 'scan',
      source_tool: 'codex',
      mtime: 200,
      discovered_at: '2026-01-02T00:00:00.000Z'
    })
    const tools = [mkTool({ key: 'codex', paths: [codexDir], enabled: false })]
    expect(filterSourcesByEnabledTools([centralSrc, codexSrc], tools)).toEqual([centralSrc])
  })

  test('user-added local source (not under any tool path) kept even when all tools disabled', () => {
    // 用户通过"添加本地目录"登记的 indexed source,路径不在任何工具配置下
    const localPath = '/some/random/local/dir/grilling'
    const localSrc = mkSrc({ id: 1, path: localPath, hash: 'h1' })
    const tools = [
      mkTool({ key: 'codex', paths: ['/home/u/.codex/skills'], enabled: false })
    ]
    expect(filterSourcesByEnabledTools([localSrc], tools)).toEqual([localSrc])
  })

  test('user-added local source inside a disabled tool path remains visible', () => {
    const toolDir = '/home/u/.codex/skills'
    const localSrc = {
      ...mkSrc({ id: 1, path: `${toolDir}/manually-added`, hash: 'h1' }),
      source_origin: 'local',
      source_tool: null
    } as SkillSource & {
      source_origin: 'local'
      source_tool: null
    }
    const tools = [
      mkTool({ key: 'codex', paths: [toolDir], enabled: false })
    ]

    expect(filterSourcesByEnabledTools([localSrc], tools)).toEqual([localSrc])
  })

  test('re-enable tool restores source visibility (stateless: enabled=true keeps it)', () => {
    const toolDir = '/home/u/.codex/skills'
    const src = mkSrc({ id: 1, path: `${toolDir}/grilling`, hash: 'h1', source_origin: 'scan', source_tool: 'codex' })
    // 禁用时隐藏
    const disabled = [mkTool({ key: 'codex', paths: [toolDir], enabled: false })]
    expect(filterSourcesByEnabledTools([src], disabled)).toEqual([])
    // 重新启用后保留(函数无状态,DB 记录从未删除)
    const enabled = [mkTool({ key: 'codex', paths: [toolDir], enabled: true })]
    expect(filterSourcesByEnabledTools([src], enabled)).toEqual([src])
  })

  test('source under both enabled and disabled tool → kept (enabled wins)', () => {
    // 罕见但安全:source 路径同时在 enabled 和 disabled 工具路径下 → 保留
    const sharedDir = '/home/u/.codex/skills'
    const src = mkSrc({
      id: 1,
      path: `${sharedDir}/grilling`,
      hash: 'h1',
      source_origin: 'scan',
      source_tool: 'codex'
    })
    const tools = [
      mkTool({ key: 'codex', paths: [sharedDir], enabled: false }),
      mkTool({ key: 'custom', paths: [sharedDir], enabled: true, isCustom: true })
    ]
    expect(filterSourcesByEnabledTools([src], tools)).toEqual([src])
  })

  test('skill with all sources from disabled tools → empty (excluded from Skills page)', () => {
    const codexDir = '/home/u/.codex/skills'
    const agentsDir = '/home/u/.agents/skills'
    const codexSrc = mkSrc({ id: 1, path: `${codexDir}/only`, hash: 'h1', source_origin: 'scan', source_tool: 'codex' })
    const agentsSrc = mkSrc({ id: 2, path: `${agentsDir}/only`, hash: 'h1', source_origin: 'scan', source_tool: 'agents', mtime: 200 })
    const tools = [
      mkTool({ key: 'codex', paths: [codexDir], enabled: false }),
      mkTool({ key: 'agents', paths: [agentsDir], enabled: false })
    ]
    expect(filterSourcesByEnabledTools([codexSrc, agentsSrc], tools)).toEqual([])
  })

  test('no tool configs → indexed sources treated as user-added (kept)', () => {
    const src = mkSrc({ id: 1, path: '/anywhere/grilling', hash: 'h1' })
    expect(filterSourcesByEnabledTools([src], [])).toEqual([src])
  })

  test('multi-path tool (TRAE): source in one enabled path kept, disabled path hidden', () => {
    const traeCn = '/home/u/.trae-cn/skills'
    const traeIntl = '/home/u/.trae/skills'
    const srcCn = mkSrc({ id: 1, path: `${traeCn}/grilling`, hash: 'h1', source_origin: 'scan', source_tool: 'trae', discovered_at: '2026-01-01T00:00:00.000Z' })
    const srcIntl = mkSrc({ id: 2, path: `${traeIntl}/grilling`, hash: 'h1', source_origin: 'scan', source_tool: 'trae', mtime: 200, discovered_at: '2026-01-02T00:00:00.000Z' })
    // TRAE 是单工具多路径,禁用则两条路径的 source 都隐藏
    const tools = [mkTool({ key: 'trae', paths: [traeCn, traeIntl], enabled: false })]
    expect(filterSourcesByEnabledTools([srcCn, srcIntl], tools)).toEqual([])
  })

  test('filtering does not mutate input source array', () => {
    const toolDir = '/home/u/.codex/skills'
    const src = mkSrc({ id: 1, path: `${toolDir}/grilling`, hash: 'h1' })
    const input = [src]
    const tools = [mkTool({ key: 'codex', paths: [toolDir], enabled: false })]
    filterSourcesByEnabledTools(input, tools)
    expect(input).toEqual([src])
  })
})

describe('removeFromRegistry', () => {
  test('removes central-repo entity + all deployments + registry records, with backup', async () => {
    const central = createTempDir('ss-central-')
    const backups = createTempDir('ss-backups-')
    const target1 = createTempDir('ss-target1-')
    const target2 = createTempDir('ss-target2-')
    const { db, cleanup: cleanupDb } = createTempDb()

    // 中央仓库实体:{centralSkillsDir}/{name}/ 含 SKILL.md
    const skillName = 'grilling'
    const centralEntityPath = writeSkillDir(
      central.dir,
      skillName,
      '---\nname: grilling\n---\n# Grilling\n'
    )
    const skillId = upsertSkill(db, skillName, centralEntityPath)
    upsertSource(db, skillId, centralEntityPath, 'somehash', Date.now(), 'central-repo')

    // 部署到两个工具:copy + symlink
    const copyTargetDir = join(target1.dir, skillName)
    deploySkill(db, {
      skillId,
      skillName,
      targetTool: 'codex',
      mode: 'copy',
      sourcePath: centralEntityPath,
      targetDir: copyTargetDir,
      backupsDir: backups.dir,
      canSymlink: true,
      canJunction: false
    })
    const symlinkTargetDir = join(target2.dir, skillName)
    deploySkill(db, {
      skillId,
      skillName,
      targetTool: 'agents',
      mode: 'symlink',
      sourcePath: centralEntityPath,
      targetDir: symlinkTargetDir,
      backupsDir: backups.dir,
      canSymlink: true,
      canJunction: false
    })

    const beforeBackups = listBackups(backups.dir).length

    const result = await removeFromRegistry(db, skillId, {
      centralSkillsDir: central.dir,
      backupsDir: backups.dir,
      undeployDeployment: undeployForTest(db)
    })

    expect(result.skillName).toBe(skillName)
    expect(result.backedUp).toBe(true)
    expect([...result.undeployedTools].sort()).toEqual(['agents', 'codex'])

    // 中央实体目录已删
    expect(existsSync(centralEntityPath)).toBe(false)
    // 两个工具的目标目录都已清理(卸载)
    expect(existsSync(copyTargetDir)).toBe(false)
    expect(existsSync(symlinkTargetDir)).toBe(false)
    // 备份已创建(多了一份,skillName 匹配,targetTool=registry)
    const afterBackups = listBackups(backups.dir)
    expect(afterBackups.length).toBe(beforeBackups + 1)
    const registryBackup = afterBackups.find(
      (b) => b.skillName === skillName && b.targetTool === 'registry'
    )
    expect(registryBackup).toBeDefined()
    // skill 已从 DB 删除
    expect(getSkillById(db, skillId)).toBeUndefined()
    // skill_sources 已删
    expect(getSourcesBySkillId(db, skillId)).toHaveLength(0)
    // deployments 已删
    expect(getDeploymentsBySkillId(db, skillId)).toHaveLength(0)

    central.cleanup()
    backups.cleanup()
    target1.cleanup()
    target2.cleanup()
    cleanupDb()
  })

  test('indexed-only skill (no central entity) skips backup but still removes deployments + records', async () => {
    const central = createTempDir('ss-central-')
    const backups = createTempDir('ss-backups-')
    const source = createTempDir('ss-source-')
    const target = createTempDir('ss-target-')
    const { db, cleanup: cleanupDb } = createTempDb()

    // indexed-only:source 不在 centralSkillsDir 下,centralSkillsDir 不含 {name}/
    const skillName = 'indexed-skill'
    const sourcePath = writeSkillDir(
      source.dir,
      skillName,
      '---\nname: indexed-skill\n---\nbody\n'
    )
    const skillId = upsertSkill(db, skillName, sourcePath)
    upsertSource(db, skillId, sourcePath, 'somehash', Date.now(), 'indexed')

    // 部署到一个工具(copy)
    const targetDir = join(target.dir, skillName)
    deploySkill(db, {
      skillId,
      skillName,
      targetTool: 'codex',
      mode: 'copy',
      sourcePath,
      targetDir,
      backupsDir: backups.dir,
      canSymlink: true,
      canJunction: false
    })

    const beforeBackups = listBackups(backups.dir).length

    const result = await removeFromRegistry(db, skillId, {
      centralSkillsDir: central.dir,
      backupsDir: backups.dir,
      undeployDeployment: undeployForTest(db)
    })

    expect(result.skillName).toBe(skillName)
    expect(result.backedUp).toBe(true)
    expect(result.undeployedTools).toEqual(['codex'])
    // 无中央实体 → 备份 primary source(新版行为:Fix #5)
    expect(listBackups(backups.dir).length).toBe(beforeBackups + 1)
    // 部署已清理
    expect(existsSync(targetDir)).toBe(false)
    expect(getDeploymentsBySkillId(db, skillId)).toHaveLength(0)
    // skill + sources 已删
    expect(getSkillById(db, skillId)).toBeUndefined()
    expect(getSourcesBySkillId(db, skillId)).toHaveLength(0)

    central.cleanup()
    backups.cleanup()
    source.cleanup()
    target.cleanup()
    cleanupDb()
  })

  test('tool config unavailable still cleans the exact target_path stored in manifest', async () => {
    const central = createTempDir('ss-central-')
    const backups = createTempDir('ss-backups-')
    const target = createTempDir('ss-target-')
    const { db, cleanup: cleanupDb } = createTempDb()

    const skillName = 'grilling'
    const centralEntityPath = writeSkillDir(
      central.dir,
      skillName,
      '---\nname: grilling\n---\nbody\n'
    )
    const skillId = upsertSkill(db, skillName, centralEntityPath)
    upsertSource(db, skillId, centralEntityPath, 'somehash', Date.now(), 'central-repo')

    // 部署到 codex(copy 模式,目标为真实目录)
    const targetDir = join(target.dir, skillName)
    deploySkill(db, {
      skillId,
      skillName,
      targetTool: 'codex',
      mode: 'copy',
      sourcePath: centralEntityPath,
      targetDir,
      backupsDir: backups.dir,
      canSymlink: true,
      canJunction: false
    })
    expect(existsSync(targetDir)).toBe(true)

    // 当前工具配置不可用,仍应使用 manifest.target_path
    const result = await removeFromRegistry(db, skillId, {
      centralSkillsDir: central.dir,
      backupsDir: backups.dir,
      undeployDeployment: undeployForTest(db)
    })

    expect(result.undeployedTools).toEqual(['codex'])
    // 部署 DB 记录已删
    expect(getDeploymentsBySkillId(db, skillId)).toHaveLength(0)
    // skill 已删
    expect(getSkillById(db, skillId)).toBeUndefined()
    expect(existsSync(targetDir)).toBe(false)

    central.cleanup()
    backups.cleanup()
    target.cleanup()
    cleanupDb()
  })

  test('skill not found → throws', async () => {
    const central = createTempDir('ss-central-')
    const backups = createTempDir('ss-backups-')
    const { db, cleanup: cleanupDb } = createTempDb()

    await expect(
      removeFromRegistry(db, 99999, {
        centralSkillsDir: central.dir,
        backupsDir: backups.dir,
        undeployDeployment: undeployForTest(db)
      })
    ).rejects.toThrow(/skill not found/)

    central.cleanup()
    backups.cleanup()
    cleanupDb()
  })

  test('idempotent: calling again after removal throws (skill already deleted)', async () => {
    const central = createTempDir('ss-central-')
    const backups = createTempDir('ss-backups-')
    const { db, cleanup: cleanupDb } = createTempDb()

    const skillName = 'grilling'
    const centralEntityPath = writeSkillDir(
      central.dir,
      skillName,
      '---\nname: grilling\n---\nbody\n'
    )
    const skillId = upsertSkill(db, skillName, centralEntityPath)
    upsertSource(db, skillId, centralEntityPath, 'somehash', Date.now(), 'central-repo')

    const opts = {
      centralSkillsDir: central.dir,
      backupsDir: backups.dir,
      undeployDeployment: undeployForTest(db)
    }

    // 第一次调用成功
    await removeFromRegistry(db, skillId, opts)
    // 第二次调用抛错(skill 已删)
    await expect(removeFromRegistry(db, skillId, opts)).rejects.toThrow(/skill not found/)

    central.cleanup()
    backups.cleanup()
    cleanupDb()
  })
})
