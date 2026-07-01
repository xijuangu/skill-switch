// registry 服务:多 source 身份 + 冲突检测
//
// 身份主键 = skill name(skills 表 UNIQUE);一个 skill 可有多个 source path。
// 多 source 内容一致性 = 对比各 source 的 hash:
//   - 全部相同 → 无冲突,primarySource = 第一个发现的 source(getSourcesBySkillId 按 discovered_at ASC)
//   - 存在不同 → 冲突,primarySource = undefined,UI 必须让用户选一个 source
// 不自动合并:冲突时所有 source 保留,仅标记状态,等用户在 UI 选。
//
// 本服务纯函数 + DB 查询,无副作用,便于对着临时 DB 测外部行为。

import type { DB } from '../db/database'
import type { ConflictStatus, SkillSource } from '../types'
import { getSourcesBySkillId } from '../db/dao/skill-sources'

/**
 * 基于已加载的 sources 计算冲突状态(纯函数,不查 DB)。
 * @param sources 已按 discovered_at ASC 排序的 source 列表
 * @param skillId 所属 skill id
 */
export function computeConflict(
  sources: SkillSource[],
  skillId: number
): ConflictStatus {
  const sourceCount = sources.length
  const distinctHashCount = new Set(sources.map((s) => s.hash)).size
  const hasConflict = sourceCount > 1 && distinctHashCount > 1
  // 无冲突时:有 source 则取第一个;冲突或无 source 时为 null
  const primarySource = hasConflict || sourceCount === 0 ? null : sources[0]
  return { skillId, sourceCount, distinctHashCount, hasConflict, primarySource }
}

/** 按 skill_id 查 source 并计算冲突状态 */
export function getConflictStatus(db: DB, skillId: number): ConflictStatus {
  const sources = getSourcesBySkillId(db, skillId)
  return computeConflict(sources, skillId)
}

/**
 * 返回所有存在冲突的 skill 的 ConflictStatus(sourceCount > 1 且 distinctHashCount > 1)。
 * 用于全局扫描冲突提示;无冲突的 skill 不在结果中。
 * @param skillIds 待检查的 skill id 列表(通常来自 getAllSkills 的结果)
 */
export function getAllConflicts(db: DB, skillIds: number[]): ConflictStatus[] {
  const out: ConflictStatus[] = []
  for (const id of skillIds) {
    const status = getConflictStatus(db, id)
    if (status.hasConflict) {
      out.push(status)
    }
  }
  return out
}
