// scan-all 服务:对多个工具目录做一次性聚合扫描
//
// 复用 scanner.ts 的 scanToolDir(不重写扫描逻辑)。每个工具可能有多个路径
// (如 TRAE 的 domestic + international),逐路径扫描并聚合到结果列表。
// "并发"语义 = 一次 scanAllTools 调用覆盖所有 enabled + existing 目录
// (scanner 本身同步,这里用顺序循环保证确定性与幂等)。
//
// #1: 扫描后清理失效的 indexed source(路径已不在扫描列表里,如用户改了工具路径)。
// #3: 扫描时跳过 copy 部署的目标目录(副本不该被当成新 source 索引进来)。

import { existsSync } from 'fs'
import { join } from 'path'
import type { DB } from '../db/database'
import type { MultiScanResult, ToolScanResult } from '../types'
import { scanToolDir } from './scanner'
import type { ActiveScanDir } from './tools-config'
import { getDeploymentsByMode } from '../db/dao/deployments'
import { getSkillById } from '../db/dao/skills'
import { deleteStaleIndexedSources } from '../db/dao/skill-sources'

/**
 * 构建本次扫描要跳过的路径集合(copy 部署的目标目录)。
 * copy 副本不该被当成新 source 索引,否则 scan 后 source 会多出目标目录。
 * symlink/junction 部署不跳过(链接透明,扫描源目录等于扫描链接目标,不产生新 source)。
 */
function buildSkipPaths(db: DB, tools: ActiveScanDir[]): Set<string> {
  const skip = new Set<string>()
  const copyDeployments = getDeploymentsByMode(db, 'copy')
  for (const dep of copyDeployments) {
    const skill = getSkillById(db, dep.skill_id)
    if (!skill) continue
    // 找到该工具的扫描路径(target_tool 对应的 ActiveScanDir)
    const tool = tools.find((t) => t.key === dep.target_tool)
    if (!tool) continue
    // target_path = join(toolDir, skillName)
    for (const dir of tool.paths) {
      skip.add(join(dir, skill.name))
    }
  }
  return skip
}

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

  // #3: 扫描前构建 skipPaths(copy 部署的目标目录)
  const skipPaths = buildSkipPaths(db, tools)
  // #1: 收集本次扫描实际 upsert 的 source 路径,用于清理失效 source
  const allScannedSourcePaths: string[] = []

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
      const r = scanToolDir(db, dir, skipPaths)
      results.push({
        key: tool.key,
        displayName: tool.displayName,
        path: dir,
        scanned: r.scanned,
        upserted: r.upserted
      })
      totalScanned += r.scanned
      totalUpserted += r.upserted
      allScannedSourcePaths.push(...r.scannedPaths)
    }
  }

  // #1: 清理失效的 indexed source
  // 只删同时满足两个条件的 source:
  //   1. source_type='indexed'(central-repo 的不删)
  //   2. path 在本次扫描的某个工具目录下,但不在 allScannedSourcePaths 里
  //      (即该工具目录下已没有这个 skill,如用户改了路径或删了 skill)
  // 不碰不在本次扫描范围内的工具目录下的 source(如分次扫描不同工具)
  const scannedToolDirs = tools.flatMap((t) => t.paths)
  deleteStaleIndexedSources(db, scannedToolDirs, allScannedSourcePaths)

  return {
    tools: results,
    totalScanned,
    totalUpserted
  }
}
