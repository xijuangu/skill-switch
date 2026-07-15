// backup 服务:skill 目录的备份 / 恢复 / 轮转(纯服务层,无 IPC / UI)
//
// 设计 = Option A:所有函数显式接收 backupsDir,便于测试用 temp fs 驱动,
// 不触碰真实 ~/.skill-switch。真实 BACKUPS_DIR 由 IPC 调用方注入(见 src/main/paths.ts)。
// backupId = dirName = 时间戳目录名(如 grilling_codex_20260701-120530-123),全局唯一标识一个备份。

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { basename, dirname, join } from 'path'
import { homedir } from 'os'
import { createHash } from 'crypto'
import { hashDir } from './hash'
import {
  assertAbsolutePath,
  resolveWithin,
  validateBackupId,
  validatePathSegment
} from './path-safety'

/** 备份元数据(同时落盘为 sidecar .meta.json) */
export interface BackupMeta {
  /** 备份 ID = 目录名(时间戳格式) */
  backupId: string
  skillName: string
  targetTool: string
  /** 原始源目录绝对路径 */
  sourcePath: string
  /** 源目录内容的 SHA-256(相对路径 + 文件内容,按路径排序) */
  sourceHash: string
  /** 备份时间(ISO 8601) */
  backupTime: string
  /** 备份目录名(= backupId) */
  dirName: string
  /** Exact link text when the backed-up entry was a dangling symbolic link. */
  danglingSymlinkTarget?: string
}

/** createBackup 入参(Option A:显式 backupsDir;retention 可选覆盖) */
export interface CreateBackupOptions {
  skillName: string
  targetTool: string
  sourcePath: string
  backupsDir: string
  /** 显式覆盖轮转上限;省略则读 ~/.skill-switch/settings.json 的 backupRetention */
  retention?: number
}

export interface RestoreBackupHooks {
  beforeDisplacedCleanup?: () => void
}

const DEFAULT_RETENTION = 20

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function validateBackupTime(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('backup time must be a string')
  }
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`invalid backup time: ${value}`)
  }
  return value
}

