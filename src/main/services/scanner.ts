// scanner 服务:扫描工具目录,登记 skill 到注册表
//
// 收集语义 = 索引(不搬文件),source_type = 'indexed'；目录链接仅用于发现,
// Source 始终登记为链接解析后的权威真实目录。
// 身份主键 = SKILL.md frontmatter 的 name;无 frontmatter 或无 name → 回退目录名。

import { readdirSync, readFileSync, existsSync, realpathSync, statSync, type Dirent } from 'fs'
import { join, basename } from 'path'
import matter from 'gray-matter'
import type { DB } from '../db/database'
import type { ScanResult } from '../types'
import { runInTransaction } from '../db/database'
import { upsertSkill } from '../db/dao/skills'
import { upsertSource } from '../db/dao/skill-sources'
import { normalizeIgnoredSourcePath } from '../db/dao/ignored-source-paths'
import { hashDir } from './hash'
import { validateSkillName } from './path-safety'

/** 从 SKILL.md frontmatter 解析 name;无则回退目录名 */
export function resolveSkillName(skillDir: string): string {
  const skillMdPath = join(skillDir, 'SKILL.md')
  if (existsSync(skillMdPath)) {
    const content = readFileSync(skillMdPath, 'utf-8')
    const parsed = matter(content)
    const name = parsed.data.name
    if (typeof name === 'string' && name.trim().length > 0) {
      return validateSkillName(name)
    }
  }
  return validateSkillName(basename(skillDir))
}

interface ScannableSkillDir {
  path: string
  linked: boolean
}

function resolveScannableSkillDir(parentDir: string, entry: Dirent): ScannableSkillDir | null {
  const entryPath = join(parentDir, entry.name)
  if (entry.isDirectory()) return { path: entryPath, linked: false }
  if (!entry.isSymbolicLink()) return null
  try {
    if (!statSync(entryPath).isDirectory()) return null
    return { path: realpathSync(entryPath), linked: true }
  } catch {
    // A broken or inaccessible link is not a scannable Skill Source.
    return null
  }
}

/**
 * 扫描工具目录,把每个真实子目录或外部目录链接的权威目标登记为 skill(索引模式,不搬文件)。
 * 重复扫描幂等:(skill_id, path) 唯一约束 + ON CONFLICT 更新 hash/mtime。
 *
 * @param skipPaths 要跳过的子目录绝对路径集合(如 manifest 管理的 Deployment target,
 *                  避免部署产物被当成新 source 索引进来)。默认空集合。
 * @param sourceTool 发现工具 key
 * @param ignoredPaths 忽略名单(realpath 归一):命中的来源目录不再登记,
 *                     与被移除 Skill 的确定性复活对应。默认空集合。
 */
export function scanToolDir(
  db: DB,
  toolDir: string,
  skipPaths: Set<string> = new Set(),
  sourceTool: string | null = null,
  ignoredPaths: Set<string> = new Set()
): ScanResult {
  const skillDirsByPath = new Map<string, { path: string; sourceTool: string | null }>()
  const observedSubscriptions: ScanResult['observedSubscriptions'] = []
  for (const entry of readdirSync(toolDir, { withFileTypes: true })) {
    const discoveryPath = join(toolDir, entry.name)
    // #3: 必须先按 Discovery Target 跳过受管部署,再解析外部链接的权威路径。
    if (skipPaths.has(discoveryPath)) continue
    const candidate = resolveScannableSkillDir(toolDir, entry)
    if (!candidate) continue
    // 忽略名单按 realpath 匹配:普通子目录在此处归一,目录链接已是 realpath。
    if (ignoredPaths.has(normalizeIgnoredSourcePath(candidate.path))) continue
    if (candidate.linked) {
      observedSubscriptions.push({
        discoveryPath,
        sourcePath: candidate.path
      })
    }

    const existing = skillDirsByPath.get(candidate.path)
    // 外部目录链接只负责发现,不成为 Source,也不把权威 Source 绑定到某个工具。
    // 若同一目录也以真实子目录出现,真实目录的 sourceTool 归属优先。
    if (!existing || (!candidate.linked && existing.sourceTool == null)) {
      skillDirsByPath.set(candidate.path, {
        path: candidate.path,
        sourceTool: candidate.linked ? null : sourceTool
      })
    }
  }
  const skillDirs = [...skillDirsByPath.values()]

  let upserted = 0
  const scannedPaths: string[] = []
  for (const { path: skillDir, sourceTool: discoveredByTool } of skillDirs) {
    const name = resolveSkillName(skillDir)
    const hash = hashDir(skillDir)
    const mtime = Math.floor(statSync(skillDir).mtimeMs)
    runInTransaction(db, () => {
      const skillId = upsertSkill(db, name, skillDir)
      upsertSource(
        db,
        skillId,
        skillDir,
        hash,
        mtime,
        'indexed',
        { origin: 'scan', tool: discoveredByTool }
      )
      upserted++
    })
    scannedPaths.push(skillDir)
  }

  return { scanned: skillDirs.length, upserted, scannedPaths, observedSubscriptions }
}
