import { test, expect, describe } from 'vitest'
import { mkdirSync, realpathSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createTempDir, createTempDb } from './helpers/temp'
import {
  addIgnoredSourcePaths,
  getIgnoredSourcePaths,
  getIgnoredSourcePathSet,
  removeIgnoredSourcePath
} from '../src/main/db/dao/ignored-source-paths'
import { upsertSkill, getSkillByName } from '../src/main/db/dao/skills'
import { upsertSource } from '../src/main/db/dao/skill-sources'
import { removeFromRegistry } from '../src/main/services/registry'
import { scanAllTools } from '../src/main/services/scan-all'
import { registerSourceRoot, rescanSourceRoot } from '../src/main/services/source-roots'

// Ignored Source Path(忽略来源目录):按路径维系的扫描忽略名单。
// 从注册表移除 Skill 时登记其中央仓库外的来源路径,此后扫描发现环节
// 按 realpath 跳过;显式登记(upsertSource)自动解除——「已登记」与「被忽略」永不共存。

describe('ignored_source_paths DAO', () => {
  test('登记/查询/解除 回路,按 realpath 归一', () => {
    const { db, cleanup } = createTempDb()
    const root = createTempDir('ignored-paths-')
    const skillDir = join(root.dir, 'demo')
    mkdirSync(skillDir)
    try {
      addIgnoredSourcePaths(db, [{ path: skillDir, skillName: 'demo' }])

      // macOS 上 tmpdir 位于 /var(→ /private/var 符号链接),存储必须是 realpath
      const rows = getIgnoredSourcePaths(db)
      expect(rows).toHaveLength(1)
      expect(rows[0].path).toBe(realpathSync(skillDir))
      expect(rows[0].skill_name).toBe('demo')
      expect(rows[0].created_at).toBeTruthy()

      expect(getIgnoredSourcePathSet(db).has(realpathSync(skillDir))).toBe(true)

      // 重复登记幂等
      addIgnoredSourcePaths(db, [{ path: skillDir, skillName: 'demo' }])
      expect(getIgnoredSourcePaths(db)).toHaveLength(1)

      expect(removeIgnoredSourcePath(db, skillDir)).toBe(true)
      expect(getIgnoredSourcePaths(db)).toHaveLength(0)
      expect(removeIgnoredSourcePath(db, skillDir)).toBe(false)
    } finally {
      cleanup()
      root.cleanup()
    }
  })

  test('路径不存在时退化为 resolve 归一(已被删除的目录仍可登记/解除)', () => {
    const { db, cleanup } = createTempDb()
    const root = createTempDir('ignored-paths-gone-')
    const missing = join(root.dir, 'gone')
    try {
      addIgnoredSourcePaths(db, [{ path: missing, skillName: 'gone' }])
      expect(getIgnoredSourcePaths(db)).toHaveLength(1)
      expect(removeIgnoredSourcePath(db, missing)).toBe(true)
    } finally {
      cleanup()
      root.cleanup()
    }
  })

  test('显式登记(upsertSource)自动解除同路径忽略——已登记与被忽略不共存', () => {
    const { db, cleanup } = createTempDb()
    const root = createTempDir('ignored-paths-upsert-')
    const skillDir = join(root.dir, 'demo')
    mkdirSync(skillDir)
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: demo\n---\n')
    try {
      addIgnoredSourcePaths(db, [{ path: skillDir, skillName: 'demo' }])
      expect(getIgnoredSourcePaths(db)).toHaveLength(1)

      const skillId = upsertSkill(db, 'demo', skillDir)
      upsertSource(db, skillId, skillDir, 'hash-1', 1, 'indexed')

      expect(getIgnoredSourcePaths(db)).toHaveLength(0)
    } finally {
      cleanup()
      root.cleanup()
    }
  })
})

