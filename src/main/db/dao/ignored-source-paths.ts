// ignored_source_paths 表 DAO:扫描忽略名单(按路径,realpath 归一)
//
// 从注册表移除 Skill 时可登记其中央仓库外的来源路径;扫描发现环节据此跳过,
// 避免被移除的 Skill 确定性复活。显式登记(upsertSource)会删除同路径忽略行,
// 维持「已登记」与「被忽略」永不共存。

import { realpathSync } from 'fs'
import { resolve } from 'path'
import type { DB } from '../database'

export interface IgnoredSourcePath {
  path: string
  skill_name: string
  created_at: string
}

/**
 * 归一化忽略路径:存在的路径取 realpath(穿透 /var→/private/var 等符号链接),
 * 已不存在的路径退化为 resolve——移除后目录被用户手动删掉时仍能匹配解除。
 */
export function normalizeIgnoredSourcePath(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

/** 批量登记忽略路径;重复登记幂等(INSERT OR IGNORE)。 */
export function addIgnoredSourcePaths(
  db: DB,
  entries: Array<{ path: string; skillName: string }>
): void {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO ignored_source_paths (path, skill_name, created_at) VALUES (?, ?, ?)'
  )
  const createdAt = new Date().toISOString()
  for (const entry of entries) {
    insert.run(normalizeIgnoredSourcePath(entry.path), entry.skillName, createdAt)
  }
}

/** 解除一条忽略;返回是否有行被删除。 */
export function removeIgnoredSourcePath(db: DB, path: string): boolean {
  const result = db
    .prepare('DELETE FROM ignored_source_paths WHERE path = ?')
    .run(normalizeIgnoredSourcePath(path))
  return result.changes > 0
}

/** 全部忽略条目,按登记时间升序。 */
export function getIgnoredSourcePaths(db: DB): IgnoredSourcePath[] {
  return db
    .prepare('SELECT path, skill_name, created_at FROM ignored_source_paths ORDER BY created_at ASC')
    .all() as IgnoredSourcePath[]
}

/** 归一化路径集合,供扫描发现环节 O(1) 跳过。 */
export function getIgnoredSourcePathSet(db: DB): Set<string> {
  return new Set(getIgnoredSourcePaths(db).map((row) => row.path))
}