/** 格式化时间戳:YYYYMMDD-HHmmss-SSS(可排序、文件系统安全) */
function formatTimestamp(date: Date): string {
  const pad = (n: number, len = 2): string => String(n).padStart(len, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}` +
    `-${pad(date.getMilliseconds(), 3)}`
  )
}

/** 读取备份轮转上限:settings.json 的 backupRetention 字段,缺失/无效 → 20 */
export function getBackupRetention(settingsPath?: string): number {
  const p = settingsPath ?? join(homedir(), '.skill-switch', 'settings.json')
  try {
    if (!existsSync(p)) return DEFAULT_RETENTION
    const parsed: unknown = JSON.parse(readFileSync(p, 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_RETENTION
    const val = (parsed as Record<string, unknown>).backupRetention
    if (
      typeof val !== 'number' ||
      !Number.isSafeInteger(val) ||
      val < 1 ||
      val > 10_000
    ) {
      return DEFAULT_RETENTION
    }
    return val
  } catch {
    return DEFAULT_RETENTION
  }
}

/**
 * 创建一份备份:把 sourcePath 整目录内容拷到 backupsDir/{skill}_{tool}_{ts}/,
 * 写 sidecar .meta.json,然后按 retention 轮转删旧。返回新备份的 BackupMeta。
 */
export function createBackup(opts: CreateBackupOptions): BackupMeta {
  const skillName = validatePathSegment(opts.skillName, 'backup skill name')
  const targetTool = validatePathSegment(opts.targetTool, 'backup target tool')
  const sourcePath = assertAbsolutePath(opts.sourcePath, 'backup source path')
  const backupsDir = assertAbsolutePath(opts.backupsDir, 'backups directory')
  mkdirSync(backupsDir, { recursive: true })

  // 时间戳目录名;同毫秒冲突时追加 counter 保证唯一
  const ts = formatTimestamp(new Date())
  const base = `${skillName}_${targetTool}_${ts}`
  let dirName = base
  let counter = 1
  while (
    existsSync(join(backupsDir, dirName)) ||
    existsSync(join(backupsDir, `${dirName}.meta.json`))
  ) {
    dirName = `${base}-${counter}`
    counter++
  }

  const backupDir = resolveWithin(backupsDir, dirName)
  mkdirSync(backupDir, { recursive: true })
  const danglingSymlinkTarget =
    lstatSync(sourcePath).isSymbolicLink() && !existsSync(sourcePath)
      ? readlinkSync(sourcePath)
      : undefined
  if (danglingSymlinkTarget === undefined) {
    cpSync(sourcePath, backupDir, { recursive: true, force: true })
  }

  const sourceHash = danglingSymlinkTarget === undefined
    ? hashDir(sourcePath)
    : createHash('sha256').update(`dangling-symlink:${danglingSymlinkTarget}`).digest('hex')
  const meta: BackupMeta = {
    backupId: dirName,
    skillName,
    targetTool,
    sourcePath,
    sourceHash,
    backupTime: new Date().toISOString(),
    dirName,
    ...(danglingSymlinkTarget !== undefined ? { danglingSymlinkTarget } : {})
  }
  writeFileSync(
    resolveWithin(backupsDir, `${dirName}.meta.json`),
    JSON.stringify(meta, null, 2)
  )

  const retention = opts.retention ?? getBackupRetention()
  pruneBackups(backupsDir, retention)

  return meta
}

/** 读取所有 .meta.json,返回按 backupTime DESC 排序(newest first);同毫秒按 backupId 倒序 */
export function listBackups(backupsDir: string): BackupMeta[] {
  if (!existsSync(backupsDir)) return []
  const metas: BackupMeta[] = []
  for (const entry of readdirSync(backupsDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.meta.json')) {
      try {
        const parsed = JSON.parse(
          readFileSync(resolveWithin(backupsDir, entry.name), 'utf-8')
        ) as Partial<BackupMeta>
        const backupId = validateBackupId(parsed.backupId ?? '')
        const expectedMetaName = `${backupId}.meta.json`
        if (
          entry.name !== expectedMetaName ||
          parsed.dirName !== backupId ||
          !existsSync(resolveWithin(backupsDir, backupId))
        ) {
          continue
        }
        const danglingSymlinkTarget = parsed.danglingSymlinkTarget
        if (danglingSymlinkTarget !== undefined && typeof danglingSymlinkTarget !== 'string') {
          continue
        }
        metas.push({
          backupId,
          dirName: backupId,
          skillName: validatePathSegment(
            parsed.skillName ?? '',
            'backup skill name'
          ),
          targetTool: validatePathSegment(
            parsed.targetTool ?? '',
            'backup target tool'
          ),
          sourcePath: assertAbsolutePath(
            parsed.sourcePath ?? '',
            'backup source path'
          ),
          sourceHash: validatePathSegment(
            parsed.sourceHash ?? '',
            'backup source hash'
          ),
          backupTime: validateBackupTime(parsed.backupTime),
          ...(danglingSymlinkTarget !== undefined ? { danglingSymlinkTarget } : {})
        })
      } catch {
        // 损坏的 meta 跳过(不抛,保证列表稳定)
      }
    }
  }
  return metas.sort((a, b) => {
    if (a.backupTime !== b.backupTime) return a.backupTime < b.backupTime ? 1 : -1
    return a.backupId < b.backupId ? 1 : -1
  })
}

/**
 * 轮转:按 backupTime 升序(同毫秒按 backupId 升序)删最旧,
 * 直到总数 <= retentionCount。返回删除数量。
 */
export function pruneBackups(backupsDir: string, retentionCount: number): number {
  const total = listBackups(backupsDir)
  const asc = [...total].sort((a, b) => {
    if (a.backupTime !== b.backupTime) return a.backupTime < b.backupTime ? -1 : 1
    return a.backupId < b.backupId ? -1 : 1
  })
  let pruned = 0
  for (const m of asc) {
    if (total.length - pruned <= retentionCount) break
    rmSync(resolveWithin(backupsDir, m.dirName), {
      recursive: true,
      force: true
    })
    rmSync(resolveWithin(backupsDir, `${m.dirName}.meta.json`), { force: true })
    pruned++
  }
  return pruned
}

/**
 * 恢复:把 backupId 指向的备份内容拷到 destPath。
 * 若 destPath 已存在,先创建一份 safety-net 备份(名 restore-pre-restore_<destBasename>_<ts>),
 * 覆盖现有内容前留底;然后清空 destPath 再拷贝备份内容。
 */
export function restoreBackup(
  backupId: string,
  destPath: string,
  backupsDir: string,
  retention?: number,
  hooks?: RestoreBackupHooks
): void {
  const safeId = validateBackupId(backupId)
  const backupDir = resolveWithin(backupsDir, safeId)
  if (!existsSync(backupDir)) {
    throw new Error(`backup not found: ${backupId}`)
  }

  const destinationParent = dirname(destPath)
  mkdirSync(destinationParent, { recursive: true })
  const stagingRoot = mkdtempSync(
    join(destinationParent, '.skill-switch-restore-')
  )
  const stagedDestination = join(stagingRoot, 'restored')
  const displacedDestination = join(stagingRoot, 'previous')
  let displaced = false

  try {
    // Copy the restore source before retention or destination mutations.
    const meta = listBackups(backupsDir).find((candidate) => candidate.backupId === safeId)
    if (!meta) throw new Error(`backup metadata not found: ${backupId}`)
    if (meta.danglingSymlinkTarget !== undefined) {
      symlinkSync(meta.danglingSymlinkTarget, stagedDestination)
    } else {
      cpSync(backupDir, stagedDestination, { recursive: true, force: true })
    }

    if (pathEntryExists(destPath)) {
      createBackup({
        skillName: 'restore-pre-restore',
        targetTool: basename(destPath),
        sourcePath: destPath,
        backupsDir,
        // Defer pruning until the restored content is safely in place.
        retention: Number.MAX_SAFE_INTEGER
      })
      renameSync(destPath, displacedDestination)
      displaced = true
    }

    try {
      renameSync(stagedDestination, destPath)
    } catch (error) {
      if (displaced && !pathEntryExists(destPath)) {
        renameSync(displacedDestination, destPath)
        displaced = false
      }
      throw error
    }

    if (displaced) {
      hooks?.beforeDisplacedCleanup?.()
      rmSync(displacedDestination, { recursive: true, force: true })
      displaced = false
    }
    pruneBackups(backupsDir, retention ?? getBackupRetention())
  } finally {
    if (displaced && !pathEntryExists(destPath)) {
      renameSync(displacedDestination, destPath)
    }
    rmSync(stagingRoot, { recursive: true, force: true })
  }
}

/** 删除指定备份(目录 + .meta.json)。幂等:不存在不报错。 */
export function deleteBackup(backupId: string, backupsDir: string): void {
  const safeId = validateBackupId(backupId)
  rmSync(resolveWithin(backupsDir, safeId), { recursive: true, force: true })
  rmSync(resolveWithin(backupsDir, `${safeId}.meta.json`), { force: true })
}
