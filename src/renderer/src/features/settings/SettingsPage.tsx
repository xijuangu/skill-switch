import { useState, useEffect, useCallback } from 'react'
import { Settings, Wrench, Database, Monitor } from 'lucide-react'
import { Button, Input, StatusDot } from '../../shared'

type SettingsView = Awaited<ReturnType<typeof window.api.getSettings>>
type ToolConfigView = SettingsView['tools'][number]

export function SettingsPage() {
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [busy, setBusy] = useState(false)
  const [newToolKey, setNewToolKey] = useState('')
  const [newToolName, setNewToolName] = useState('')
  const [newToolPaths, setNewToolPaths] = useState('')
  const [editingPaths, setEditingPaths] = useState<Record<string, string>>({})
  const [retention, setRetention] = useState<number>(20)

  const load = useCallback(async () => {
    const s = await window.api.getSettings()
    setSettings(s)
    setRetention(s.backupRetention)
    const pathsMap: Record<string, string> = {}
    for (const t of s.tools) {
      pathsMap[t.key] = t.paths.join('\n')
    }
    setEditingPaths(pathsMap)
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
      const pathsMap: Record<string, string> = {}
      for (const t of s.tools) {
        pathsMap[t.key] = t.paths.join('\n')
      }
      setEditingPaths(pathsMap)
    } finally {
      setBusy(false)
    }
  }

  const handleToggle = (key: string, enabled: boolean) =>
    run(() => window.api.setPresetEnabled(key, enabled))

  const handleSavePaths = (key: string) => {
    const raw = editingPaths[key] ?? ''
    const paths = raw.split('\n').map((p) => p.trim()).filter((p) => p.length > 0)
    run(() => window.api.setPresetPaths(key, paths))
  }

  const handleAddCustom = () => {
    const paths = newToolPaths.split('\n').map((p) => p.trim()).filter((p) => p.length > 0)
    if (!newToolKey.trim() || !newToolName.trim() || paths.length === 0) return
    run(() =>
      window.api.addCustomTool({
        key: newToolKey.trim(),
        displayName: newToolName.trim(),
        paths
      })
    ).then(() => {
      setNewToolKey('')
      setNewToolName('')
      setNewToolPaths('')
    })
  }

  const handleRemoveCustom = (key: string) =>
    run(() => window.api.removeCustomTool(key))

  const handleSaveRetention = () =>
    run(() => window.api.setBackupRetention(retention))

  if (!settings) {
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
          <Wrench className="h-4 w-4 text-foreground-secondary" />
          <h2 className="text-sm font-semibold">工具</h2>
        </div>
        <ul className="space-y-3">
          {settings.tools.map((tool) => (
            <ToolPanel
              key={tool.key}
              tool={tool}
              editingPaths={editingPaths[tool.key] ?? ''}
              onEditingPathsChange={(v) => setEditingPaths({ ...editingPaths, [tool.key]: v })}
              onToggle={handleToggle}
              onSavePaths={handleSavePaths}
              onRemove={handleRemoveCustom}
              busy={busy}
            />
          ))}
        </ul>

        <div className="mt-4 border border-dashed border-border rounded-md p-3">
          <h3 className="text-xs font-semibold text-foreground mb-2">添加自定义工具</h3>
          <div className="grid grid-cols-2 gap-2 mb-2">
            <Input
              placeholder="Key（如 mytool）"
              value={newToolKey}
              onChange={(e) => setNewToolKey(e.target.value)}
              mono
            />
            <Input
              placeholder="显示名"
              value={newToolName}
              onChange={(e) => setNewToolName(e.target.value)}
            />
          </div>
          <textarea
            className="w-full border border-border rounded bg-surface px-2.5 py-1.5 text-xs text-foreground placeholder:text-foreground-muted focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none resize-y mb-2 font-mono"
            rows={2}
            placeholder="绝对路径，每行一个"
            value={newToolPaths}
            onChange={(e) => setNewToolPaths(e.target.value)}
          />
          <Button variant="primary" onClick={handleAddCustom} disabled={busy} size="sm">
            添加
          </Button>
        </div>
      </section>

      <section className="mb-8">
        <div className="flex items-center gap-2 mb-4">
          <Database className="h-4 w-4 text-foreground-secondary" />
          <h2 className="text-sm font-semibold">备份</h2>
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
        skill-switch v0.1.0
      </div>
    </div>
  )
}

function ToolPanel({
  tool,
  editingPaths,
  onEditingPathsChange,
  onToggle,
  onSavePaths,
  onRemove,
  busy
}: {
  tool: ToolConfigView
  editingPaths: string
  onEditingPathsChange: (v: string) => void
  onToggle: (key: string, enabled: boolean) => void
  onSavePaths: (key: string) => void
  onRemove: (key: string) => void
  busy: boolean
}) {
  return (
    <li
      className={`border rounded-md p-3 ${
        tool.enabled ? 'border-border' : 'border-border bg-surface-secondary opacity-70'
      }`}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{tool.displayName}</span>
          {tool.isCustom && (
            <span className="text-2xs px-1.5 py-0.5 rounded-full bg-primary-subtle text-primary font-medium">
              自定义
            </span>
          )}
          <StatusDot
            variant={tool.exists ? 'success' : 'neutral'}
            label={tool.exists ? '已发现' : '缺失'}
          />
        </div>
        {!tool.isCustom && (
          <label className="flex items-center gap-2 text-xs cursor-pointer text-foreground-secondary">
            <input
              type="checkbox"
              checked={tool.enabled}
              onChange={(e) => onToggle(tool.key, e.target.checked)}
              disabled={busy}
              className="rounded border-border"
            />
            {tool.enabled ? '已启用' : '已禁用'}
          </label>
        )}
      </div>
      <textarea
        className="w-full border border-border rounded bg-surface px-2.5 py-1.5 text-xs text-foreground placeholder:text-foreground-muted focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none resize-y mb-2 font-mono"
        rows={Math.max(1, editingPaths.split('\n').length)}
        value={editingPaths}
        onChange={(e) => onEditingPathsChange(e.target.value)}
      />
      <div className="flex items-center gap-2">
        <Button variant="secondary" onClick={() => onSavePaths(tool.key)} disabled={busy} size="sm">
          保存路径
        </Button>
        {tool.isCustom && (
          <Button variant="danger" onClick={() => onRemove(tool.key)} disabled={busy} size="sm">
            移除
          </Button>
        )}
      </div>
    </li>
  )
}
