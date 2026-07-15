// skill-switch 核心类型定义

/** skill 来源类型:索引(不搬文件)/ 中央仓库实体(新安装) */
export type SourceType = 'indexed' | 'central-repo'
export type SourceOrigin = 'scan' | 'local' | 'github' | 'zip' | 'legacy'

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
  source_origin: SourceOrigin
  source_tool: string | null
  discovered_at: string
  /** GitHub 安装记录的源仓库 URL(仅 central-repo + GitHub 来源有值) */
  repo_url: string | null
  /** GitHub 安装记录的 commit SHA(仅 central-repo + GitHub 来源有值) */
  commit_sha: string | null
}

/** 部署清单记录 */
export interface Deployment {
  id: number
  skill_id: number
  target_tool: string
  /** Exact deployed destination; null only for pre-migration records. */
  target_path: string | null
  mode: DeployMode
  source_path: string
  deployed_at: string
  source_hash_at_deploy: string
  /** Stable semantic identities; null means a legacy row could not be reconciled exactly. */
  source_id: number | null
  target_id: string | null
}

export interface DiscoveryTarget {
  id: string
  path: string
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
  /**
   * 展开视图用的部署列表,复用工具页的完整 DriftKind 状态。
   */
  deployments: (Deployment & { status: DriftKind })[]
}

/** 扫描结果:发现的 skill 数量 + 本次实际 upsert 的 source 路径列表 */
export interface ScanResult {
  scanned: number
  upserted: number
  /** 本次扫描 upsert 的 source 路径列表(用于清理失效 source) */
  scannedPaths: string[]
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
  targets?: DiscoveryTarget[]
}

/** 用户自定义工具 */
export interface CustomTool {
  key: string
  displayName: string
  paths: string[]
  targets?: DiscoveryTarget[]
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
  targets: DiscoveryTarget[]
  existingTargets: DiscoveryTarget[]
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

// ===== Deploy(切片 #6)=====

/** deployer 入参:把 skill 从 sourcePath 部署到 targetDir */
export interface DeployOptions {
  skillId: number
  skillName: string
  targetTool: string
  mode: DeployMode
  /** 源目录绝对路径(多 source 时由 UI 先让用户选;未传则用 primary_source_path) */
  sourcePath: string
  /** 目标工具目录绝对路径(如 ~/.codex/skills/grilling) */
  targetDir: string
  /** 备份目录绝对路径(覆盖外部 skill 时走 backup 服务) */
  backupsDir: string
  /** 平台能力:能否创建符号链接?(Windows 普通用户 = false;Mac/Linux = true) */
  canSymlink: boolean
  /** 平台能力:能否创建 junction?(仅 Windows = true;其他平台 = false) */
  canJunction: boolean
  /** Must be true only after an explicit external-overwrite confirmation. */
  allowExternalOverwrite?: boolean
  identity?: { sourceId: number; targetId: string }
}

/** 部署动作类型(用于 UI 反馈与测试断言) */
export type DeployAction =
  | 'created' // 全新部署(目标不存在)
  | 'updated' // 自管覆盖(清单有记录,内容/hash 变了)
  | 'skipped' // 幂等跳过(自管 + hash 未变)
  | 'mode-switched' // 模式切换(先按旧 mode 清理再按新 mode 部署)
  | 'external-overwritten' // 外部 skill(清单无记录)备份后覆盖

/** deploySkill 返回结果 */
export interface DeployResult {
  action: DeployAction
  mode: DeployMode
  targetPath: string
  sourceHashAtDeploy: string
  /** 上一份部署的 mode(仅 mode-switched 时有值) */
  previousMode?: DeployMode
  /** 原始请求的 mode,仅当发生降级(实际 mode ≠ 请求 mode)时设置,如请求 symlink 实际用 copy。 */
  degradedFrom?: DeployMode
  /** 降级原因(供 UI 展示),仅当发生降级时设置。 */
  degradeReason?: string
}

/**
 * 漂移状态(清单 vs 实际扫描对比)。
 * - normal:清单有 + 目录有 + hash 一致(copy 模式)
 * - source-updated:清单有 + 目录有 + 源 hash 变了(copy 模式,"源已更新,可重新部署")
 * - drift:清单有 + 目录无(用户手动删了)
 * - external:清单无 + 目录有(外部 skill)
 */
export type DriftKind =
  | 'normal'
  | 'source-updated'
  | 'target-modified'
  | 'link-mismatch'
  | 'source-missing'
  | 'unresolved'
  | 'drift'
  | 'external'

/** 单个部署点的漂移检测结果 */
export interface DriftStatus {
  skillId: number
  skillName: string
  targetTool: string
  targetPath: string
  /** 部署清单记录(null 表示外部 skill,清单无记录) */
  deployment: Deployment | null
  /** 当前目标路径是否存在 */
  targetExists: boolean
  /** 当前源目录 hash(从 deployment.source_path 重算;源不存在或无部署记录时为 null) */
  currentSourceHash: string | null
  /** Current copy target hash; null for links, missing targets, and external entries. */
  currentTargetHash: string | null
  kind: DriftKind
}

// ===== Install(切片 #7)=====

/** 安装来源类型 */
export type InstallSource = 'github' | 'zip' | 'local-dir'

/** 解析后的 GitHub URL:仓库 URL + 可选子路径 + 可选 ref */
export interface ParsedGitHubUrl {
  /** 仓库 clone URL(https://github.com/owner/repo.git) */
  repoUrl: string
  /** 仓库主页 URL(https://github.com/owner/repo) */
  repoWebUrl: string
  owner: string
  repo: string
  /** 子路径(如 skills/grilling);无则 null */
  subPath: string | null
  /** 分支/tag/commit(如 main);默认 main */
  ref: string
}

/** installer 入参基类 */
export interface InstallOptions {
  /** 中央仓库 skills 目录绝对路径(~/.skill-switch/skills) */
  centralSkillsDir: string
  /** 备份目录绝对路径(同名覆盖时走 backup 服务) */
  backupsDir: string
}

/** installSkill 返回结果 */
export interface InstallResult {
  skillName: string
  skillId: number
  /** 安装后的 source path(centralSkillsDir/{name} 或本地目录原路径) */
  sourcePath: string
  sourceType: SourceType
  /** GitHub 安装记录的源仓库 URL(仅 github 来源) */
  repoUrl: string | null
  /** GitHub 安装记录的 commit SHA(仅 github 来源) */
  commitSha: string | null
  /** 同名 skill 已存在时是否走了备份+覆盖 */
  overwritten: boolean
}
