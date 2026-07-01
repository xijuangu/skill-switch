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
}

export interface SkillWithSourcesView {
  id: number
  name: string
  primary_source_path: string
  created_at: string
  sources: SkillSourceView[]
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

declare global {
  interface Window {
    api: {
      scan: () => Promise<MultiScanResultView>
      getSkills: () => Promise<SkillWithSourcesView[]>
      getSettings: () => Promise<SettingsView>
      setPresetEnabled: (key: string, enabled: boolean) => Promise<SettingsView>
      setPresetPaths: (key: string, paths: string[]) => Promise<SettingsView>
      addCustomTool: (tool: CustomToolInput) => Promise<SettingsView>
      removeCustomTool: (key: string) => Promise<SettingsView>
      setBackupRetention: (n: number) => Promise<SettingsView>
    }
  }
}

export {}
