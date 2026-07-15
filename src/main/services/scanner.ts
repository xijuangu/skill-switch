// scanner 服务:扫描工具目录,登记 skill 到注册表
//
// 收集语义 = 索引(不搬文件),source_type = 'indexed'。
// 身份主键 = SKILL.md frontmatter 的 name;无 frontmatter 或无 name → 回退目录名。

import { readdirSync, readFileSync, existsSync, statSync, type Dirent } from 'fs'
import { join, basename } from 'path'
import matter from 'gray-matter'
import type { DB } from '../db/database'
import type { ScanResult } from '../types'
import { runInTransaction } from '../db/database'
import { upsertSkill } from '../db/dao/skills'
import { upsertSource } from '../db/dao/skill-sources'
import { hashDir } from './hash'
import { validateSkillName } from './path-safety'

/** 从 SKILL.md frontmatter 解析 name;无则回退目录名 */
function resolveSkillName(skillDir: string): string {
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

function isScannableDirectoryEntry(parentDir: string, entry: Dirent): boolean {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false
  try {
    return statSync(join(parentDir, entry.name)).isDirectory()
  } catch {
    // A broken or inaccessible link is not a scannable Skill Source.
    return false
  }
}

/**
 * 扫描工具目录,把每个子目录登记为 skill(索引模式,不搬文件)。
 * 重复扫描幂等:(skill_id, path) 唯一约束 + ON CONFLICT 更新 hash/mtime。
 *
 * @param skipPaths 要跳过的子目录绝对路径集合(如 copy 部署的目标目录,
 *                  避免副本被当成新 source 索引进来)。默认空集合。
 */
export function scanToolDir(
  db: DB,
  toolDir: string,
  skipPaths: Set<string> = new Set(),
  sourceTool: string | null = null
): ScanResult {
  const entries = readdirSync(toolDir, { withFileTypes: true })
  const skillDirs = entries
    .filter((entry) => isScannableDirectoryEntry(toolDir, entry))
    .map((e) => join(toolDir, e.name))
    // #3: 跳过 copy 部署的目标目录(副本不该被当成新 source)
    .filter((dir) => !skipPaths.has(dir))

  let upserted = 0
  const scannedPaths: string[] = []
  for (const skillDir of skillDirs) {
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
        { origin: 'scan', tool: sourceTool }
      )
      upserted++
    })
    scannedPaths.push(skillDir)
  }

  return { scanned: skillDirs.length, upserted, scannedPaths }
}
