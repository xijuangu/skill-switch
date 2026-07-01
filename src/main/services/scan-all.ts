// scan-all 服务:对多个工具目录做一次性聚合扫描
//
// 复用 scanner.ts 的 scanToolDir(不重写扫描逻辑)。每个工具可能有多个路径
// (如 TRAE 的 domestic + international),逐路径扫描并聚合到结果列表。
// "并发"语义 = 一次 scanAllTools 调用覆盖所有 enabled + existing 目录
// (scanner 本身同步,这里用顺序循环保证确定性与幂等)。

import { existsSync } from 'fs'
import type { DB } from '../db/database'
import type { MultiScanResult, ToolScanResult } from '../types'
import { scanToolDir } from './scanner'
import type { ActiveScanDir } from './tools-config'

/**
 * 对多个工具目录做聚合扫描。
 * @param db 数据库连接
 * @param tools 待扫描工具列表(每个含 key / displayName / 已探测存在的 paths)
 * @returns 每个路径的扫描结果 + 总计
 */
export function scanAllTools(
  db: DB,
  tools: ActiveScanDir[]
): MultiScanResult {
  const results: ToolScanResult[] = []
  let totalScanned = 0
  let totalUpserted = 0

  for (const tool of tools) {
    for (const dir of tool.paths) {
      if (!existsSync(dir)) {
        results.push({
          key: tool.key,
          displayName: tool.displayName,
          path: dir,
          scanned: 0,
          upserted: 0
        })
        continue
      }
      const r = scanToolDir(db, dir)
      results.push({
        key: tool.key,
        displayName: tool.displayName,
        path: dir,
        scanned: r.scanned,
        upserted: r.upserted
      })
      totalScanned += r.scanned
      totalUpserted += r.upserted
    }
  }

  return {
    tools: results,
    totalScanned,
    totalUpserted
  }
}
