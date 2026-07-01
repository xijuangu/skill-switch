import { test, expect, describe } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { createTempDir, createTempDb } from './helpers/temp'
import {
  deploySkill,
  undeploySkill,
  detectDrift,
  detectDriftsForTool,
  resolveActualMode
} from '../src/main/services/deployer'
import { upsertSkill } from '../src/main/db/dao/skills'
import { getDeploymentBySkillAndTool } from '../src/main/db/dao/deployments'
import { listBackups } from '../src/main/services/backup'

// helper:在 dir 下创建一个含 SKILL.md 的 skill 目录,返回其路径
function writeSkillDir(parent: string, name: string, content: string): string {
  const skillDir = join(parent, name)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), content)
  return skillDir
}

describe('deployer service', () => {
  describe('deploySkill — 基础部署', () => {
    test('copy 模式:递归复制源目录到目标,源文件不变', () => {
      const src = createTempDir('ss-src-')
      const target = createTempDir('ss-target-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()

      const skillDir = writeSkillDir(src.dir, 'grilling', '---\nname: grilling\n---\n# Grilling\n')
      const skillId = upsertSkill(db, 'grilling', skillDir)
      const targetDir = join(target.dir, 'grilling')

      const result = deploySkill(db, {
        skillId,
        skillName: 'grilling',
        targetTool: 'codex',
        mode: 'copy',
        sourcePath: skillDir,
        targetDir,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })

      expect(result.action).toBe('created')
      expect(result.mode).toBe('copy')
      expect(result.targetPath).toBe(targetDir)
      expect(result.sourceHashAtDeploy).toMatch(/^[0-9a-f]{64}$/)

      // 目标有 SKILL.md,内容一致
      expect(existsSync(join(targetDir, 'SKILL.md'))).toBe(true)
      expect(readFileSync(join(targetDir, 'SKILL.md'), 'utf-8')).toBe(
        '---\nname: grilling\n---\n# Grilling\n'
      )
      // 源目录没被动(内容还在)
      expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true)
      expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')).toBe(
        '---\nname: grilling\n---\n# Grilling\n'
      )

      src.cleanup()
      target.cleanup()
      backups.cleanup()
      cleanupDb()
    })

    test('symlink 模式:创建符号链接指向源,源更新自动生效', () => {
      const src = createTempDir('ss-src-')
      const target = createTempDir('ss-target-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()

      const skillDir = writeSkillDir(src.dir, 'grilling', '---\nname: grilling\n---\nv1\n')
      const skillId = upsertSkill(db, 'grilling', skillDir)
      const targetDir = join(target.dir, 'grilling')

      const result = deploySkill(db, {
        skillId,
        skillName: 'grilling',
        targetTool: 'codex',
        mode: 'symlink',
        sourcePath: skillDir,
        targetDir,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })

      expect(result.action).toBe('created')
      expect(result.mode).toBe('symlink')

      // targetDir 是符号链接,指向 skillDir
      expect(lstatSync(targetDir).isSymbolicLink()).toBe(true)
      expect(readlinkSync(targetDir)).toBe(skillDir)

      // 通过 target 读到源内容
      expect(readFileSync(join(targetDir, 'SKILL.md'), 'utf-8')).toBe(
        '---\nname: grilling\n---\nv1\n'
      )

      // 改源文件后,通过 target 能看到新内容(链接透明)
      writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: grilling\n---\nv2-updated\n')
      expect(readFileSync(join(targetDir, 'SKILL.md'), 'utf-8')).toBe(
        '---\nname: grilling\n---\nv2-updated\n'
      )

      src.cleanup()
      target.cleanup()
      backups.cleanup()
      cleanupDb()
    })

    test('部署后 deployments 表有一条记录(skill_id, target_tool, mode, source_path, source_hash_at_deploy)', () => {
      const src = createTempDir('ss-src-')
      const target = createTempDir('ss-target-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()

      const skillDir = writeSkillDir(src.dir, 'grilling', '---\nname: grilling\n---\nbody\n')
      const skillId = upsertSkill(db, 'grilling', skillDir)
      const targetDir = join(target.dir, 'grilling')

      deploySkill(db, {
        skillId,
        skillName: 'grilling',
        targetTool: 'codex',
        mode: 'copy',
        sourcePath: skillDir,
        targetDir,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })

      const dep = getDeploymentBySkillAndTool(db, skillId, 'codex')
      expect(dep).toBeDefined()
      expect(dep!.skill_id).toBe(skillId)
      expect(dep!.target_tool).toBe('codex')
      expect(dep!.mode).toBe('copy')
      expect(dep!.source_path).toBe(skillDir)
      expect(dep!.source_hash_at_deploy).toMatch(/^[0-9a-f]{64}$/)

      src.cleanup()
      target.cleanup()
      backups.cleanup()
      cleanupDb()
    })

    test('全新部署(无现有记录 + 目标不存在)→ action=created', () => {
      const src = createTempDir('ss-src-')
      const target = createTempDir('ss-target-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()

      const skillDir = writeSkillDir(src.dir, 'fresh', '---\nname: fresh\n---\n')
      const skillId = upsertSkill(db, 'fresh', skillDir)
      const targetDir = join(target.dir, 'fresh')

      const result = deploySkill(db, {
        skillId,
        skillName: 'fresh',
        targetTool: 'codex',
        mode: 'copy',
        sourcePath: skillDir,
        targetDir,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })

      expect(result.action).toBe('created')
      expect(existsSync(join(targetDir, 'SKILL.md'))).toBe(true)

      src.cleanup()
      target.cleanup()
      backups.cleanup()
      cleanupDb()
    })
  })

  describe('deploySkill — 自管更新', () => {
    test('自管覆盖(已有部署 + hash 变了)→ action=updated,目标内容更新', () => {
      const src = createTempDir('ss-src-')
      const target = createTempDir('ss-target-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()

      const skillDir = writeSkillDir(src.dir, 'grilling', '---\nname: grilling\n---\nv1\n')
      const skillId = upsertSkill(db, 'grilling', skillDir)
      const targetDir = join(target.dir, 'grilling')

      // 第一次部署
      deploySkill(db, {
        skillId,
        skillName: 'grilling',
        targetTool: 'codex',
        mode: 'copy',
        sourcePath: skillDir,
        targetDir,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })

      // 改源内容(hash 变了)
      writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: grilling\n---\nv2-new-content\n')

      // 第二次部署(同 mode,hash 变了)
      const result = deploySkill(db, {
        skillId,
        skillName: 'grilling',
        targetTool: 'codex',
        mode: 'copy',
        sourcePath: skillDir,
        targetDir,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })

      expect(result.action).toBe('updated')
      expect(result.mode).toBe('copy')
      // 目标内容已更新
      expect(readFileSync(join(targetDir, 'SKILL.md'), 'utf-8')).toBe(
        '---\nname: grilling\n---\nv2-new-content\n'
      )

      // DB 中的 hash 已更新
      const dep = getDeploymentBySkillAndTool(db, skillId, 'codex')
      expect(dep!.source_hash_at_deploy).toBe(result.sourceHashAtDeploy)

      src.cleanup()
      target.cleanup()
      backups.cleanup()
      cleanupDb()
    })

    test('自管幂等(已有部署 + hash 没变)→ action=skipped,不动文件不动 DB', () => {
      const src = createTempDir('ss-src-')
      const target = createTempDir('ss-target-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()

      const skillDir = writeSkillDir(src.dir, 'grilling', '---\nname: grilling\n---\nstable\n')
      const skillId = upsertSkill(db, 'grilling', skillDir)
      const targetDir = join(target.dir, 'grilling')

      // 第一次部署
      const first = deploySkill(db, {
        skillId,
        skillName: 'grilling',
        targetTool: 'codex',
        mode: 'copy',
        sourcePath: skillDir,
        targetDir,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })
      expect(first.action).toBe('created')

      // 记录第一次的 deployed_at(用于断言 DB 没被重写)
      const depBefore = getDeploymentBySkillAndTool(db, skillId, 'codex')!
      const deployedAtBefore = depBefore.deployed_at

      // 第二次部署(同 mode,同 hash → 幂等跳过)
      const result = deploySkill(db, {
        skillId,
        skillName: 'grilling',
        targetTool: 'codex',
        mode: 'copy',
        sourcePath: skillDir,
        targetDir,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })

      expect(result.action).toBe('skipped')
      // DB 没动(deployed_at 没变)
      const depAfter = getDeploymentBySkillAndTool(db, skillId, 'codex')!
      expect(depAfter.deployed_at).toBe(deployedAtBefore)
      // 文件没动
      expect(readFileSync(join(targetDir, 'SKILL.md'), 'utf-8')).toBe(
        '---\nname: grilling\n---\nstable\n'
      )

      src.cleanup()
      target.cleanup()
      backups.cleanup()
      cleanupDb()
    })
  })

  describe('deploySkill — 外部 skill 覆盖', () => {
    test('外部 skill(目标存在但清单无记录)→ action=external-overwritten,备份多一份,目标被覆盖', () => {
      const src = createTempDir('ss-src-')
      const target = createTempDir('ss-target-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()

      const skillDir = writeSkillDir(src.dir, 'grilling', '---\nname: grilling\n---\nour-content\n')
      const skillId = upsertSkill(db, 'grilling', skillDir)
      const targetDir = join(target.dir, 'grilling')

      // 预先在 targetDir 放外部 skill(模拟用户手动放的)
      mkdirSync(targetDir, { recursive: true })
      writeFileSync(join(targetDir, 'SKILL.md'), '---\nname: grilling\n---\nexternal-old\n')
      writeFileSync(join(targetDir, 'extra.txt'), 'external extra file\n')

      const beforeBackupCount = listBackups(backups.dir).length

      const result = deploySkill(db, {
        skillId,
        skillName: 'grilling',
        targetTool: 'codex',
        mode: 'copy',
        sourcePath: skillDir,
        targetDir,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })

      expect(result.action).toBe('external-overwritten')

      // 备份目录多了一份备份
      const afterBackupCount = listBackups(backups.dir).length
      expect(afterBackupCount).toBe(beforeBackupCount + 1)

      // 目标被覆盖为我们的内容
      expect(readFileSync(join(targetDir, 'SKILL.md'), 'utf-8')).toBe(
        '---\nname: grilling\n---\nour-content\n'
      )
      // 旧的 extra.txt 没了(整个目录被清理后重新拷贝)
      expect(existsSync(join(targetDir, 'extra.txt'))).toBe(false)

      // 备份里有旧内容
      const backup = listBackups(backups.dir)[0]
      expect(existsSync(join(backups.dir, backup.dirName, 'SKILL.md'))).toBe(true)
      expect(readFileSync(join(backups.dir, backup.dirName, 'SKILL.md'), 'utf-8')).toBe(
        '---\nname: grilling\n---\nexternal-old\n'
      )

      src.cleanup()
      target.cleanup()
      backups.cleanup()
      cleanupDb()
    })
  })

  describe('deploySkill — 模式切换', () => {
    test('模式切换 copy→symlink → action=mode-switched, previousMode=copy, 目标变成符号链接', () => {
      const src = createTempDir('ss-src-')
      const target = createTempDir('ss-target-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()

      const skillDir = writeSkillDir(src.dir, 'grilling', '---\nname: grilling\n---\nbody\n')
      const skillId = upsertSkill(db, 'grilling', skillDir)
      const targetDir = join(target.dir, 'grilling')

      // 先 copy 部署
      deploySkill(db, {
        skillId,
        skillName: 'grilling',
        targetTool: 'codex',
        mode: 'copy',
        sourcePath: skillDir,
        targetDir,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })
      expect(lstatSync(targetDir).isDirectory()).toBe(true)
      expect(lstatSync(targetDir).isSymbolicLink()).toBe(false)

      // 切换到 symlink
      const result = deploySkill(db, {
        skillId,
        skillName: 'grilling',
        targetTool: 'codex',
        mode: 'symlink',
        sourcePath: skillDir,
        targetDir,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })

      expect(result.action).toBe('mode-switched')
      expect(result.previousMode).toBe('copy')
      expect(result.mode).toBe('symlink')
      expect(lstatSync(targetDir).isSymbolicLink()).toBe(true)
      expect(readlinkSync(targetDir)).toBe(skillDir)

      src.cleanup()
      target.cleanup()
      backups.cleanup()
      cleanupDb()
    })

    test('模式切换 symlink→copy → action=mode-switched, previousMode=symlink, 目标变成真实目录', () => {
      const src = createTempDir('ss-src-')
      const target = createTempDir('ss-target-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()

      const skillDir = writeSkillDir(src.dir, 'grilling', '---\nname: grilling\n---\nbody\n')
      const skillId = upsertSkill(db, 'grilling', skillDir)
      const targetDir = join(target.dir, 'grilling')

      // 先 symlink 部署
      deploySkill(db, {
        skillId,
        skillName: 'grilling',
        targetTool: 'codex',
        mode: 'symlink',
        sourcePath: skillDir,
        targetDir,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })
      expect(lstatSync(targetDir).isSymbolicLink()).toBe(true)

      // 切换到 copy
      const result = deploySkill(db, {
        skillId,
        skillName: 'grilling',
        targetTool: 'codex',
        mode: 'copy',
        sourcePath: skillDir,
        targetDir,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })

      expect(result.action).toBe('mode-switched')
      expect(result.previousMode).toBe('symlink')
      expect(result.mode).toBe('copy')
      expect(lstatSync(targetDir).isDirectory()).toBe(true)
      expect(lstatSync(targetDir).isSymbolicLink()).toBe(false)
      // 内容正确
      expect(readFileSync(join(targetDir, 'SKILL.md'), 'utf-8')).toBe(
        '---\nname: grilling\n---\nbody\n'
      )

      src.cleanup()
      target.cleanup()
      backups.cleanup()
      cleanupDb()
    })
  })

  describe('deploySkill — symlink 清理安全', () => {
    test('unlink 旧 symlink 不会删除源目录(mode-switch symlink→copy 后源内容完好)', () => {
      const src = createTempDir('ss-src-')
      const target = createTempDir('ss-target-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()

      const skillDir = writeSkillDir(src.dir, 'grilling', '---\nname: grilling\n---\noriginal\n')
      // 加一个子目录 + 文件,确保递归内容都还在
      mkdirSync(join(skillDir, 'subdir'), { recursive: true })
      writeFileSync(join(skillDir, 'subdir', 'note.md'), 'sub-content\n')
      const skillId = upsertSkill(db, 'grilling', skillDir)
      const targetDir = join(target.dir, 'grilling')

      // symlink 部署:targetDir → skillDir
      deploySkill(db, {
        skillId,
        skillName: 'grilling',
        targetTool: 'codex',
        mode: 'symlink',
        sourcePath: skillDir,
        targetDir,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })

      // mode-switch 到 copy:清理旧 symlink 时必须 unlinkSync,不能 rmSync 跟随链接
      deploySkill(db, {
        skillId,
        skillName: 'grilling',
        targetTool: 'codex',
        mode: 'copy',
        sourcePath: skillDir,
        targetDir,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })

      // 关键安全断言:源目录内容完好无损
      expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true)
      expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')).toBe(
        '---\nname: grilling\n---\noriginal\n'
      )
      expect(existsSync(join(skillDir, 'subdir', 'note.md'))).toBe(true)
      expect(readFileSync(join(skillDir, 'subdir', 'note.md'), 'utf-8')).toBe('sub-content\n')

      // target 现在是真实目录(不再是 symlink)
      expect(lstatSync(targetDir).isSymbolicLink()).toBe(false)
      expect(lstatSync(targetDir).isDirectory()).toBe(true)

      src.cleanup()
      target.cleanup()
      backups.cleanup()
      cleanupDb()
    })
  })

  describe('detectDrift', () => {
    test('正常(copy + hash 一致)→ kind=normal', () => {
      const src = createTempDir('ss-src-')
      const target = createTempDir('ss-target-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()

      const skillDir = writeSkillDir(src.dir, 'grilling', '---\nname: grilling\n---\nstable\n')
      const skillId = upsertSkill(db, 'grilling', skillDir)
      const targetDir = join(target.dir, 'grilling')

      deploySkill(db, {
        skillId,
        skillName: 'grilling',
        targetTool: 'codex',
        mode: 'copy',
        sourcePath: skillDir,
        targetDir,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })

      const status = detectDrift(db, skillId, 'grilling', 'codex', targetDir)
      expect(status.kind).toBe('normal')
      expect(status.targetExists).toBe(true)
      expect(status.deployment).not.toBeNull()
      expect(status.currentSourceHash).toMatch(/^[0-9a-f]{64}$/)

      src.cleanup()
      target.cleanup()
      backups.cleanup()
      cleanupDb()
    })

    test('源已更新(copy + 源 hash 变了)→ kind=source-updated', () => {
      const src = createTempDir('ss-src-')
      const target = createTempDir('ss-target-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()

      const skillDir = writeSkillDir(src.dir, 'grilling', '---\nname: grilling\n---\nv1\n')
      const skillId = upsertSkill(db, 'grilling', skillDir)
      const targetDir = join(target.dir, 'grilling')

      deploySkill(db, {
        skillId,
        skillName: 'grilling',
        targetTool: 'codex',
        mode: 'copy',
        sourcePath: skillDir,
        targetDir,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })

      // 改源内容(hash 变了,但没重新部署)
      writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: grilling\n---\nv2-changed\n')

      const status = detectDrift(db, skillId, 'grilling', 'codex', targetDir)
      expect(status.kind).toBe('source-updated')
      expect(status.currentSourceHash).not.toBe(status.deployment!.source_hash_at_deploy)

      src.cleanup()
      target.cleanup()
      backups.cleanup()
      cleanupDb()
    })

    test('漂移(清单有 + 目录无)→ kind=drift', () => {
      const src = createTempDir('ss-src-')
      const target = createTempDir('ss-target-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()

      const skillDir = writeSkillDir(src.dir, 'grilling', '---\nname: grilling\n---\nbody\n')
      const skillId = upsertSkill(db, 'grilling', skillDir)
      const targetDir = join(target.dir, 'grilling')

      deploySkill(db, {
        skillId,
        skillName: 'grilling',
        targetTool: 'codex',
        mode: 'copy',
        sourcePath: skillDir,
        targetDir,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })

      // 用户手动删了 targetDir
      rmSync(targetDir, { recursive: true, force: true })

      const status = detectDrift(db, skillId, 'grilling', 'codex', targetDir)
      expect(status.kind).toBe('drift')
      expect(status.targetExists).toBe(false)
      expect(status.deployment).not.toBeNull()

      src.cleanup()
      target.cleanup()
      backups.cleanup()
      cleanupDb()
    })

    test('外部(清单无 + 目录有)→ kind=external', () => {
      const target = createTempDir('ss-target-')
      const { db, cleanup: cleanupDb } = createTempDb()

      const targetDir = join(target.dir, 'mystery-skill')
      mkdirSync(targetDir, { recursive: true })
      writeFileSync(join(targetDir, 'SKILL.md'), '---\nname: mystery\n---\nexternal\n')

      // 用一个不存在的 skillId(清单无记录)
      const status = detectDrift(db, 9999, 'mystery-skill', 'codex', targetDir)
      expect(status.kind).toBe('external')
      expect(status.targetExists).toBe(true)
      expect(status.deployment).toBeNull()
      expect(status.currentSourceHash).toBeNull()

      target.cleanup()
      cleanupDb()
    })
  })

  describe('undeploySkill', () => {
    test('正常卸载 copy 模式:删真实目录 + 清单记录移除', () => {
      const src = createTempDir('ss-src-')
      const target = createTempDir('ss-target-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()

      const skillDir = writeSkillDir(src.dir, 'grilling', '---\nname: grilling\n---\nbody\n')
      const skillId = upsertSkill(db, 'grilling', skillDir)
      const targetDir = join(target.dir, 'grilling')

      deploySkill(db, {
        skillId,
        skillName: 'grilling',
        targetTool: 'codex',
        mode: 'copy',
        sourcePath: skillDir,
        targetDir,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })
      expect(existsSync(targetDir)).toBe(true)

      undeploySkill(db, skillId, 'codex', targetDir)

      expect(existsSync(targetDir)).toBe(false)
      expect(getDeploymentBySkillAndTool(db, skillId, 'codex')).toBeUndefined()

      src.cleanup()
      target.cleanup()
      backups.cleanup()
      cleanupDb()
    })

    test('正常卸载 symlink 模式:删链接(不删源)+ 清单记录移除', () => {
      const src = createTempDir('ss-src-')
      const target = createTempDir('ss-target-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()

      const skillDir = writeSkillDir(src.dir, 'grilling', '---\nname: grilling\n---\nbody\n')
      const skillId = upsertSkill(db, 'grilling', skillDir)
      const targetDir = join(target.dir, 'grilling')

      deploySkill(db, {
        skillId,
        skillName: 'grilling',
        targetTool: 'codex',
        mode: 'symlink',
        sourcePath: skillDir,
        targetDir,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })

      undeploySkill(db, skillId, 'codex', targetDir)

      // 链接已删
      expect(existsSync(targetDir)).toBe(false)
      // 源目录还在(没被误删)
      expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true)
      // 清单记录已删
      expect(getDeploymentBySkillAndTool(db, skillId, 'codex')).toBeUndefined()

      src.cleanup()
      target.cleanup()
      backups.cleanup()
      cleanupDb()
    })

    test('外部 skill(清单无记录)→ throw,目标不删', () => {
      const target = createTempDir('ss-target-')
      const { db, cleanup: cleanupDb } = createTempDb()

      const targetDir = join(target.dir, 'mystery')
      mkdirSync(targetDir, { recursive: true })

      expect(() => undeploySkill(db, 9999, 'codex', targetDir)).toThrow(
        /not deployed by this tool/
      )

      // 目标没被删(因为不是我们管的)
      expect(existsSync(targetDir)).toBe(true)

      target.cleanup()
      cleanupDb()
    })
  })

  describe('detectDriftsForTool', () => {
    test('合并清单部署 + 外部目录,生成漂移列表', () => {
      const src = createTempDir('ss-src-')
      const toolSkills = createTempDir('ss-toolskills-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()

      // 部署一个自管 skill(copy 模式,normal)
      const skillDir1 = writeSkillDir(src.dir, 'managed', '---\nname: managed\n---\nbody\n')
      const skillId1 = upsertSkill(db, 'managed', skillDir1)
      deploySkill(db, {
        skillId: skillId1,
        skillName: 'managed',
        targetTool: 'codex',
        mode: 'copy',
        sourcePath: skillDir1,
        targetDir: join(toolSkills.dir, 'managed'),
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })

      // 在工具目录下放一个外部 skill(清单无记录)
      mkdirSync(join(toolSkills.dir, 'external-skill'), { recursive: true })
      writeFileSync(join(toolSkills.dir, 'external-skill', 'SKILL.md'), '---\nname: external\n---\n')

      const drifts = detectDriftsForTool(db, 'codex', toolSkills.dir)

      // 两条:一个 normal(自管),一个 external(外部)
      expect(drifts).toHaveLength(2)

      const managed = drifts.find((d) => d.skillName === 'managed')
      expect(managed).toBeDefined()
      expect(managed!.kind).toBe('normal')
      expect(managed!.deployment).not.toBeNull()

      const external = drifts.find((d) => d.skillName === 'external-skill')
      expect(external).toBeDefined()
      expect(external!.kind).toBe('external')
      expect(external!.deployment).toBeNull()

      src.cleanup()
      toolSkills.cleanup()
      backups.cleanup()
      cleanupDb()
    })
  })

  // ===== issue #9:junction fallback 服务层测试 =====
  describe('junction fallback (issue #9)', () => {
    describe('resolveActualMode (纯函数,覆盖所有分支)', () => {
      test('(a) canSymlink=true + 请求 symlink → symlink,无降级', () => {
        const r = resolveActualMode('symlink', true, false, true)
        expect(r.actualMode).toBe('symlink')
        expect(r.degradedFrom).toBeUndefined()
        expect(r.degradeReason).toBeUndefined()
      })

      test('(b) canSymlink=false + canJunction=true + isDir → junction,无降级(成功回退)', () => {
        const r = resolveActualMode('symlink', false, true, true)
        expect(r.actualMode).toBe('junction')
        expect(r.degradedFrom).toBeUndefined()
        expect(r.degradeReason).toBeUndefined()
      })

      test('(c) canSymlink=false + canJunction=true + !isDir → copy,从 symlink 降级', () => {
        const r = resolveActualMode('symlink', false, true, false)
        expect(r.actualMode).toBe('copy')
        expect(r.degradedFrom).toBe('symlink')
        expect(r.degradeReason).toBeTruthy()
      })

      test('(d) canSymlink=false + canJunction=false → copy,从 symlink 降级', () => {
        const r = resolveActualMode('symlink', false, false, true)
        expect(r.actualMode).toBe('copy')
        expect(r.degradedFrom).toBe('symlink')
        expect(r.degradeReason).toBeTruthy()
      })

      test('(e) 请求 copy → copy,无降级(与平台能力无关)', () => {
        const r = resolveActualMode('copy', false, false, true)
        expect(r.actualMode).toBe('copy')
        expect(r.degradedFrom).toBeUndefined()
        expect(r.degradeReason).toBeUndefined()
      })

      test('(f) 请求 junction → junction,无降级', () => {
        const r = resolveActualMode('junction', false, true, true)
        expect(r.actualMode).toBe('junction')
        expect(r.degradedFrom).toBeUndefined()
        expect(r.degradeReason).toBeUndefined()
      })
    })

    test('canSymlink=true (Mac) + 请求 symlink → 用 symlink,无降级', () => {
      const src = createTempDir('ss-src-')
      const target = createTempDir('ss-target-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()

      const skillDir = writeSkillDir(src.dir, 'grilling', '---\nname: grilling\n---\nv1\n')
      const skillId = upsertSkill(db, 'grilling', skillDir)
      const targetDir = join(target.dir, 'grilling')

      const result = deploySkill(db, {
        skillId,
        skillName: 'grilling',
        targetTool: 'codex',
        mode: 'symlink',
        sourcePath: skillDir,
        targetDir,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })

      expect(result.mode).toBe('symlink')
      expect(result.degradedFrom).toBeUndefined()
      expect(result.degradeReason).toBeUndefined()
      expect(lstatSync(targetDir).isSymbolicLink()).toBe(true)
      expect(getDeploymentBySkillAndTool(db, skillId, 'codex')!.mode).toBe('symlink')

      src.cleanup()
      target.cleanup()
      backups.cleanup()
      cleanupDb()
    })

    test('canSymlink=false + canJunction=true + source 是目录 → 用 junction,无降级', () => {
      const src = createTempDir('ss-src-')
      const target = createTempDir('ss-target-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()

      const skillDir = writeSkillDir(src.dir, 'grilling', '---\nname: grilling\n---\nbody\n')
      const skillId = upsertSkill(db, 'grilling', skillDir)
      const targetDir = join(target.dir, 'grilling')

      const result = deploySkill(db, {
        skillId,
        skillName: 'grilling',
        targetTool: 'codex',
        mode: 'symlink',
        sourcePath: skillDir,
        targetDir,
        backupsDir: backups.dir,
        canSymlink: false,
        canJunction: true
      })

      // junction 成功:不算降级(junction 是 symlink 不可用时的预期回退)
      expect(result.mode).toBe('junction')
      expect(result.degradedFrom).toBeUndefined()
      expect(result.degradeReason).toBeUndefined()
      // Mac 上 symlinkSync(...,'junction') 退化为普通 symlink
      expect(lstatSync(targetDir).isSymbolicLink()).toBe(true)
      expect(getDeploymentBySkillAndTool(db, skillId, 'codex')!.mode).toBe('junction')

      src.cleanup()
      target.cleanup()
      backups.cleanup()
      cleanupDb()
    })

    test('canSymlink=false + canJunction=true + source 是文件 → 降级 copy', () => {
      // skills 实际总是目录;此处用文件 source 覆盖 "source 不是目录 → 无法 junction → copy" 分支
      const src = createTempDir('ss-src-')
      const target = createTempDir('ss-target-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()

      const skillFile = join(src.dir, 'grilling.md')
      writeFileSync(skillFile, '---\nname: grilling\n---\nbody\n')
      const skillId = upsertSkill(db, 'grilling', skillFile)
      const targetDir = join(target.dir, 'grilling')

      const result = deploySkill(db, {
        skillId,
        skillName: 'grilling',
        targetTool: 'codex',
        mode: 'symlink',
        sourcePath: skillFile,
        targetDir,
        backupsDir: backups.dir,
        canSymlink: false,
        canJunction: true
      })

      // source 不是目录 → 无法 junction → 降级 copy
      expect(result.mode).toBe('copy')
      expect(result.degradedFrom).toBe('symlink')
      expect(result.degradeReason).toBeTruthy()
      expect(getDeploymentBySkillAndTool(db, skillId, 'codex')!.mode).toBe('copy')
      // target 是真实文件拷贝
      expect(existsSync(targetDir)).toBe(true)
      expect(readFileSync(targetDir, 'utf-8')).toBe('---\nname: grilling\n---\nbody\n')

      src.cleanup()
      target.cleanup()
      backups.cleanup()
      cleanupDb()
    })

    test('canSymlink=false + canJunction=false + 请求 symlink → 降级 copy', () => {
      const src = createTempDir('ss-src-')
      const target = createTempDir('ss-target-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()

      const skillDir = writeSkillDir(src.dir, 'grilling', '---\nname: grilling\n---\nbody\n')
      const skillId = upsertSkill(db, 'grilling', skillDir)
      const targetDir = join(target.dir, 'grilling')

      const result = deploySkill(db, {
        skillId,
        skillName: 'grilling',
        targetTool: 'codex',
        mode: 'symlink',
        sourcePath: skillDir,
        targetDir,
        backupsDir: backups.dir,
        canSymlink: false,
        canJunction: false
      })

      expect(result.mode).toBe('copy')
      expect(result.degradedFrom).toBe('symlink')
      expect(result.degradeReason).toBeTruthy()
      expect(getDeploymentBySkillAndTool(db, skillId, 'codex')!.mode).toBe('copy')
      // target 是真实目录拷贝
      expect(lstatSync(targetDir).isDirectory()).toBe(true)
      expect(readFileSync(join(targetDir, 'SKILL.md'), 'utf-8')).toBe(
        '---\nname: grilling\n---\nbody\n'
      )

      src.cleanup()
      target.cleanup()
      backups.cleanup()
      cleanupDb()
    })

    test('undeploy 遵循实际 mode(junction 记录 → 卸载时 unlink,不删源)', () => {
      const src = createTempDir('ss-src-')
      const target = createTempDir('ss-target-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()

      const skillDir = writeSkillDir(src.dir, 'grilling', '---\nname: grilling\n---\nbody\n')
      const skillId = upsertSkill(db, 'grilling', skillDir)
      const targetDir = join(target.dir, 'grilling')

      // 请求 symlink + Windows 能力 → 实际记录 junction
      deploySkill(db, {
        skillId,
        skillName: 'grilling',
        targetTool: 'codex',
        mode: 'symlink',
        sourcePath: skillDir,
        targetDir,
        backupsDir: backups.dir,
        canSymlink: false,
        canJunction: true
      })
      expect(getDeploymentBySkillAndTool(db, skillId, 'codex')!.mode).toBe('junction')

      undeploySkill(db, skillId, 'codex', targetDir)

      // 链接已删
      expect(existsSync(targetDir)).toBe(false)
      // 源目录完好(没被误删)
      expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true)
      // 清单记录已删
      expect(getDeploymentBySkillAndTool(db, skillId, 'codex')).toBeUndefined()

      src.cleanup()
      target.cleanup()
      backups.cleanup()
      cleanupDb()
    })
  })
})
