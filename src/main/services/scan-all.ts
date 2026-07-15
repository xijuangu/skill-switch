// scan-all 服务:对多个工具目录做一次性聚合扫描
//
// 复用 scanner.ts 的 scanToolDir(不重写扫描逻辑)。每个工具可能有多个路径
// (如 TRAE 的 domestic + international),逐路径扫描并聚合到结果列表。
// "并发"语义 = 一次 scanAllTools 调用覆盖所有 enabled + existing 目录
// (scanner 本身同步,这里用顺序循环保证确定性与幂等)。
//
// #1: 扫描后清理失效的 indexed source(路径已不在扫描列表里,如用户改了工具路径)。
// #3: 扫描时跳过 manifest 管理的全部 Deployment target,避免部署产物反向成为 Source。

import { existsSync } from 'fs'
import type { DB } from '../db/database'
import type { MultiScanResult, ToolScanResult } from '../types'
import { scanToolDir } from './scanner'
import type { ActiveScanDir } from './tools-config'
import {
  getAllDeployments,
  getDeploymentBySkillAndTargetId,
  upsertDeployment
} from '../db/dao/deployments'
import { getSourceByPath } from '../db/dao/skill-sources'
import { reconcileIndexedSources } from './registry'

/**
 * 构建本次扫描要跳过的 manifest-managed Deployment target 集合。
 * copy、symlink、junction 都是部署产物,不能反向登记为新的 Source；只有清单之外的
 * 外部目录或目录链接才属于发现结果。
 */
function buildSkipPaths(db: DB): Set<string> {
  const skip = new Set<string>()
  for (const dep of getAllDeployments(db)) {
    if (dep.management === 'managed' && dep.target_path) skip.add(dep.target_path)
  }
  return skip
}

/**
 * 对多个工具目录做聚合扫描。
 * @param db 数据库连接
 * @param tools 待扫描工具列表(每个含 key / displayName / 已探测存在的语义 targets)
 * @returns 每个路径的扫描结果 + 总计
 */
export function scanAllTools(
  db: DB,
  tools: ActiveScanDir[]
): MultiScanResult {
  const results: ToolScanResult[] = []
  let totalScanned = 0
  let totalUpserted = 0

  // #3: 扫描前构建所有 manifest-managed Deployment target 的 skipPaths
  const skipPaths = buildSkipPaths(db)
  // #1: 收集本次扫描实际 upsert 的 source 路径,用于清理失效 source
  const allScannedSourcePaths: string[] = []
  const successfullyScannedDirs: string[] = []

  for (const tool of tools) {
    const targets = tool.targets ?? tool.paths.map((path, index) => ({
      id: `legacy-scan:${tool.key}:${index}`,
      path
    }))
    for (const target of targets) {
      const dir = target.path
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
      const r = scanToolDir(db, dir, skipPaths, tool.key)
      for (const observation of r.observedSubscriptions) {
        const source = getSourceByPath(db, observation.sourcePath)
        if (!source) continue
        if (getDeploymentBySkillAndTargetId(db, source.skill_id, target.id)) continue
        upsertDeployment(
          db,
          source.skill_id,
          tool.key,
          observation.discoveryPath,
          'symlink',
          source.path,
          source.hash,
          { sourceId: source.id, targetId: target.id },
          'observed'
        )
      }
      successfullyScannedDirs.push(dir)
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
  reconcileIndexedSources(db, successfullyScannedDirs, allScannedSourcePaths)

  return {
    tools: results,
    totalScanned,
    totalUpserted
  }
}
