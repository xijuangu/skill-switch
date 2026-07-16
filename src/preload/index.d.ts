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
  source_role: 'candidate' | 'canonical'
  source_origin: 'scan' | 'local' | 'github' | 'zip' | 'legacy'
  source_tool: string | null
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
  /** 每条 deployment 附带与工具页一致的完整 drift 状态 */
  deployments: SkillDeploymentView[]
}

export type SkillLibrarySourceView = SkillSourceView

export interface SkillLibraryReadModelView {
  canonicalRepository: { path: string }
  skills: Array<{
    id: number
    name: string
    canonicalSource: SkillLibrarySourceView | null
    candidates: SkillLibrarySourceView[]
  }>
  consolidationPlan: Array<{
    skillId: number
    skillName: string
    selectedByDefault: boolean
    hasConflict: boolean
    canonicalRelativeParent: string
    versions: Array<{ hash: string; candidateSourceIds: number[]; paths: string[] }>
  }>
  consolidationBatches: Array<{
    id: string
    status: 'previewed' | 'completed' | 'failed' | 'recovery-required' | 'undone'
    items: Array<{
      skillId: number
      skillName: string
      canonicalPath: string
      archivePath: string
      originalPath: string
      originalHash: string
      archivedToolPaths: string[]
    }>
    archive: { sizeBytes: number; recoverable: boolean; purgeable: boolean; purgedAt: string | null }
    phase: string | null
    createdAt: string
    completedAt: string | null
    undoneAt: string | null
    failureMessage: string | null
    recoveryDirection: 'rollback-consolidation' | 'finish-cleanup' | 'rollback-undo' | 'inspect' | null
    evidenceSummary: { itemCount: number; phases: string[] }
  }>
  sourceRelocations: Array<{
    id: string
    status: 'previewed' | 'completed' | 'failed' | 'recovery-required' | 'undone'
    skillId: number
    skillName: string
    sourceId: number
    oldCanonicalPath: string
    newCanonicalPath: string
    createdAt: string
    completedAt: string | null
    undoneAt: string | null
    failureMessage: string | null
  }>
}

export type SourceRelocationPreviewView = {
  status: 'confirmation-required'
  confirmationId: string
  relocationId: string
  skillId: number
  skillName: string
  oldCanonicalPath: string
  newCanonicalPath: string
  deployments: Array<{ deploymentId: number; targetTool: string; targetPath: string; mode: DeployModeView }>
}

export type SourceRelocationOutcomeView =
  | { status: 'completed'; relocationId: string; sourceId: number; canonicalPath: string }
  | { status: 'undone'; relocationId: string; sourceId: number; canonicalPath: string }
  | { status: 'rejected'; relocationId?: string; reason: 'confirmation-not-found' | 'plan-stale' | 'relocation-not-undoable' | 'relocation-busy'; message: string }
  | { status: 'recovery-required'; relocationId: string; message: string }

export type ConsolidationPreviewView = {
  status: 'confirmation-required'
  confirmationId: string
  batchId: string
  skillId: number
  skillName: string
  operations: Array<{ kind: 'write-canonical' | 'archive-candidate' | 'remove-observed-entry'; path: string }>
}

export type ConsolidationBatchPreviewView = {
  status: 'confirmation-required'
  confirmationId: string
  batchId: string
  items: Array<{ skillId: number; skillName: string; canonicalPath: string }>
  operations: ConsolidationPreviewView['operations']
}

export type ConsolidationFailureView =
  | { status: 'rejected'; batchId?: string; reason: 'confirmation-not-found' | 'plan-stale' | 'restore-path-occupied' | 'batch-not-undoable' | 'batch-not-purgeable' | 'archive-purged' | 'batch-busy'; message: string }
  | { status: 'recovery-required'; batchId: string; message: string }

export type ConsolidationConfirmationOutcomeView =
  | { status: 'completed'; batchId: string; skillId: number; canonicalPath: string; items?: Array<{ skillId: number; canonicalPath: string }> }
  | ConsolidationFailureView

export type ConsolidationUndoOutcomeView =
  | { status: 'undone'; batchId: string }
  | ConsolidationFailureView

