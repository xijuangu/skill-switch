// scanner 服务:扫描工具目录,登记 skill 到注册表
//
// 收集语义 = 索引(不搬文件),source_type = 'indexed'。
// 身份主键 = SKILL.md frontmatter 的 name;无 frontmatter 或无 name → 回退目录名。

import { readdirSync, readFileSync, existsSync, statSync } from 'fs'
import { join, basename } from 'path'
import matter from 'gray-matter'
import type { DB } from '../db/database'
import type { ScanResult } from '../types'
import { runInTransaction } from '../db/database'
import { upsertSkill } from '../db/dao/skills'
import { upsertSource } from '../db/dao/skill-sources'
import { hashDir } from './hash'

/** 从 SKILL.md frontmatter 解析 name;无则回退目录名 */
function resolveSkillName(skillDir: string): string {
  const skillMdPath = join(skillDir, 'SKILL.md')
  if (existsSync(skillMdPath)) {
    const content = readFileSync(skillMdPath, 'utf-8')
    const parsed = matter(content)
    const name = parsed.data.name
    if (typeof name === 'string' && name.trim().length > 0) {
      return name.trim()
    }
  }
  return basename(skillDir)
}

/**
 * 扫描工具目录,把每个子目录登记为 skill(索引模式,不搬文件)。
 * 重复扫描幂等:(skill_id, path) 唯一约束 + ON CONFLICT 更新 hash/mtime。
 */
export function scanToolDir(db: DB, toolDir: string): ScanResult {
  const entries = readdirSync(toolDir, { withFileTypes: true })
  const skillDirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => join(toolDir, e.name))

  let upserted = 0
  for (const skillDir of skillDirs) {
    const name = resolveSkillName(skillDir)
    const hash = hashDir(skillDir)
    const mtime = Math.floor(statSync(skillDir).mtimeMs)
    runInTransaction(db, () => {
      const skillId = upsertSkill(db, name, skillDir)
      upsertSource(db, skillId, skillDir, hash, mtime, 'indexed')
      upserted++
    })
  }

  return { scanned: skillDirs.length, upserted }
}
