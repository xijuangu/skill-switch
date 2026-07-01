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

declare global {
  interface Window {
    api: {
      scan: () => Promise<ScanResult>
      getSkills: () => Promise<SkillWithSourcesView[]>
    }
  }
}

export {}