describe('removeFromRegistry 登记忽略路径', () => {
  function writeSkillDir(parent: string, name: string): string {
    const dir = join(parent, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n`)
    return dir
  }

  async function removeFixture(opts: { ignoreSourcePaths?: boolean }) {
    const central = createTempDir('ss-central-')
    const backups = createTempDir('ss-backups-')
    const external = createTempDir('ss-external-')
    const { db, cleanup: cleanupDb } = createTempDb()
    const canonicalDir = writeSkillDir(central.dir, 'demo')
    const indexedDir = writeSkillDir(external.dir, 'demo')
    const skillId = upsertSkill(db, 'demo', canonicalDir)
    upsertSource(db, skillId, canonicalDir, 'hash-c', Date.now(), 'central-repo', {
      role: 'canonical',
      origin: 'local'
    })
    upsertSource(db, skillId, indexedDir, 'hash-i', Date.now(), 'indexed', { origin: 'scan' })

    await removeFromRegistry(db, skillId, {
      centralSkillsDir: central.dir,
      backupsDir: backups.dir,
      ignoreSourcePaths: opts.ignoreSourcePaths,
      undeployDeployment: async () => ({ status: 'completed' as const }),
      preflightUndeploy: () => ({ status: 'ready' as const })
    })
    return { db, central, backups, external, cleanupDb, indexedDir }
  }

  test('ignoreSourcePaths=true:仅登记中央仓库外的来源路径', async () => {
    const { db, central, backups, external, cleanupDb, indexedDir } =
      await removeFixture({ ignoreSourcePaths: true })
    try {
      const rows = getIgnoredSourcePaths(db)
      expect(rows.map((row) => row.path)).toEqual([realpathSync(indexedDir)])
      expect(rows[0].skill_name).toBe('demo')
    } finally {
      cleanupDb()
      central.cleanup()
      backups.cleanup()
      external.cleanup()
    }
  })

  test('未传 ignoreSourcePaths:不登记任何忽略路径', async () => {
    const { db, central, backups, external, cleanupDb } = await removeFixture({})
    try {
      expect(getIgnoredSourcePaths(db)).toHaveLength(0)
    } finally {
      cleanupDb()
      central.cleanup()
      backups.cleanup()
      external.cleanup()
    }
  })
})


describe('扫描发现环节按忽略名单跳过', () => {
  function writeSkill(parent: string, name: string): string {
    const dir = join(parent, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n`)
    return dir
  }

  test('scanAllTools:被忽略的来源目录不再复活,未忽略的照常登记', () => {
    const { db, cleanup } = createTempDb()
    const tool = createTempDir('ignored-scan-tool-')
    const ignored = writeSkill(tool.dir, 'gone')
    const kept = writeSkill(tool.dir, 'stays')
    addIgnoredSourcePaths(db, [{ path: ignored, skillName: 'gone' }])
    try {
      const result = scanAllTools(db, [
        {
          key: 'agents',
          displayName: 'Agents',
          paths: [tool.dir],
          targets: [{ id: 'preset:agents:0', path: tool.dir }]
        }
      ])

      expect(getSkillByName(db, 'gone')).toBeUndefined()
      expect(getSkillByName(db, 'stays')).toBeTruthy()
      expect(result.totalUpserted).toBe(1)
      // 忽略条目未被扫描消费(只有显式登记才解除)
      expect(getIgnoredSourcePaths(db)).toHaveLength(1)
    } finally {
      cleanup()
      tool.cleanup()
    }
  })

  test('scanAllTools:忽略路径不会因 reconcile 被误清其它来源', () => {
    const { db, cleanup } = createTempDb()
    const tool = createTempDir('ignored-scan-reconcile-')
    const ignored = writeSkill(tool.dir, 'gone')
    addIgnoredSourcePaths(db, [{ path: ignored, skillName: 'gone' }])
    try {
      // 第一轮:两个 skill 都登记
      const kept = writeSkill(tool.dir, 'stays')
      scanAllTools(db, [{ key: 'agents', displayName: 'Agents', paths: [tool.dir], targets: [{ id: 'preset:agents:0', path: tool.dir }] }])
      expect(getSkillByName(db, 'stays')).toBeTruthy()
      // 第二轮:kept 仍在,ignored 被跳过且不产生任何行
      scanAllTools(db, [{ key: 'agents', displayName: 'Agents', paths: [tool.dir], targets: [{ id: 'preset:agents:0', path: tool.dir }] }])
      expect(getSkillByName(db, 'gone')).toBeUndefined()
      expect(getSkillByName(db, 'stays')).toBeTruthy()
    } finally {
      cleanup()
      tool.cleanup()
    }
  })

  test('rescanSourceRoot:Source Root 内被忽略的目录不登记', () => {
    const { db, cleanup } = createTempDb()
    const rootDir = createTempDir('ignored-root-')
    const ignored = writeSkill(rootDir.dir, 'gone')
    writeSkill(rootDir.dir, 'stays')
    addIgnoredSourcePaths(db, [{ path: ignored, skillName: 'gone' }])
    try {
      const root = registerSourceRoot(db, rootDir.dir)
      rescanSourceRoot(db, root.id)

      expect(getSkillByName(db, 'gone')).toBeUndefined()
      expect(getSkillByName(db, 'stays')).toBeTruthy()
      expect(getIgnoredSourcePaths(db)).toHaveLength(1)
    } finally {
      cleanup()
      rootDir.cleanup()
    }
  })
})
