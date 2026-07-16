import { useState, useEffect, useCallback } from 'react'
import { Wrench, Database, Monitor, FolderTree } from 'lucide-react'
import { Button, Input, StatusDot } from '../../shared'

type SettingsView = Awaited<ReturnType<typeof window.api.getSettings>>
type ToolConfigView = SettingsView['tools'][number]
type SourceRootView = Awaited<ReturnType<typeof window.api.getSourceRoots>>[number]
type SkillLibraryView = Awaited<ReturnType<typeof window.api.getSkillLibrary>>

export function SettingsPage() {
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [busy, setBusy] = useState(false)
  const [newToolKey, setNewToolKey] = useState('')
  const [newToolName, setNewToolName] = useState('')
  const [newToolPaths, setNewToolPaths] = useState('')
  const [editingPaths, setEditingPaths] = useState<Record<string, string>>({})
  const [retention, setRetention] = useState<number>(20)
  const [sourceRoots, setSourceRoots] = useState<SourceRootView[]>([])
  const [skillLibrary, setSkillLibrary] = useState<SkillLibraryView | null>(null)
  const [sourceRootBusy, setSourceRootBusy] = useState(false)
  const [sourceRootMessage, setSourceRootMessage] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [s, roots, library] = await Promise.all([
      window.api.getSettings(),
      window.api.getSourceRoots(),
      window.api.getSkillLibrary()
    ])
    setSettings(s)
    setSourceRoots(roots)
    setSkillLibrary(library)
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

  const refreshSourceRoots = async () => {
    setSourceRoots(await window.api.getSourceRoots())
  }

  const handleAddSourceRoot = async () => {
    const path = await window.api.selectLocalDir()
    if (!path) return
    setSourceRootBusy(true)
    setSourceRootMessage(null)
    try {
      const result = await window.api.registerSourceRoot(path)
      await refreshSourceRoots()
      setSourceRootMessage(`已登记候选来源目录，发现 ${result.discovered} 个 Skill`)
    } catch (error) {
      setSourceRootMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setSourceRootBusy(false)
    }
  }

  const handleRescanSourceRoot = async (rootId: number) => {
    setSourceRootBusy(true)
    setSourceRootMessage(null)
    try {
      const result = await window.api.rescanSourceRoot(rootId)
      await refreshSourceRoots()
      setSourceRootMessage(`重新扫描完成：发现 ${result.discovered} 个，移除 ${result.removed} 条失效来源`)
    } catch (error) {
      setSourceRootMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setSourceRootBusy(false)
    }
  }

  const handleDetachSourceRoot = async (root: SourceRootView) => {
    if (!window.confirm(`解除登记「${root.path}」？\n不会删除候选目录中的任何文件。`)) return
    setSourceRootBusy(true)
    setSourceRootMessage(null)
    try {
      const result = await window.api.detachSourceRoot(root.id)
      await refreshSourceRoots()
      setSourceRootMessage(`已解除登记，移除 ${result.detachedSources} 条来源元数据；源码文件未删除`)
    } catch (error) {
      setSourceRootMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setSourceRootBusy(false)
    }
  }

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
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <FolderTree className="h-4 w-4 text-foreground-secondary" />
            <h2 className="text-sm font-semibold">候选来源目录</h2>
          </div>
          <Button variant="primary" onClick={handleAddSourceRoot} disabled={sourceRootBusy} size="sm">
            登记候选目录
          </Button>
        </div>
        <p className="text-xs text-foreground-secondary mb-3">
          递归发现待整理的 Skill，但不复制、不移动，也不会自动部署到任何工具。
        </p>
        {sourceRootMessage && (
          <div className="mb-3 px-3 py-2 rounded border border-border bg-surface-secondary text-xs text-foreground-secondary">
            {sourceRootMessage}
          </div>
        )}
        {sourceRoots.length === 0 ? (
          <div className="border border-dashed border-border rounded-md p-4 text-xs text-foreground-muted">
            尚未登记候选来源目录。
          </div>
        ) : (
          <ul className="space-y-2">
            {sourceRoots.map((root) => (
              <li key={root.id} className="border border-border rounded-md p-3">
                <div className="font-mono text-xs text-foreground break-all">{root.path}</div>
                <div className="text-2xs text-foreground-muted mt-1 mb-2">
                  {root.last_scanned_at
                    ? `上次扫描：${new Date(root.last_scanned_at).toLocaleString()}`
                    : '尚未扫描'}
                </div>
                {root.last_scan_error && (
                  <div className="text-2xs text-danger mb-2 break-all">
                    扫描失败：{root.last_scan_error}
                  </div>
                )}
                <div className="flex gap-2">
                  <Button variant="secondary" size="sm" disabled={sourceRootBusy} onClick={() => handleRescanSourceRoot(root.id)}>
                    重新扫描
                  </Button>
                  <Button variant="danger" size="sm" disabled={sourceRootBusy} onClick={() => handleDetachSourceRoot(root)}>
                    解除登记
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
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
