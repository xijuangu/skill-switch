// hash 工具:递归算目录内容 hash(相对路径 + 文件内容,按路径排序保证稳定)
//
// 抽取自 scanner.ts / backup.ts,deployer / installer 也需要算源目录 hash,
// 集中一处避免算法漂移。算法:sha256,遍历目录收集所有文件全路径,排序后
// 逐个 update(相对路径 + 文件内容或链接目标)。符号链接本身参与 hash,不跟随。

import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'

/**
 * 递归算目录内容 hash(相对路径 + 文件内容,按路径排序)。
 * 同内容 → 同 hash;内容变 → hash 变。与 scanner / backup 行为一致。
 *
 * 注:若传入的是单个文件(而非目录),直接 hash 文件内容(相对路径为空)。
 * skills 实际总是目录,此分支用于健壮性与 issue #9 junction 降级测试覆盖。
 */
export function hashDir(dir: string): string {
  const hash = createHash('sha256')
  const rootStat = lstatSync(dir)
  // 单文件:直接 hash 内容(相对路径为空)
  if (rootStat.isFile()) {
    hash.update(readFileSync(dir))
    return hash.digest('hex')
  }
  // 根本身是链接时也只记录链接,不跟随它进入目标目录。
  if (rootStat.isSymbolicLink()) {
    hash.update('\0symlink\0')
    hash.update(readlinkSync(dir))
    return hash.digest('hex')
  }
  const entries: Array<{ path: string; kind: 'file' | 'symlink' }> = []
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name)
      if (entry.isSymbolicLink()) {
        entries.push({ path: full, kind: 'symlink' })
      } else if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile()) {
        entries.push({ path: full, kind: 'file' })
      }
    }
  }
  walk(dir)
  // 保持原先 Array<string>.sort() 的 UTF-16 码元排序语义。
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  for (const entry of entries) {
    hash.update(entry.path.slice(dir.length))
    if (entry.kind === 'symlink') {
      hash.update('\0symlink\0')
      hash.update(readlinkSync(entry.path))
    } else {
      hash.update(readFileSync(entry.path))
    }
  }
  return hash.digest('hex')
}
