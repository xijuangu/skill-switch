import { test, expect, describe } from 'vitest'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { createTempDir, createTempDb } from './helpers/temp'
import {
  deploySkill,
  undeploySkill,
  detectDrift,
  detectDriftsForTool,
  inspectDeployTarget,
  redeploySkill,
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
  test('deploy preflight distinguishes create, managed update, mode switch, and external overwrite', () => {
    const src = createTempDir('ss-src-')
    const target = createTempDir('ss-target-')
    const backups = createTempDir('ss-backups-')
    const { db, cleanup: cleanupDb } = createTempDb()
    const skillDir = writeSkillDir(src.dir, 'planned', 'source')
    const skillId = upsertSkill(db, 'planned', skillDir)
    const targetDir = join(target.dir, 'planned')

    expect(
      inspectDeployTarget(db, skillId, 'codex', targetDir, 'copy')
    ).toBe('created')

    mkdirSync(targetDir)
    expect(
      inspectDeployTarget(db, skillId, 'codex', targetDir, 'copy')
    ).toBe('external-overwrite')
    rmSync(targetDir, { recursive: true })

    deploySkill(db, {
      skillId,
      skillName: 'planned',
      targetTool: 'codex',
      mode: 'copy',
      sourcePath: skillDir,
      targetDir,
      backupsDir: backups.dir,
      canSymlink: true,
      canJunction: false
    })
    expect(
      inspectDeployTarget(db, skillId, 'codex', targetDir, 'copy')
    ).toBe('managed-update')
    expect(
      inspectDeployTarget(db, skillId, 'codex', targetDir, 'symlink')
    ).toBe('mode-switch')

    src.cleanup()
    target.cleanup()
    backups.cleanup()
    cleanupDb()
  })

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
      expect(dep!.target_path).toBe(targetDir)
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
    test('目标被删除后重新部署不会因 source hash 未变而跳过', () => {
      const src = createTempDir('ss-src-')
      const target = createTempDir('ss-target-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()
      const skillDir = writeSkillDir(src.dir, 'restore-me', 'same-content')
      const skillId = upsertSkill(db, 'restore-me', skillDir)
      const targetDir = join(target.dir, 'restore-me')
      const options = {
        skillId,
        skillName: 'restore-me',
        targetTool: 'codex',
        mode: 'copy' as const,
        sourcePath: skillDir,
        targetDir,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      }

      deploySkill(db, options)
      rmSync(targetDir, { recursive: true, force: true })
      const result = deploySkill(db, options)

      expect(result.action).toBe('updated')
      expect(readFileSync(join(targetDir, 'SKILL.md'), 'utf-8')).toBe(
        'same-content'
      )

      src.cleanup()
      target.cleanup()
      backups.cleanup()
      cleanupDb()
    })

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

      expect(() =>
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
      ).toThrow(/confirmation/)
      expect(listBackups(backups.dir)).toHaveLength(beforeBackupCount)
      expect(readFileSync(join(targetDir, 'extra.txt'), 'utf-8')).toBe(
        'external extra file\n'
      )

      const result = deploySkill(db, {
        skillId,
        skillName: 'grilling',
        targetTool: 'codex',
        mode: 'copy',
        sourcePath: skillDir,
        targetDir,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false,
        allowExternalOverwrite: true
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
    test('copy 目标内容被手工修改时标记 target-modified', () => {
      const src = createTempDir('ss-src-')
      const target = createTempDir('ss-target-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()
      const skillDir = writeSkillDir(src.dir, 'changed-target', 'source')
      const skillId = upsertSkill(db, 'changed-target', skillDir)
      const targetDir = join(target.dir, 'changed-target')

      deploySkill(db, {
        skillId,
        skillName: 'changed-target',
        targetTool: 'codex',
        mode: 'copy',
        sourcePath: skillDir,
        targetDir,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })
      writeFileSync(join(targetDir, 'SKILL.md'), 'tampered')

      expect(
        detectDrift(db, skillId, 'changed-target', 'codex', targetDir).kind
      ).toBe('target-modified')

      src.cleanup()
      target.cleanup()
      backups.cleanup()
      cleanupDb()
    })

    test('部署源被删除时标记 source-missing', () => {
      const src = createTempDir('ss-src-')
      const target = createTempDir('ss-target-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()
      const skillDir = writeSkillDir(src.dir, 'missing-source', 'source')
      const skillId = upsertSkill(db, 'missing-source', skillDir)
      const targetDir = join(target.dir, 'missing-source')
      deploySkill(db, {
        skillId,
        skillName: 'missing-source',
        targetTool: 'codex',
        mode: 'copy',
        sourcePath: skillDir,
        targetDir,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })

      rmSync(skillDir, { recursive: true, force: true })

      expect(
        detectDrift(db, skillId, 'missing-source', 'codex', targetDir).kind
      ).toBe('source-missing')

      src.cleanup()
      target.cleanup()
      backups.cleanup()
      cleanupDb()
    })

    test('symlink 被普通目录替换时标记 link-mismatch', () => {
      const src = createTempDir('ss-src-')
      const target = createTempDir('ss-target-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()
      const skillDir = writeSkillDir(src.dir, 'bad-link', 'source')
      const skillId = upsertSkill(db, 'bad-link', skillDir)
      const targetDir = join(target.dir, 'bad-link')
      deploySkill(db, {
        skillId,
        skillName: 'bad-link',
        targetTool: 'codex',
        mode: 'symlink',
        sourcePath: skillDir,
        targetDir,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })

      unlinkSync(targetDir)
      mkdirSync(targetDir)

      expect(
        detectDrift(db, skillId, 'bad-link', 'codex', targetDir).kind
      ).toBe('link-mismatch')

      const repaired = deploySkill(db, {
        skillId,
        skillName: 'bad-link',
        targetTool: 'codex',
        mode: 'symlink',
        sourcePath: skillDir,
        targetDir,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })

      expect(repaired.action).toBe('updated')
      expect(lstatSync(targetDir).isSymbolicLink()).toBe(true)
      expect(realpathSync(targetDir)).toBe(realpathSync(skillDir))
      expect(detectDrift(db, skillId, 'bad-link', 'codex', targetDir).kind).toBe(
        'normal'
      )

      src.cleanup()
      target.cleanup()
      backups.cleanup()
      cleanupDb()
    })

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

      undeploySkill(db, skillId, 'codex')

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

      undeploySkill(db, skillId, 'codex')

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

    test('工具配置路径变化后仍只删除清单记录的原 target_path', () => {
      const src = createTempDir('ss-src-')
      const oldTargetRoot = createTempDir('ss-old-target-')
      const newTargetRoot = createTempDir('ss-new-target-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()
      const skillDir = writeSkillDir(src.dir, 'safe', 'body')
      const skillId = upsertSkill(db, 'safe', skillDir)
      const originalTarget = join(oldTargetRoot.dir, 'safe')
      const unrelatedTarget = join(newTargetRoot.dir, 'safe')

      deploySkill(db, {
        skillId,
        skillName: 'safe',
        targetTool: 'codex',
        mode: 'copy',
        sourcePath: skillDir,
        targetDir: originalTarget,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })
      mkdirSync(unrelatedTarget)
      writeFileSync(join(unrelatedTarget, 'keep.txt'), 'external')

      undeploySkill(db, skillId, 'codex')

      expect(existsSync(originalTarget)).toBe(false)
      expect(readFileSync(join(unrelatedTarget, 'keep.txt'), 'utf-8')).toBe(
        'external'
      )

      src.cleanup()
      oldTargetRoot.cleanup()
      newTargetRoot.cleanup()
      backups.cleanup()
      cleanupDb()
    })

    test('外部 skill(清单无记录)→ throw,目标不删', () => {
      const target = createTempDir('ss-target-')
      const { db, cleanup: cleanupDb } = createTempDb()

      const targetDir = join(target.dir, 'mystery')
      mkdirSync(targetDir, { recursive: true })

      expect(() => undeploySkill(db, 9999, 'codex')).toThrow(
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

    test('canSymlink=false + canJunction=true + source 是文件 → 确认后降级 copy', () => {
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
        canJunction: true,
        approvedModeDegradation: {
          from: 'symlink', to: 'copy', reason: '用户已确认平台能力降级'
        }
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

    test('canSymlink=false + canJunction=false + 请求 symlink → 确认后降级 copy', () => {
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
        canJunction: false,
        approvedModeDegradation: {
          from: 'symlink', to: 'copy', reason: '用户已确认平台能力降级'
        }
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

      undeploySkill(db, skillId, 'codex')

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

  // ===== issue #24:自部署 / 父子目录重叠守卫(deployer service seam)=====
  // 验收:拒绝发生在任何备份、目标清理和 deployment 写入之前,FS 与 DB 完全不变。
  describe('issue #24 self-deploy guard', () => {
    test('source === target → throw,FS+DB 完全不变(无备份、无清单、源内容完好)', () => {
      const src = createTempDir('ss-src-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()

      const skillDir = writeSkillDir(src.dir, 'self', '---\nname: self\n---\noriginal\n')
      const skillId = upsertSkill(db, 'self', skillDir)
      const backupsBefore = listBackups(backups.dir).length

      expect(() =>
        deploySkill(db, {
          skillId,
          skillName: 'self',
          targetTool: 'codex',
          mode: 'copy',
          sourcePath: skillDir,
          targetDir: skillDir, // 自部署
          backupsDir: backups.dir,
          canSymlink: true,
          canJunction: false
        })
      ).toThrow(/own source path/)

      // 无新备份
      expect(listBackups(backups.dir)).toHaveLength(backupsBefore)
      // 无清单记录
      expect(getDeploymentBySkillAndTool(db, skillId, 'codex')).toBeUndefined()
      // 源内容完好(没被清理、没被覆盖)
      expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')).toBe(
        '---\nname: self\n---\noriginal\n'
      )

      src.cleanup()
      backups.cleanup()
      cleanupDb()
    })

    test('target inside source → throw,FS+DB 完全不变', () => {
      const src = createTempDir('ss-src-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()

      const skillDir = writeSkillDir(src.dir, 'parent', '---\nname: parent\n---\noriginal\n')
      const skillId = upsertSkill(db, 'parent', skillDir)
      const targetInside = join(skillDir, 'child') // 目标嵌在源里
      const backupsBefore = listBackups(backups.dir).length

      expect(() =>
        deploySkill(db, {
          skillId,
          skillName: 'parent',
          targetTool: 'codex',
          mode: 'copy',
          sourcePath: skillDir,
          targetDir: targetInside,
          backupsDir: backups.dir,
          canSymlink: true,
          canJunction: false
        })
      ).toThrow(/inside source/)

      expect(listBackups(backups.dir)).toHaveLength(backupsBefore)
      expect(getDeploymentBySkillAndTool(db, skillId, 'codex')).toBeUndefined()
      // 目标没被创建,源内容完好
      expect(existsSync(targetInside)).toBe(false)
      expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')).toBe(
        '---\nname: parent\n---\noriginal\n'
      )

      src.cleanup()
      backups.cleanup()
      cleanupDb()
    })

    test('source inside target → throw,FS+DB 完全不变(cleanup 会删源的隐患被拦截)', () => {
      const src = createTempDir('ss-src-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()

      // skillDir 是 targetRoot 的子目录:target = parent,source = parent/inner
      const targetRoot = src.dir
      const skillDir = writeSkillDir(src.dir, 'inner', '---\nname: inner\n---\noriginal\n')
      const skillId = upsertSkill(db, 'inner', skillDir)
      const backupsBefore = listBackups(backups.dir).length

      expect(() =>
        deploySkill(db, {
          skillId,
          skillName: 'inner',
          targetTool: 'codex',
          mode: 'copy',
          sourcePath: skillDir,
          targetDir: targetRoot, // source 在 target 内
          backupsDir: backups.dir,
          canSymlink: true,
          canJunction: false
        })
      ).toThrow(/inside target/)

      expect(listBackups(backups.dir)).toHaveLength(backupsBefore)
      expect(getDeploymentBySkillAndTool(db, skillId, 'codex')).toBeUndefined()
      // 源内容完好(target 没被清理,否则会递归删掉 skillDir)
      expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')).toBe(
        '---\nname: inner\n---\noriginal\n'
      )

      backups.cleanup()
      src.cleanup()
      cleanupDb()
    })

    test('symlink 别名指回 source → throw(等同自部署),FS+DB 完全不变', () => {
      const src = createTempDir('ss-src-')
      const alias = createTempDir('ss-alias-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()

      const skillDir = writeSkillDir(src.dir, 'aliased', '---\nname: aliased\n---\noriginal\n')
      const skillId = upsertSkill(db, 'aliased', skillDir)
      // 把 alias.dir 替换成指向 skillDir 的符号链接
      rmSync(alias.dir, { recursive: true, force: true })
      symlinkSync(skillDir, alias.dir)
      const backupsBefore = listBackups(backups.dir).length

      expect(() =>
        deploySkill(db, {
          skillId,
          skillName: 'aliased',
          targetTool: 'codex',
          mode: 'copy',
          sourcePath: skillDir,
          targetDir: alias.dir, // realpath 后等于 skillDir
          backupsDir: backups.dir,
          canSymlink: true,
          canJunction: false
        })
      ).toThrow(/own source path/)

      expect(listBackups(backups.dir)).toHaveLength(backupsBefore)
      expect(getDeploymentBySkillAndTool(db, skillId, 'codex')).toBeUndefined()
      expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')).toBe(
        '---\nname: aliased\n---\noriginal\n'
      )

      src.cleanup()
      alias.cleanup()
      backups.cleanup()
      cleanupDb()
    })

    test('合法部署(两个独立目录)不受守卫影响 → 正常 created', () => {
      const src = createTempDir('ss-src-')
      const target = createTempDir('ss-target-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()

      const skillDir = writeSkillDir(src.dir, 'legit', '---\nname: legit\n---\nbody\n')
      const skillId = upsertSkill(db, 'legit', skillDir)
      const targetDir = join(target.dir, 'legit')

      const result = deploySkill(db, {
        skillId,
        skillName: 'legit',
        targetTool: 'codex',
        mode: 'copy',
        sourcePath: skillDir,
        targetDir,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })

      expect(result.action).toBe('created')
      expect(getDeploymentBySkillAndTool(db, skillId, 'codex')).toBeDefined()
      expect(readFileSync(join(targetDir, 'SKILL.md'), 'utf-8')).toBe(
        '---\nname: legit\n---\nbody\n'
      )

      src.cleanup()
      target.cleanup()
      backups.cleanup()
      cleanupDb()
    })
  })

  // ===== issue #22:redeploy 使用清单记录的精确 target_path =====
  // 验收:不 re-derive、不信任 renderer 路径;source 缺失/失败不改清单;
  // 覆盖 TRAE 多路径、目标删除、配置 A→B、伪造路径、成功恢复。
  describe('issue #22 redeploy uses exact target_path from manifest', () => {
    test('TRAE 多路径:redeploy 重建到清单记录的 target_path,不碰其它配置路径', () => {
      const src = createTempDir('ss-src-')
      const pathA = createTempDir('ss-pathA-')
      const pathB = createTempDir('ss-pathB-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()

      const skillDir = writeSkillDir(src.dir, 'grilling', '---\nname: grilling\n---\nv1\n')
      const skillId = upsertSkill(db, 'grilling', skillDir)
      const targetA = join(pathA.dir, 'grilling')

      // 首次部署到 pathA(模拟 TRAE 多路径中的某一条)
      deploySkill(db, {
        skillId,
        skillName: 'grilling',
        targetTool: 'trae',
        mode: 'copy',
        sourcePath: skillDir,
        targetDir: targetA,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })
      // drift:用户手动删了 targetA
      rmSync(targetA, { recursive: true, force: true })
      // pathB 上有同名外部内容(模拟"新配置路径已有东西")
      mkdirSync(join(pathB.dir, 'grilling'), { recursive: true })
      writeFileSync(join(pathB.dir, 'grilling', 'SKILL.md'), 'should not be touched')

      // redeploy:不传任何路径,主进程从清单读 target_path
      const result = redeploySkill(db, skillId, 'trae', {
        skillName: 'grilling',
        mode: 'copy',
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })

      expect(result.targetPath).toBe(targetA)
      expect(existsSync(join(targetA, 'SKILL.md'))).toBe(true)
      // pathB 没被碰
      expect(readFileSync(join(pathB.dir, 'grilling', 'SKILL.md'), 'utf-8')).toBe(
        'should not be touched'
      )
      // 清单仍指向 pathA
      expect(getDeploymentBySkillAndTool(db, skillId, 'trae')!.target_path).toBe(targetA)

      src.cleanup()
      pathA.cleanup()
      pathB.cleanup()
      backups.cleanup()
      cleanupDb()
    })

    test('renderer 无法伪造路径:redeploySkill 签名不接收路径,只认清单', () => {
      const src = createTempDir('ss-src-')
      const pathA = createTempDir('ss-pathA-')
      const decoy = createTempDir('ss-decoy-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()

      const skillDir = writeSkillDir(src.dir, 'forge', 'body')
      const skillId = upsertSkill(db, 'forge', skillDir)
      const targetA = join(pathA.dir, 'forge')
      deploySkill(db, {
        skillId,
        skillName: 'forge',
        targetTool: 'trae',
        mode: 'copy',
        sourcePath: skillDir,
        targetDir: targetA,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })
      rmSync(targetA, { recursive: true, force: true })

      // redeploy 不接受任何路径参数 — decoy 永远不会被触及
      const result = redeploySkill(db, skillId, 'trae', {
        skillName: 'forge',
        mode: 'copy',
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })
      expect(result.targetPath).toBe(targetA)
      expect(existsSync(join(decoy.dir, 'forge'))).toBe(false)

      src.cleanup()
      pathA.cleanup()
      decoy.cleanup()
      backups.cleanup()
      cleanupDb()
    })

    test('目标手动删除后 redeploy → 在原 target_path 重建(copy)', () => {
      const src = createTempDir('ss-src-')
      const pathA = createTempDir('ss-pathA-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()
      const skillDir = writeSkillDir(src.dir, 'gone', '---\nname: gone\n---\nbody\n')
      const skillId = upsertSkill(db, 'gone', skillDir)
      const targetA = join(pathA.dir, 'gone')
      deploySkill(db, {
        skillId,
        skillName: 'gone',
        targetTool: 'trae',
        mode: 'copy',
        sourcePath: skillDir,
        targetDir: targetA,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })
      rmSync(targetA, { recursive: true, force: true })
      expect(existsSync(targetA)).toBe(false)

      const result = redeploySkill(db, skillId, 'trae', {
        skillName: 'gone',
        mode: 'copy',
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })
      expect(result.action).toBe('updated')
      expect(existsSync(join(targetA, 'SKILL.md'))).toBe(true)
      expect(readFileSync(join(targetA, 'SKILL.md'), 'utf-8')).toBe(
        '---\nname: gone\n---\nbody\n'
      )

      src.cleanup()
      pathA.cleanup()
      backups.cleanup()
      cleanupDb()
    })

    test('同 hash 同 mode → action=skipped(幂等,不动 FS 不动 DB)', () => {
      const src = createTempDir('ss-src-')
      const pathA = createTempDir('ss-pathA-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()
      const skillDir = writeSkillDir(src.dir, 'stable', 'stable-content')
      const skillId = upsertSkill(db, 'stable', skillDir)
      const targetA = join(pathA.dir, 'stable')
      deploySkill(db, {
        skillId,
        skillName: 'stable',
        targetTool: 'trae',
        mode: 'copy',
        sourcePath: skillDir,
        targetDir: targetA,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })
      const deployedAtBefore = getDeploymentBySkillAndTool(db, skillId, 'trae')!.deployed_at

      const result = redeploySkill(db, skillId, 'trae', {
        skillName: 'stable',
        mode: 'copy',
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })
      expect(result.action).toBe('skipped')
      expect(getDeploymentBySkillAndTool(db, skillId, 'trae')!.deployed_at).toBe(deployedAtBefore)

      src.cleanup()
      pathA.cleanup()
      backups.cleanup()
      cleanupDb()
    })

    test('源已更新 → action=updated,目标内容更新到新源', () => {
      const src = createTempDir('ss-src-')
      const pathA = createTempDir('ss-pathA-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()
      const skillDir = writeSkillDir(src.dir, 'grilling', 'v1')
      const skillId = upsertSkill(db, 'grilling', skillDir)
      const targetA = join(pathA.dir, 'grilling')
      deploySkill(db, {
        skillId,
        skillName: 'grilling',
        targetTool: 'trae',
        mode: 'copy',
        sourcePath: skillDir,
        targetDir: targetA,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })
      writeFileSync(join(skillDir, 'SKILL.md'), 'v2-updated')

      const result = redeploySkill(db, skillId, 'trae', {
        skillName: 'grilling',
        mode: 'copy',
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })
      expect(result.action).toBe('updated')
      expect(readFileSync(join(targetA, 'SKILL.md'), 'utf-8')).toBe('v2-updated')

      src.cleanup()
      pathA.cleanup()
      backups.cleanup()
      cleanupDb()
    })

    test('redeploy 可切换 mode(symlink→copy)在原 target_path', () => {
      const src = createTempDir('ss-src-')
      const pathA = createTempDir('ss-pathA-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()
      const skillDir = writeSkillDir(src.dir, 'grilling', 'body')
      const skillId = upsertSkill(db, 'grilling', skillDir)
      const targetA = join(pathA.dir, 'grilling')
      deploySkill(db, {
        skillId,
        skillName: 'grilling',
        targetTool: 'trae',
        mode: 'symlink',
        sourcePath: skillDir,
        targetDir: targetA,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })
      expect(lstatSync(targetA).isSymbolicLink()).toBe(true)

      const result = redeploySkill(db, skillId, 'trae', {
        skillName: 'grilling',
        mode: 'copy',
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })
      expect(result.action).toBe('mode-switched')
      expect(result.mode).toBe('copy')
      expect(lstatSync(targetA).isSymbolicLink()).toBe(false)
      expect(readFileSync(join(targetA, 'SKILL.md'), 'utf-8')).toBe('body')

      src.cleanup()
      pathA.cleanup()
      backups.cleanup()
      cleanupDb()
    })

    test('无部署记录 → throw,不退化为 fresh deploy,FS+DB 不变', () => {
      const src = createTempDir('ss-src-')
      const pathA = createTempDir('ss-pathA-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()
      const skillDir = writeSkillDir(src.dir, 'never', 'body')
      const skillId = upsertSkill(db, 'never', skillDir)

      expect(() =>
        redeploySkill(db, skillId, 'trae', {
          skillName: 'never',
          mode: 'copy',
          backupsDir: backups.dir,
          canSymlink: true,
          canJunction: false
        })
      ).toThrow(/no deployment record/)

      expect(getDeploymentBySkillAndTool(db, skillId, 'trae')).toBeUndefined()
      // pathA 下什么都没创建
      expect(existsSync(join(pathA.dir, 'never'))).toBe(false)

      src.cleanup()
      pathA.cleanup()
      backups.cleanup()
      cleanupDb()
    })

    test('源缺失 → throw,deployment 清单不变(hashDir 抛错在 upsert 之前)', () => {
      const src = createTempDir('ss-src-')
      const pathA = createTempDir('ss-pathA-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()
      const skillDir = writeSkillDir(src.dir, 'gone-src', 'body')
      const skillId = upsertSkill(db, 'gone-src', skillDir)
      const targetA = join(pathA.dir, 'gone-src')
      deploySkill(db, {
        skillId,
        skillName: 'gone-src',
        targetTool: 'trae',
        mode: 'copy',
        sourcePath: skillDir,
        targetDir: targetA,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })
      const depBefore = getDeploymentBySkillAndTool(db, skillId, 'trae')!
      // 删源
      rmSync(skillDir, { recursive: true, force: true })

      expect(() =>
        redeploySkill(db, skillId, 'trae', {
          skillName: 'gone-src',
          mode: 'copy',
          backupsDir: backups.dir,
          canSymlink: true,
          canJunction: false
        })
      ).toThrow()

      // 清单未改
      const depAfter = getDeploymentBySkillAndTool(db, skillId, 'trae')!
      expect(depAfter.deployed_at).toBe(depBefore.deployed_at)
      expect(depAfter.source_hash_at_deploy).toBe(depBefore.source_hash_at_deploy)

      src.cleanup()
      pathA.cleanup()
      backups.cleanup()
      cleanupDb()
    })

    test('目标父目录不可写 → throw,deployment 清单不变(deployFiles 在 upsert 之前抛错)', () => {
      // issue #22 验收:source 缺失、目标父目录不可写等失败不修改 deployment 清单
      const src = createTempDir('ss-src-')
      const pathA = createTempDir('ss-pathA-')
      const backups = createTempDir('ss-backups-')
      const { db, cleanup: cleanupDb } = createTempDb()
      const skillDir = writeSkillDir(src.dir, 'locked-parent', 'body')
      const skillId = upsertSkill(db, 'locked-parent', skillDir)
      const targetA = join(pathA.dir, 'locked-parent')
      // 首次部署成功(此时 targetA 不存在,pathA 可写)
      deploySkill(db, {
        skillId,
        skillName: 'locked-parent',
        targetTool: 'trae',
        mode: 'copy',
        sourcePath: skillDir,
        targetDir: targetA,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })
      const depBefore = getDeploymentBySkillAndTool(db, skillId, 'trae')!
      // 删 target 模拟 drift,然后锁死父目录 pathA 使其不可写
      rmSync(targetA, { recursive: true, force: true })
      chmodSync(pathA.dir, 0o555) // r-xr-xr-x:不可写,无法在其中创建子目录

      try {
        expect(() =>
          redeploySkill(db, skillId, 'trae', {
            skillName: 'locked-parent',
            mode: 'copy',
            backupsDir: backups.dir,
            canSymlink: true,
            canJunction: false
          })
        ).toThrow()

        // 清单未改:deployFiles 抛错在 upsertDeployment 之前
        const depAfter = getDeploymentBySkillAndTool(db, skillId, 'trae')!
        expect(depAfter.deployed_at).toBe(depBefore.deployed_at)
        expect(depAfter.source_hash_at_deploy).toBe(depBefore.source_hash_at_deploy)
      } finally {
        // 恢复可写以便 cleanup 删除目录
        chmodSync(pathA.dir, 0o755)
      }

      src.cleanup()
      pathA.cleanup()
      backups.cleanup()
      cleanupDb()
    })
  })
})
