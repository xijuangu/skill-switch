import { vi } from 'vitest'

/**
 * 渲染测试共享的 window.api mock：完整覆盖 preload 表面，
 * 各测试通过 overrides 替换关心的方法。
 */
export function mockWindowApi(overrides: Partial<Window['api']> = {}) {
  const api: Window['api'] = {
    scan: vi.fn().mockResolvedValue({ tools: [], totalScanned: 0, totalUpserted: 0 }),
    getSkills: vi.fn().mockResolvedValue([]),
    getSkillLibrary: vi.fn().mockResolvedValue({
      canonicalRepository: { path: '/canonical' },
      skills: [],
      consolidationPlan: [],
      consolidationBatches: [],
      sourceRelocations: []
    }),
    previewConflictResolution: vi.fn(),
    previewConsolidation: vi.fn(),
    previewConsolidationBatch: vi.fn(),
    confirmConsolidation: vi.fn(),
    undoConsolidation: vi.fn(),
    restoreConsolidation: vi.fn(),
    previewSourceArchivePurge: vi.fn(),
    confirmSourceArchivePurge: vi.fn(),
    previewSourceRelocation: vi.fn(),
    confirmSourceRelocation: vi.fn(),
    undoSourceRelocation: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({
      tools: [],
      backupRetention: 5,
      platform: { platform: 'darwin', canSymlink: true, canJunction: false },
    }),
    getSourceRoots: vi.fn().mockResolvedValue([]),
    registerSourceRoot: vi.fn(),
    rescanSourceRoot: vi.fn(),
    detachSourceRoot: vi.fn(),
    getDeployTargets: vi.fn().mockResolvedValue([]),
    setPresetEnabled: vi.fn(),
    setPresetPaths: vi.fn(),
    addCustomTool: vi.fn(),
    removeCustomTool: vi.fn(),
    setBackupRetention: vi.fn(),
    listBackups: vi.fn().mockResolvedValue([]),
    restoreBackup: vi.fn(),
    deleteBackup: vi.fn(),
    deploymentDeploy: vi.fn(),
    deploymentConfirm: vi.fn(),
    redeploy: vi.fn(),
    undeploy: vi.fn(),
    bulkDeploy: vi.fn(),
    bulkConfirmDeploy: vi.fn(),
    bulkUndeploy: vi.fn(),
    bulkRemoveFromRegistry: vi.fn(),
    adoptDeployment: vi.fn(),
    getBulkAdoptionFacts: vi.fn().mockResolvedValue({ total: 0, tools: [] }),
    previewBulkAdoption: vi.fn().mockResolvedValue({ status: 'empty', facts: { total: 0, tools: [] } }),
    confirmBulkAdoption: vi.fn(),
    getTools: vi.fn().mockResolvedValue([]),
    removeFromManifest: vi.fn(),
    detachStaleDeployment: vi.fn(),
    getDeploymentsForSkill: vi.fn().mockResolvedValue([]),
    viewSkillMd: vi.fn(),
    removeFromRegistry: vi.fn(),
    installFromGitHub: vi.fn(),
    installFromZip: vi.fn(),
    installFromLocalDir: vi.fn(),
    selectZipFile: vi.fn(),
    selectLocalDir: vi.fn(),
    bulkDetachDeployments: vi.fn(),
    checkForUpdates: vi.fn().mockResolvedValue({
      status: 'up-to-date',
      currentVersion: '1.0.0',
      latestVersion: '1.0.0'
    }),
    ...overrides,
  }
  Object.defineProperty(window, 'api', { value: api, writable: true, configurable: true })
  return api
}
