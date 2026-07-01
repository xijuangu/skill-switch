// preload 类型声明:暴露给渲染进程的 Window.api 类型
// 类型在此内联,避免 renderer 直接依赖主进程模块(保持进程隔离)

export interface ScanResult {
  scanned: number
  upserted: number
  error?: string
}

export interface SkillSourceView {
  id: number
  skill_id: number
  path: string
  hash: string
  mtime: number
  source_type: 'indexed' | 'central-repo'
  discovered_at: string
  repo_url: string | null
  commit_sha: string | null
}

export interface ConflictStatusView {
  skillId: number
  sourceCount: number
  distinctHashCount: number
  hasConflict: boolean
  /** 无冲突时为第一个 source(按 discovered_at ASC);冲突或无 source 时为 null */
  primarySource: SkillSourceView | null
}

export interface SkillWithConflictView {
  id: number
  name: string
  primary_source_path: string
  created_at: string
  sources: SkillSourceView[]
  conflict: ConflictStatusView
}

export interface ToolScanResultView {
  key: string
  displayName: string
  path: string
  scanned: number
  upserted: number
}

export interface MultiScanResultView {
  tools: ToolScanResultView[]
  totalScanned: number
  totalUpserted: number
}

export interface ToolConfigView {
  key: string
  displayName: string
  enabled: boolean
  paths: string[]
  existingPaths: string[]
  isCustom: boolean
  exists: boolean
}

export interface PlatformInfoView {
  platform: string
  canSymlink: boolean
  canJunction: boolean
}

export interface SettingsView {
  tools: ToolConfigView[]
  backupRetention: number
  platform: PlatformInfoView
}

export interface CustomToolInput {
  key: string
  displayName: string
  paths: string[]
}

/** 备份元数据视图(对应 main/services/backup.ts 的 BackupMeta) */
export interface BackupMetaView {
  backupId: string
  skillName: string
  targetTool: string
  sourcePath: string
  sourceHash: string
  backupTime: string
  dirName: string
}

// ===== Deploy(#6)=====

export type DeployModeView = 'symlink' | 'junction' | 'copy'

export type DeployActionView =
  | 'created'
  | 'updated'
  | 'skipped'
  | 'mode-switched'
  | 'external-overwritten'

export interface DeployResultView {
  action: DeployActionView
  mode: DeployModeView
  targetPath: string
  sourceHashAtDeploy: string
  previousMode?: DeployModeView
  /** #9: 原始请求 mode,仅当降级(实际 mode ≠ 请求 mode)时设置 */
  degradedFrom?: DeployModeView
  /** #9: 降级原因(UI 展示),仅当降级时设置 */
  degradeReason?: string
}

export interface DeploymentView {
  id: number
  skill_id: number
  target_tool: string
  mode: DeployModeView
  source_path: string
  deployed_at: string
  source_hash_at_deploy: string
}

export type DriftKindView = 'normal' | 'source-updated' | 'drift' | 'external'

export interface DriftStatusView {
  skillId: number
  skillName: string
  targetTool: string
  targetPath: string
  deployment: DeploymentView | null
  targetExists: boolean
  currentSourceHash: string | null
  kind: DriftKindView
}

export interface ToolWithDriftsView {
  config: ToolConfigView
  drifts: DriftStatusView[]
}

// ===== Install(#7)=====

export interface InstallResultView {
  skillName: string
  skillId: number
  sourcePath: string
  sourceType: 'indexed' | 'central-repo'
  repoUrl: string | null
  commitSha: string | null
  overwritten: boolean
}

declare global {
  interface Window {
    api: {
      scan: () => Promise<MultiScanResultView>
      getSkills: () => Promise<SkillWithConflictView[]>
      getSettings: () => Promise<SettingsView>
      setPresetEnabled: (key: string, enabled: boolean) => Promise<SettingsView>
      setPresetPaths: (key: string, paths: string[]) => Promise<SettingsView>
      addCustomTool: (tool: CustomToolInput) => Promise<SettingsView>
      removeCustomTool: (key: string) => Promise<SettingsView>
      setBackupRetention: (n: number) => Promise<SettingsView>
      listBackups: () => Promise<BackupMetaView[]>
      restoreBackup: (backupId: string) => Promise<void>
      deleteBackup: (backupId: string) => Promise<void>
      // Deploy
      deploy: (
        skillId: number,
        targetTool: string,
        mode: DeployModeView,
        sourcePath: string
      ) => Promise<DeployResultView>
      undeploy: (skillId: number, targetTool: string) => Promise<void>
      getTools: () => Promise<ToolWithDriftsView[]>
      // Drift + Remove from Registry (#8)
      removeFromManifest: (skillId: number, targetTool: string) => Promise<void>
      getDeploymentsForSkill: (skillId: number) => Promise<DeploymentView[]>
      viewSkillMd: (skillId: number, sourcePath?: string) => Promise<{ content: string; path: string } | null>
      removeFromRegistry: (
        skillId: number
      ) => Promise<{ skillName: string; backedUp: boolean; undeployedTools: string[] }>
      // Install
      installFromGitHub: (url: string) => Promise<InstallResultView>
      installFromZip: (zipPath: string) => Promise<InstallResultView>
      installFromLocalDir: (localPath: string) => Promise<InstallResultView>
      selectZipFile: () => Promise<string | null>
      selectLocalDir: () => Promise<string | null>
    }
  }
}

export {}
