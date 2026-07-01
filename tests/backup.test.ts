import { test, expect, describe } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createTempDir } from './helpers/temp'
import {
  createBackup,
  listBackups,
  pruneBackups,
  restoreBackup,
  deleteBackup,
  getBackupRetention,
  type BackupMeta
} from '../src/main/services/backup'

// helper:在 dir 下创建一个含 SKILL.md 的 skill 目录,返回其路径
function writeSkillDir(parent: string, name: string, content: string): string {
  const skillDir = join(parent, name)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), content)
  return skillDir
}

describe('backup service', () => {
  test('createBackup copies source dir contents into backupsDir and writes sidecar meta', () => {
    const src = createTempDir('ss-src-')
    const backups = createTempDir('ss-backups-')
    const skillDir = writeSkillDir(src.dir, 'grilling', '---\nname: grilling\n---\nbody v1\n')

    const meta = createBackup({
      skillName: 'grilling',
      targetTool: 'codex',
      sourcePath: skillDir,
      backupsDir: backups.dir,
      retention: 20
    })

    // backupId = skill_tool_时间戳(YYYYMMDD-HHmmss-SSS)
    expect(meta.backupId).toMatch(/^grilling_codex_\d{8}-\d{6}-\d{3}/)
    expect(meta.skillName).toBe('grilling')
    expect(meta.targetTool).toBe('codex')
    expect(meta.sourcePath).toBe(skillDir)
    expect(meta.dirName).toBe(meta.backupId)
    // backupTime 是合法 ISO
    expect(() => new Date(meta.backupTime).toISOString()).not.toThrow()

    // backup 目录存在,内含源文件(拷贝内容,不是嵌套原目录)
    const backupDir = join(backups.dir, meta.backupId)
    expect(existsSync(backupDir)).toBe(true)
    expect(existsSync(join(backupDir, 'SKILL.md'))).toBe(true)
    expect(readFileSync(join(backupDir, 'SKILL.md'), 'utf-8')).toBe('---\nname: grilling\n---\nbody v1\n')

    // sidecar .meta.json 在 backupsDir 根下(不在 backup 目录内)
    const metaPath = join(backups.dir, `${meta.backupId}.meta.json`)
    expect(existsSync(metaPath)).toBe(true)
    const onDisk = JSON.parse(readFileSync(metaPath, 'utf-8')) as BackupMeta
    expect(onDisk.backupId).toBe(meta.backupId)
    expect(onDisk.sourcePath).toBe(skillDir)
    expect(onDisk.sourceHash).toBe(meta.sourceHash)

    src.cleanup()
    backups.cleanup()
  })

  test('createBackup records a stable sourceHash: same content → same hash, changed content → different hash', () => {
    const a = createTempDir('ss-a-')
    const b = createTempDir('ss-b-')
    const backups = createTempDir('ss-backups-')
    const skillA = writeSkillDir(a.dir, 'grilling', '---\nname: grilling\n---\nbody\n')
    const skillB = writeSkillDir(b.dir, 'grilling', '---\nname: grilling\n---\nbody\n') // 同内容

    const m1 = createBackup({
      skillName: 'grilling', targetTool: 'codex', sourcePath: skillA, backupsDir: backups.dir, retention: 20
    })
    const m2 = createBackup({
      skillName: 'grilling', targetTool: 'codex', sourcePath: skillB, backupsDir: backups.dir, retention: 20
    })

    // sha256 hex = 64 字符
    expect(m1.sourceHash).toMatch(/^[0-9a-f]{64}$/)
    // 同内容 → 同 hash(独立源,算法应一致)
    expect(m2.sourceHash).toBe(m1.sourceHash)

    // 改内容后 hash 变化
    writeFileSync(join(skillA, 'SKILL.md'), '---\nname: grilling\n---\nchanged body\n')
    const m3 = createBackup({
      skillName: 'grilling', targetTool: 'codex', sourcePath: skillA, backupsDir: backups.dir, retention: 20
    })
    expect(m3.sourceHash).not.toBe(m1.sourceHash)

    a.cleanup()
    b.cleanup()
    backups.cleanup()
  })

  test('createBackup collision in same millisecond still yields unique backupIds', () => {
    const src = createTempDir('ss-src-')
    const backups = createTempDir('ss-backups-')
    const skillDir = writeSkillDir(src.dir, 'grilling', '---\nname: grilling\n---\nbody\n')

    const ids = new Set<string>()
    for (let i = 0; i < 5; i++) {
      const m = createBackup({
        skillName: 'grilling', targetTool: 'codex', sourcePath: skillDir, backupsDir: backups.dir, retention: 100
      })
      ids.add(m.backupId)
    }
    expect(ids.size).toBe(5)

    src.cleanup()
    backups.cleanup()
  })

  test('createBackup rotates when over retention count (oldest deleted first)', () => {
    const src = createTempDir('ss-src-')
    const backups = createTempDir('ss-backups-')
    const skillDir = writeSkillDir(src.dir, 'grilling', '---\nname: grilling\n---\nbody\n')

    // 创建 7 份,retention=5 → 仅留最新 5 份
    const created: BackupMeta[] = []
    for (let i = 0; i < 7; i++) {
      created.push(createBackup({
        skillName: 'grilling', targetTool: 'codex', sourcePath: skillDir, backupsDir: backups.dir, retention: 5
      }))
    }

    const remaining = listBackups(backups.dir)
    expect(remaining).toHaveLength(5)

    const remainingIds = new Set(remaining.map((m) => m.backupId))
    // 最旧两份被删
    expect(remainingIds.has(created[0].backupId)).toBe(false)
    expect(remainingIds.has(created[1].backupId)).toBe(false)
    // 最新 5 份保留
    for (let i = 2; i < 7; i++) {
      expect(remainingIds.has(created[i].backupId)).toBe(true)
    }

    src.cleanup()
    backups.cleanup()
  })

  test('pruneBackups deletes oldest until count <= retention and returns pruned count', () => {
    const src = createTempDir('ss-src-')
    const backups = createTempDir('ss-backups-')
    const skillDir = writeSkillDir(src.dir, 'grilling', '---\nname: grilling\n---\nbody\n')

    // 用大 retention 建出 6 份(不触发自动轮转)
    for (let i = 0; i < 6; i++) {
      createBackup({
        skillName: 'grilling', targetTool: 'codex', sourcePath: skillDir, backupsDir: backups.dir, retention: 100
      })
    }
    expect(listBackups(backups.dir)).toHaveLength(6)

    const pruned = pruneBackups(backups.dir, 2)
    expect(pruned).toBe(4)
    expect(listBackups(backups.dir)).toHaveLength(2)

    src.cleanup()
    backups.cleanup()
  })

  test('listBackups returns all metadata sorted by backupTime DESC (newest first)', () => {
    const src = createTempDir('ss-src-')
    const backups = createTempDir('ss-backups-')
    const skillDir = writeSkillDir(src.dir, 'grilling', '---\nname: grilling\n---\nbody\n')

    for (let i = 0; i < 3; i++) {
      createBackup({
        skillName: 'grilling', targetTool: 'codex', sourcePath: skillDir, backupsDir: backups.dir, retention: 100
      })
    }

    const list = listBackups(backups.dir)
    expect(list).toHaveLength(3)
    // 倒序:newest 在前
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1].backupTime >= list[i].backupTime).toBe(true)
    }
    // 每条都是完整 metadata
    for (const m of list) {
      expect(m.backupId).toBeTruthy()
      expect(m.skillName).toBe('grilling')
      expect(m.targetTool).toBe('codex')
      expect(m.sourcePath).toBe(skillDir)
      expect(m.sourceHash).toMatch(/^[0-9a-f]{64}$/)
      expect(m.dirName).toBe(m.backupId)
    }

    src.cleanup()
    backups.cleanup()
  })

  test('restoreBackup copies backup contents into a non-existent destPath', () => {
    const src = createTempDir('ss-src-')
    const backups = createTempDir('ss-backups-')
    const dest = createTempDir('ss-dest-')
    const skillDir = writeSkillDir(src.dir, 'grilling', '---\nname: grilling\n---\noriginal\n')

    const meta = createBackup({
      skillName: 'grilling', targetTool: 'codex', sourcePath: skillDir, backupsDir: backups.dir, retention: 100
    })

    const destPath = join(dest.dir, 'restored')
    restoreBackup(meta.backupId, destPath, backups.dir, 100)

    expect(existsSync(join(destPath, 'SKILL.md'))).toBe(true)
    expect(readFileSync(join(destPath, 'SKILL.md'), 'utf-8')).toBe('---\nname: grilling\n---\noriginal\n')

    src.cleanup()
    backups.cleanup()
    dest.cleanup()
  })

  test('restoreBackup creates a safety-net backup when destPath exists, then overwrites', () => {
    const src = createTempDir('ss-src-')
    const backups = createTempDir('ss-backups-')
    const dest = createTempDir('ss-dest-')
    const skillDir = writeSkillDir(src.dir, 'grilling', '---\nname: grilling\n---\nbackup-content\n')

    const meta = createBackup({
      skillName: 'grilling', targetTool: 'codex', sourcePath: skillDir, backupsDir: backups.dir, retention: 100
    })

    // dest 已存在且有旧内容
    const destPath = join(dest.dir, 'existing')
    mkdirSync(destPath, { recursive: true })
    writeFileSync(join(destPath, 'old.txt'), 'old content to be replaced\n')

    const beforeCount = listBackups(backups.dir).length
    restoreBackup(meta.backupId, destPath, backups.dir, 100)
    const afterCount = listBackups(backups.dir).length

    // safety-net 已创建(数量 +1)
    expect(afterCount).toBe(beforeCount + 1)
    const safetyNets = listBackups(backups.dir).filter((m) => m.skillName === 'restore-pre-restore')
    expect(safetyNets).toHaveLength(1)
    expect(safetyNets[0].sourcePath).toBe(destPath)

    // dest 现在是备份内容(旧文件被清掉)
    expect(existsSync(join(destPath, 'old.txt'))).toBe(false)
    expect(readFileSync(join(destPath, 'SKILL.md'), 'utf-8')).toBe('---\nname: grilling\n---\nbackup-content\n')

    src.cleanup()
    backups.cleanup()
    dest.cleanup()
  })

  test('deleteBackup removes backup dir and its .meta.json', () => {
    const src = createTempDir('ss-src-')
    const backups = createTempDir('ss-backups-')
    const skillDir = writeSkillDir(src.dir, 'grilling', '---\nname: grilling\n---\nbody\n')

    const meta = createBackup({
      skillName: 'grilling', targetTool: 'codex', sourcePath: skillDir, backupsDir: backups.dir, retention: 100
    })
    expect(existsSync(join(backups.dir, meta.backupId))).toBe(true)
    expect(existsSync(join(backups.dir, `${meta.backupId}.meta.json`))).toBe(true)

    deleteBackup(meta.backupId, backups.dir)
    expect(existsSync(join(backups.dir, meta.backupId))).toBe(false)
    expect(existsSync(join(backups.dir, `${meta.backupId}.meta.json`))).toBe(false)
    expect(listBackups(backups.dir).find((m) => m.backupId === meta.backupId)).toBeUndefined()

    src.cleanup()
    backups.cleanup()
  })

  test('deleteBackup is idempotent when backup is missing', () => {
    const backups = createTempDir('ss-backups-')
    expect(() => deleteBackup('nonexistent_20260701-120530-123', backups.dir)).not.toThrow()
    backups.cleanup()
  })

  test('getBackupRetention reads backupRetention from settings.json', () => {
    const settings = createTempDir('ss-settings-')
    const settingsPath = join(settings.dir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({ backupRetention: 7 }))
    expect(getBackupRetention(settingsPath)).toBe(7)
    settings.cleanup()
  })

  test('getBackupRetention defaults to 20 when settings missing, invalid, or field absent', () => {
    const settings = createTempDir('ss-settings-')
    const settingsPath = join(settings.dir, 'settings.json')

    // 文件不存在 → 20
    expect(getBackupRetention(settingsPath)).toBe(20)

    // JSON 无效 → 20
    writeFileSync(settingsPath, '{ not valid json')
    expect(getBackupRetention(settingsPath)).toBe(20)

    // 有 JSON 但无 backupRetention 字段 → 20
    writeFileSync(settingsPath, JSON.stringify({ other: 1 }))
    expect(getBackupRetention(settingsPath)).toBe(20)

    // backupRetention 非数字 → 20
    writeFileSync(settingsPath, JSON.stringify({ backupRetention: 'lots' }))
    expect(getBackupRetention(settingsPath)).toBe(20)

    settings.cleanup()
  })
})
