import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Sparkles, Wrench, Archive, Settings,
} from 'lucide-react'
import { ToastProvider, useToast } from '../shared'
import { createLatestRequestGate, completeMutation } from '../async-state'
import { SkillsPage } from '../features/skills/SkillsPage'
import { ToolsPage } from '../features/tools/ToolsPage'
import { BackupsPage } from '../features/backups/BackupsPage'
import { SettingsPage } from '../features/settings/SettingsPage'

type ScanResult = Awaited<ReturnType<typeof window.api.scan>>
type SkillView = Awaited<ReturnType<typeof window.api.getSkills>>[number]
type ToolWithDriftsView = Awaited<ReturnType<typeof window.api.getTools>>[number]

type Page = 'skills' | 'tools' | 'backups' | 'settings'

const NAV_ITEMS: { page: Page; label: string; icon: typeof Sparkles }[] = [
  { page: 'skills', label: '技能', icon: Sparkles },
  { page: 'tools', label: '工具', icon: Wrench },
  { page: 'backups', label: '备份', icon: Archive },
  { page: 'settings', label: '设置', icon: Settings },
]

export default function App() {
  const [page, setPage] = useState<Page>('skills')
  const [skills, setSkills] = useState<SkillView[]>([])
  const [tools, setTools] = useState<ToolWithDriftsView[]>([])
  const [scanning, setScanning] = useState(false)
  const [lastScan, setLastScan] = useState<ScanResult | null>(null)
  const [loading, setLoading] = useState(true)
  const refreshGate = useRef(createLatestRequestGate())

  const { success, error: toastError, info } = useToast()

  const refresh = useCallback(async () => {
    const generation = refreshGate.current.start()
    try {
      const [skillsResult, toolsResult] = await Promise.all([
        window.api.getSkills(),
        window.api.getTools()
      ])
      if (!refreshGate.current.isLatest(generation)) return
      setSkills(skillsResult)
      setTools(toolsResult)
      setLoading(false)
    } catch (err) {
      if (refreshGate.current.isLatest(generation)) {
        toastError(err instanceof Error ? err.message : String(err))
      }
      if (loading) setLoading(false)
      throw err
    }
  }, [toastError, loading])

  useEffect(() => {
    refresh().catch(() => {})
  }, [page]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleScan = async () => {
    setScanning(true)
    try {
      const result = await window.api.scan()
      setLastScan(result)
      await refresh()
      info(`扫描完成：${result.totalScanned} 个 skill，登记 ${result.totalUpserted} 个`)
    } catch {
      toastError('扫描失败')
    } finally {
      setScanning(false)
    }
  }

  return (
    <ToastProvider>
      <div className="min-h-screen flex bg-[#fafafa]">
        <nav className="w-44 shrink-0 bg-surface-secondary border-r border-border flex flex-col">
          <div className="p-4">
            <h1 className="text-sm font-semibold text-foreground">skill-switch</h1>
            <p className="text-2xs text-foreground-muted mt-0.5">AI 编程工具 Skill 管理器</p>
          </div>
          <ul className="flex-1 px-2 space-y-0.5">
            {NAV_ITEMS.map((item) => (
              <NavItem
                key={item.page}
                page={item.page}
                current={page}
                onClick={setPage}
                label={item.label}
                icon={item.icon}
              />
            ))}
          </ul>
        </nav>

        <main className="flex-1 p-6 overflow-auto">
          {page === 'skills' && (
            <SkillsPage
              skills={skills}
              tools={tools}
              scanning={scanning}
              lastScan={lastScan}
              loading={loading}
              onScan={handleScan}
              onRefresh={refresh}
            />
          )}
          {page === 'tools' && (
            <ToolsPage
              tools={tools}
              loading={loading}
              onRefresh={refresh}
            />
          )}
          {page === 'backups' && <BackupsPage />}
          {page === 'settings' && <SettingsPage />}
        </main>
      </div>
    </ToastProvider>
  )
}

function NavItem({
  page,
  current,
  onClick,
  label,
  icon: Icon
}: {
  page: Page
  current: Page
  onClick: (p: Page) => void
  label: string
  icon: typeof Sparkles
}) {
  const active = current === page
  return (
    <li>
      <button
        onClick={() => onClick(page)}
        className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-xs font-medium transition-colors duration-fast ${
          active
            ? 'bg-surface text-primary border-l-2 border-primary pl-[7px]'
            : 'text-foreground-secondary hover:bg-surface-hover hover:text-foreground border-l-2 border-transparent'
        }`}
      >
        <Icon className="h-4 w-4" />
        <span>{label}</span>
      </button>
    </li>
  )
}
