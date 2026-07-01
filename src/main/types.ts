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

/**
 * 多 source 冲突检测结果。
 * - sourceCount == 0:无 source(理论不发生,skill 总有至少一个 source)
 * - sourceCount == 1:单 source,无冲突,primarySource = sources[0]
 * - sourceCount > 1 + distinctHashCount == 1:多 source 内容一致,无冲突,primarySource = sources[0](第一个发现的)
 * - sourceCount > 1 + distinctHashCount > 1:多 source 内容冲突,hasConflict = true,primarySource = null(必须由 UI 选)
 */
export interface ConflictStatus {
  skillId: number
  sourceCount: number
  distinctHashCount: number
  hasConflict: boolean
  /** 无冲突时为第一个 source(按 discovered_at ASC);冲突或无 source 时为 null */
  primarySource: SkillSource | null
}

/** Skills 页展示用:skill + sources + 冲突状态 */
export interface SkillWithConflict extends SkillWithSources {
  conflict: ConflictStatus
}

/** 扫描结果:发现的 skill 数量 */
export interface ScanResult {
  scanned: number
  upserted: number
}

/** 内置工具预设(代码内固定,displayName + internal key + 默认路径) */
export interface ToolPreset {
  key: string
  displayName: string
  defaultPaths: string[]
}

/** settings.json 中单个预设的配置(enabled + paths 覆盖) */
export interface PresetConfig {
  enabled: boolean
  paths: string[]
}

/** 用户自定义工具 */
export interface CustomTool {
  key: string
  displayName: string
  paths: string[]
}

/** 平台能力检测结果 */
export interface PlatformInfo {
  platform: string
  canSymlink: boolean
  canJunction: boolean
}

/** settings.json 顶层结构 */
export interface AppSettings {
  tools: {
    presets: Record<string, PresetConfig>
    custom: CustomTool[]
  }
  backupRetention: number
  platform: PlatformInfo
}

/**
 * 解析后的工具视图(UI 与扫描共用):
 * 把内置预设 + 自定义工具 + settings + 磁盘探测合并成统一列表。
 */
export interface ToolConfig {
  key: string
  displayName: string
  enabled: boolean
  paths: string[]
  existingPaths: string[]
  isCustom: boolean
  exists: boolean
}

/** 单个工具目录的扫描结果 */
export interface ToolScanResult {
  key: string
  displayName: string
  path: string
  scanned: number
  upserted: number
}

/** 多工具聚合扫描结果 */
export interface MultiScanResult {
  tools: ToolScanResult[]
  totalScanned: number
  totalUpserted: number
}
