// skill-switch 核心类型定义

/** skill 来源类型:索引(不搬文件)/ 中央仓库实体(新安装) */
export type SourceType = 'indexed' | 'central-repo'

/** 部署模式 */
export type DeployMode = 'symlink' | 'junction' | 'copy'

/** skill 注册表记录 */
export interface Skill {
  id: number
  name: string
  primary_source_path: string
  created_at: string
}

/** skill 的某个 source(一对多) */
export interface SkillSource {
  id: number
  skill_id: number
  path: string
  hash: string
  mtime: number
  source_type: SourceType
  discovered_at: string
}

/** 部署清单记录 */
export interface Deployment {
  id: number
  skill_id: number
  target_tool: string
  mode: DeployMode
  source_path: string
  deployed_at: string
  source_hash_at_deploy: string
}

/** Skills 页展示用的聚合视图 */
export interface SkillWithSources extends Skill {
  sources: SkillSource[]
}

/** 扫描结果:发现的 skill 数量 */
export interface ScanResult {
  scanned: number
  upserted: number
}
