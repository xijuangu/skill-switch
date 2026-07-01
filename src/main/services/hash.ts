// hash 工具:递归算目录内容 hash(相对路径 + 文件内容,按路径排序保证稳定)
//
// 抽取自 scanner.ts / backup.ts,deployer / installer 也需要算源目录 hash,
// 集中一处避免算法漂移。算法:sha256,遍历目录收集所有文件全路径,排序后
// 逐个 update(相对路径 + 文件内容)。

import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'

/**
 * 递归算目录内容 hash(相对路径 + 文件内容,按路径排序)。
 * 同内容 → 同 hash;内容变 → hash 变。与 scanner / backup 行为一致。
 */
export function hashDir(dir: string): string {
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
