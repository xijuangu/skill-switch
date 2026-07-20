import { useState, useEffect, useCallback } from 'react'
import { Database, Monitor } from 'lucide-react'
import { Button, Input } from '../../shared'
import packageJson from '../../../../../package.json'

type SettingsView = Awaited<ReturnType<typeof window.api.getSettings>>
type SkillLibraryView = Awaited<ReturnType<typeof window.api.getSkillLibrary>>

// #116:设置页只保留全局偏好、平台能力和版本信息。
// 工具启用 / 发现目录 / 工具关系已移至工具页。
export function SettingsPage() {
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [busy, setBusy] = useState(false)
  const [retention, setRetention] = useState<number>(20)
  const [skillLibrary, setSkillLibrary] = useState<SkillLibraryView | null>(null)

  const load = useCallback(async () => {
    const [s, library] = await Promise.all([
      window.api.getSettings(),
      window.api.getSkillLibrary()
    ])
    setSettings(s)
    setSkillLibrary(library)
    setRetention(s.backupRetention)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const run = async (fn: () => Promise<SettingsView>) => {
    setBusy(true)
    try {
      const s = await fn()
      setSettings(s)
      setRetention(s.backupRetention)
    } finally {
      setBusy(false)
    }
  }

  const handleSaveRetention = () =>
    run(() => window.api.setBackupRetention(retention))

  if (!settings || !skillLibrary) {
    return (
      <div className="space-y-3 p-1 h-full overflow-auto">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-16 rounded-md bg-border-subtle" />
        ))}
      </div>
    )
  }

  return (
    <div className="max-w-2xl h-full overflow-auto">
      <section className="mb-8">
        <div className="flex items-center gap-2 mb-4">
          <Database className="h-4 w-4 text-foreground-secondary" />
          <h2 className="text-sm font-semibold">权威源码库</h2>
        </div>
        <p className="text-xs text-foreground-secondary mb-2">
          已整理 Skill 的唯一权威内容位置，由 skill-switch 固定管理。
        </p>
        <div className="border border-border rounded-md p-3 font-mono text-xs text-foreground break-all">
          {skillLibrary.canonicalRepository.path}
        </div>
      </section>

      <section className="mb-8">
        <div className="flex items-center gap-2 mb-4">
          <Database className="h-4 w-4 text-foreground-secondary" />
          <h2 className="text-sm font-semibold">备份保留</h2>
        </div>
        <label className="block text-xs text-foreground-secondary mb-1">
          备份保留数
        </label>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={1}
            className="w-24"
            value={retention}
            onChange={(e) => setRetention(Number(e.target.value))}
          />
          <Button variant="primary" onClick={handleSaveRetention} disabled={busy} size="sm">
            保存
          </Button>
        </div>
        <p className="mt-2 text-2xs text-foreground-muted">
          备份记录与恢复入口位于「恢复」页的备份标签。
        </p>
      </section>

      <section className="mb-8">
        <div className="flex items-center gap-2 mb-4">
          <Monitor className="h-4 w-4 text-foreground-secondary" />
          <h2 className="text-sm font-semibold">平台能力</h2>
        </div>
        <div className="border border-border rounded-md p-3 space-y-1">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-foreground-secondary">platform</span>
            <code className="font-mono text-foreground">{settings.platform.platform}</code>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-foreground-secondary">canSymlink</span>
            <span className={`font-mono ${settings.platform.canSymlink ? 'text-success' : 'text-danger'}`}>
              {String(settings.platform.canSymlink)}
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-foreground-secondary">canJunction</span>
            <span className={`font-mono ${settings.platform.canJunction ? 'text-success' : 'text-danger'}`}>
              {String(settings.platform.canJunction)}
            </span>
          </div>
        </div>
      </section>

      <div className="text-2xs text-foreground-muted mt-2">
        skill-switch v{packageJson.version}
      </div>
    </div>
  )
}
