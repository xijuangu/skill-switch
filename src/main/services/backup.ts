// backup 服务:skill 目录的备份 / 恢复 / 轮转(纯服务层,无 IPC / UI)
//
// 设计 = Option A:所有函数显式接收 backupsDir,便于测试用 temp fs 驱动,
// 不触碰真实 ~/.skill-switch。真实 BACKUPS_DIR 由 IPC 调用方注入(见 src/main/paths.ts)。
// backupId = dirName = 时间戳目录名(如 grilling_codex_20260701-120530-123),全局唯一标识一个备份。

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs'
import { basename, join } from 'path'
import { homedir } from 'os'
import { createHash } from 'crypto'

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

const DEFAULT_RETENTION = 20

/** 格式化时间戳:YYYYMMDD-HHmmss-SSS(可排序、文件系统安全) */
function formatTimestamp(date: Date): string {
  const pad = (n: number, len = 2): string => String(n).padStart(len, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}` +
    `-${pad(date.getMilliseconds(), 3)}`
  )
}

/** 递归算目录内容 hash(相对路径 + 文件内容,按路径排序)—— 与 scanner.ts 的 hashDir 一致 */
function hashDir(dir: string): string {
  const hash = createHash('sha256')
  const files: string[] = []
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile()) {
        files.push(full)
      }
    }
  }
  walk(dir)
  files.sort()
  for (const f of files) {
    hash.update(f.slice(dir.length))
    hash.update(readFileSync(f))
  }
  return hash.digest('hex')
}

/** 读取备份轮转上限:settings.json 的 backupRetention 字段,缺失/无效 → 20 */
export function getBackupRetention(settingsPath?: string): number {
  const p = settingsPath ?? join(homedir(), '.skill-switch', 'settings.json')
  try {
    if (!existsSync(p)) return DEFAULT_RETENTION
    const parsed: unknown = JSON.parse(readFileSync(p, 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_RETENTION
    const val = (parsed as Record<string, unknown>).backupRetention
    if (typeof val !== 'number' || !Number.isFinite(val)) return DEFAULT_RETENTION
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
  const { skillName, targetTool, sourcePath, backupsDir } = opts
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

  const backupDir = join(backupsDir, dirName)
  mkdirSync(backupDir, { recursive: true })
  cpSync(sourcePath, backupDir, { recursive: true, force: true })

  const sourceHash = hashDir(sourcePath)
  const meta: BackupMeta = {
    backupId: dirName,
    skillName,
    targetTool,
    sourcePath,
    sourceHash,
    backupTime: new Date().toISOString(),
    dirName
  }
  writeFileSync(join(backupsDir, `${dirName}.meta.json`), JSON.stringify(meta, null, 2))

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
        metas.push(JSON.parse(readFileSync(join(backupsDir, entry.name), 'utf-8')) as BackupMeta)
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
    rmSync(join(backupsDir, m.dirName), { recursive: true, force: true })
    rmSync(join(backupsDir, `${m.dirName}.meta.json`), { force: true })
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
  retention?: number
): void {
  const backupDir = join(backupsDir, backupId)
  if (!existsSync(backupDir)) {
    throw new Error(`backup not found: ${backupId}`)
  }

  if (existsSync(destPath)) {
    createBackup({
      skillName: 'restore-pre-restore',
      targetTool: basename(destPath),
      sourcePath: destPath,
      backupsDir,
      retention
    })
    rmSync(destPath, { recursive: true, force: true })
  }

  mkdirSync(destPath, { recursive: true })
  cpSync(backupDir, destPath, { recursive: true, force: true })
}

/** 删除指定备份(目录 + .meta.json)。幂等:不存在不报错。 */
export function deleteBackup(backupId: string, backupsDir: string): void {
  rmSync(join(backupsDir, backupId), { recursive: true, force: true })
  rmSync(join(backupsDir, `${backupId}.meta.json`), { force: true })
}