export type SourceArchivePurgePreviewView =
  | { status: 'confirmation-required'; confirmationId: string; batchId: string; itemCount: number; sizeBytes: number }
  | Extract<ConsolidationFailureView, { status: 'rejected' }>

export type SourceArchivePurgeOutcomeView =
  | { status: 'purged'; batchId: string; purgedAt: string; sizeBytes: number }
  | ConsolidationFailureView

/** issue #23:Skills 页展开视图用,DeploymentView + 当前状态描述 */
export interface SkillDeploymentView extends DeploymentView {
  status: DriftKindView
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
  targets: Array<{ id: string; path: string }>
  existingTargets: Array<{ id: string; path: string }>
  isCustom: boolean
  exists: boolean
}

export interface DeployTargetOptionView {
  targetId: string
  targetTool: string
  displayName: string
  eligible: boolean
  reason: string | null
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

export interface SourceRootView {
  id: number
  path: string
  created_at: string
  last_scanned_at: string | null
  last_scan_error: string | null
}

export interface SourceRootScanResultView {
  root: SourceRootView
  discovered: number
  upserted: number
  removed: number
  sources: SkillSourceView[]
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
  targetDisplayName: string
  previousMode?: DeployModeView
  /** #9: 原始请求 mode,仅当降级(实际 mode ≠ 请求 mode)时设置 */
  degradedFrom?: DeployModeView
  /** #9: 降级原因(UI 展示),仅当降级时设置 */
  degradeReason?: string
}

export type DeploymentOutcomeView =
  | { status: 'completed'; deploymentId: number; result: DeployResultView }
  | {
      status: 'confirmation-required'
      confirmationId: string
      expiresAt: number
      facts: {
        skillName: string
        targetDisplayName: string
        reasons: Array<'external-overwrite' | 'target-modified' | 'mode-degraded'>
        requestedMode: DeployModeView
        actualMode: DeployModeView
        backup: { required: boolean; directory: string | null }
      }
    }
  | {
      status: 'rejected'
      reason: 'confirmation-expired' | 'confirmation-used' | 'confirmation-invalid' | 'plan-changed' | 'target-busy' | 'observed-read-only'
      message: string
    }
  | {
      status: 'recovery-required'
      message: string
      evidence: {
        operationId: string
        targetPath: string
        markerPath: string
        stagingPath: string
        rollbackPath: string
        phase: string
      }
    }

export type DeploymentMutationOutcomeView =
  | { status: 'completed'; deploymentId: number }
  | { status: 'rejected'; reason: 'deployment-not-found' | 'unresolved' | 'target-busy' | 'observed-read-only' | 'observation-stale'; message: string }
  | Extract<DeploymentOutcomeView, { status: 'recovery-required' }>

export type DeploymentRedeployOutcomeView =
  | DeploymentOutcomeView
  | Extract<DeploymentMutationOutcomeView, { status: 'rejected' }>

export interface BulkAdoptionPreviewFactsView {
  total: number
  tools: Array<{
    targetTool: string
    targetDisplayName: string
    items: Array<{ deploymentId: number; skillName: string; targetId: string; targetPath: string }>
  }>
}

export type BulkAdoptionPreviewOutcomeView =
  | { status: 'empty'; facts: BulkAdoptionPreviewFactsView }
  | {
      status: 'confirmation-required'
      confirmationId: string
      expiresAt: number
      facts: BulkAdoptionPreviewFactsView
    }

export interface BulkAdoptionResultItemView {
  deploymentId: number
  skillName: string
  targetTool: string
  targetId: string
  targetPath: string
}

export type BulkAdoptionConfirmationOutcomeView =
  | {
      status: 'completed'
      total: number
      adopted: BulkAdoptionResultItemView[]
      failed: Array<BulkAdoptionResultItemView & { reason: string; message: string }>
    }
  | {
      status: 'rejected'
      reason: 'confirmation-expired' | 'confirmation-used' | 'confirmation-invalid'
      message: string
    }

export interface DeploymentView {
  id: number
  skill_id: number
  target_tool: string
  target_path: string | null
  mode: DeployModeView
  management: 'managed' | 'observed'
  source_path: string
  source_id: number | null
  target_id: string | null
  deployed_at: string
  source_hash_at_deploy: string
}

export type DriftKindView =
  | 'normal'
  | 'source-updated'
  | 'target-modified'
  | 'link-mismatch'
  | 'source-missing'
  | 'unresolved'
  | 'drift'
  | 'external'
  | 'recovery-required'

export interface DriftStatusView {
  skillId: number
  skillName: string
  targetTool: string
  targetPath: string
  deployment: DeploymentView | null
  targetExists: boolean
  currentSourceHash: string | null
  currentTargetHash: string | null
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
      getSkillLibrary: () => Promise<SkillLibraryReadModelView>
      previewConsolidation: (request: { candidateSourceId: number; canonicalRelativeParent: string }) => Promise<ConsolidationPreviewView>
      previewConsolidationBatch: (request: { items: Array<{ candidateSourceId: number; canonicalRelativeParent: string }> }) => Promise<ConsolidationBatchPreviewView>
      confirmConsolidation: (confirmationId: string) => Promise<ConsolidationConfirmationOutcomeView>
      undoConsolidation: (batchId: string) => Promise<ConsolidationUndoOutcomeView>
      restoreConsolidation: (batchId: string) => Promise<ConsolidationUndoOutcomeView>
      previewSourceArchivePurge: (batchId: string) => Promise<SourceArchivePurgePreviewView>
      confirmSourceArchivePurge: (confirmationId: string) => Promise<SourceArchivePurgeOutcomeView>
      previewSourceRelocation: (request: { sourceId: number; canonicalRelativeParent: string }) => Promise<SourceRelocationPreviewView>
      confirmSourceRelocation: (confirmationId: string) => Promise<SourceRelocationOutcomeView>
      undoSourceRelocation: (relocationId: string) => Promise<SourceRelocationOutcomeView>
      getSettings: () => Promise<SettingsView>
      getSourceRoots: () => Promise<SourceRootView[]>
      registerSourceRoot: (path: string) => Promise<SourceRootScanResultView>
      rescanSourceRoot: (rootId: number) => Promise<SourceRootScanResultView>
      detachSourceRoot: (rootId: number) => Promise<{ detachedSources: number }>
      getDeployTargets: (sourceId: number) => Promise<DeployTargetOptionView[]>
      setPresetEnabled: (key: string, enabled: boolean) => Promise<SettingsView>
      setPresetPaths: (key: string, paths: string[]) => Promise<SettingsView>
      addCustomTool: (tool: CustomToolInput) => Promise<SettingsView>
      removeCustomTool: (key: string) => Promise<SettingsView>
      setBackupRetention: (n: number) => Promise<SettingsView>
      listBackups: () => Promise<BackupMetaView[]>
      restoreBackup: (backupId: string) => Promise<void>
      deleteBackup: (backupId: string) => Promise<void>
      // Deploy
      deploymentDeploy: (request: {
        sourceId: number
        targetId: string
        requestedMode: DeployModeView
      }) => Promise<DeploymentOutcomeView>
      deploymentConfirm: (confirmationId: string) => Promise<DeploymentOutcomeView>
      // issue #22:漂移重新部署,target_path / source_path 由主进程从清单读取
      redeploy: (deploymentId: number) => Promise<DeploymentRedeployOutcomeView>
      undeploy: (deploymentId: number) => Promise<DeploymentMutationOutcomeView>
      adoptDeployment: (deploymentId: number) => Promise<DeploymentMutationOutcomeView>
      getBulkAdoptionFacts: () => Promise<BulkAdoptionPreviewFactsView>
      previewBulkAdoption: () => Promise<BulkAdoptionPreviewOutcomeView>
      confirmBulkAdoption: (confirmationId: string) => Promise<BulkAdoptionConfirmationOutcomeView>
      getTools: () => Promise<ToolWithDriftsView[]>
      // Drift + Remove from Registry (#8)
      removeFromManifest: (deploymentId: number) => Promise<void>
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
