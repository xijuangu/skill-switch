import { useState, useEffect, useCallback } from 'react'

type ScanResult = Awaited<ReturnType<typeof window.api.scan>>
type SkillView = Awaited<ReturnType<typeof window.api.getSkills>>[number]
type SkillSourceView = SkillView['sources'][number]
type SettingsView = Awaited<ReturnType<typeof window.api.getSettings>>
type ToolConfigView = SettingsView['tools'][number]
type BackupView = Awaited<ReturnType<typeof window.api.listBackups>>[number]

type Page = 'skills' | 'tools' | 'backups' | 'settings'

export default function App() {
  const [page, setPage] = useState<Page>('skills')
  const [skills, setSkills] = useState<SkillView[]>([])
  const [scanning, setScanning] = useState(false)
  const [lastScan, setLastScan] = useState<ScanResult | null>(null)

  const refresh = useCallback(async () => {
    const result = await window.api.getSkills()
    setSkills(result)
  }, [])

  useEffect(() => {
    if (page === 'skills') {
      refresh()
    }
  }, [page, refresh])

  const handleScan = async () => {
    setScanning(true)
    try {
      const result = await window.api.scan()
      setLastScan(result)
      await refresh()
    } finally {
      setScanning(false)
    }
  }

  return (
    <div className="min-h-screen flex">
      <nav className="w-48 shrink-0 bg-neutral-100 border-r border-neutral-200 p-4">
        <h1 className="font-bold text-lg mb-6">skill-switch</h1>
        <ul className="space-y-1">
          <NavItem page="skills" current={page} onClick={setPage} label="Skills" />
          <NavItem page="tools" current={page} onClick={setPage} label="Tools" disabled />
          <NavItem page="backups" current={page} onClick={setPage} label="Backups" />
          <NavItem page="settings" current={page} onClick={setPage} label="Settings" />
        </ul>
      </nav>

      <main className="flex-1 p-6 overflow-auto">
        {page === 'skills' && (
          <SkillsPage
            skills={skills}
            scanning={scanning}
            lastScan={lastScan}
            onScan={handleScan}
          />
        )}
        {page === 'settings' && <SettingsPage />}
        {page === 'tools' && <Placeholder label="Tools" />}
        {page === 'backups' && <BackupsPage />}
      </main>
    </div>
  )
}

function NavItem({
  page,
  current,
  onClick,
  label,
  disabled
}: {
  page: Page
  current: Page
  onClick: (p: Page) => void
  label: string
  disabled?: boolean
}) {
  if (disabled) {
    return <li className="px-2 py-1 text-neutral-400">{label}</li>
  }
  const active = current === page
  return (
    <li
      onClick={() => onClick(page)}
      className={`px-2 py-1 rounded cursor-pointer font-medium ${
        active ? 'bg-blue-100 text-blue-800' : 'text-neutral-700 hover:bg-neutral-200'
      }`}
    >
      {label}
    </li>
  )
}

function Placeholder({ label }: { label: string }) {
  return (
    <div>
      <h2 className="text-xl font-semibold mb-4">{label}</h2>
      <p className="text-neutral-400">{label} 页面将在后续切片实现。</p>
    </div>
  )
}

function BackupsPage() {
  const [backups, setBackups] = useState<BackupView[]>([])
  const [retention, setRetention] = useState<number>(20)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [list, settings] = await Promise.all([
      window.api.listBackups(),
      window.api.getSettings()
    ])
    setBackups(list)
    setRetention(settings.backupRetention)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const handleRestore = async (backupId: string, skillName: string) => {
    if (
      !window.confirm(
        `Restore backup "${skillName}" to its original path?\n\n` +
          'If the target path already has content, a safety-net backup will be created first, then the target will be overwritten.'
      )
    ) {
      return
    }
    setBusyId(backupId)
    setError(null)
    try {
      await window.api.restoreBackup(backupId)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  const handleDelete = async (backupId: string, skillName: string) => {
    if (!window.confirm(`Delete backup "${skillName}"? This cannot be undone.`)) {
      return
    }
    setBusyId(backupId)
    setError(null)
    try {
      await window.api.deleteBackup(backupId)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold">Backups</h2>
        <span className="text-sm text-neutral-500">
          Retention: <span className="font-medium text-neutral-700">{retention}</span>
        </span>
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 rounded border border-red-200 bg-red-50 text-red-700 text-sm">
          {error}
        </div>
      )}

      {backups.length === 0 ? (
        <p className="text-neutral-400">暂无备份,覆盖部署或删除 skill 时会自动备份。</p>
      ) : (
        <ul className="space-y-2">
          {backups.map((b) => (
            <li
              key={b.backupId}
              className="border border-neutral-200 rounded-md p-3 flex items-center justify-between hover:bg-neutral-50"
            >
              <div className="flex flex-col gap-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{b.skillName}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-neutral-200 text-neutral-700">
                    {b.targetTool}
                  </span>
                </div>
                <div className="text-xs text-neutral-500 flex items-center gap-3">
                  <span>{new Date(b.backupTime).toLocaleString()}</span>
                  <code className="text-neutral-400" title={b.sourceHash}>
                    {b.sourceHash.slice(0, 8)}
                  </code>
                </div>
                <div className="text-xs text-neutral-400 truncate" title={b.sourcePath}>
                  {b.sourcePath}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0 ml-3">
                <button
                  onClick={() => handleRestore(b.backupId, b.skillName)}
                  disabled={busyId !== null}
                  className="px-3 py-1 bg-neutral-700 text-white rounded text-xs hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Restore
                </button>
                <button
                  onClick={() => handleDelete(b.backupId, b.skillName)}
                  disabled={busyId !== null}
                  className="px-3 py-1 bg-red-600 text-white rounded text-xs hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function SkillsPage({
  skills,
  scanning,
  lastScan,
  onScan
}: {
  skills: SkillView[]
  scanning: boolean
  lastScan: ScanResult | null
  onScan: () => void
}) {
  // 展开的 skill id 集合(点击行切换)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  // 部署前冲突选择 modal:正在为其选 source 的 skill
  const [conflictTarget, setConflictTarget] = useState<SkillView | null>(null)
  // "已选 source,可继续部署" 的提示(skillId → 已选 source path)
  const [resolved, setResolved] = useState<Record<number, string>>({})

  const toggleExpand = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const conflictCount = skills.filter((s) => s.conflict.hasConflict).length

  const handleDeployClick = (skill: SkillView) => {
    if (skill.conflict.hasConflict) {
      // 多 source 内容冲突 → 弹窗让用户选
      setConflictTarget(skill)
    } else {
      // 一致或单 source → 默认取 primarySource,不弹窗
      const primary = skill.conflict.primarySource
      if (primary) {
        setResolved((prev) => ({ ...prev, [skill.id]: primary.path }))
      }
    }
  }

  const handleConflictConfirm = (source: SkillSourceView) => {
    if (!conflictTarget) return
    setResolved((prev) => ({ ...prev, [conflictTarget.id]: source.path }))
    setConflictTarget(null)
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold">Skills</h2>
          {conflictCount > 0 && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-300">
              {conflictCount} conflict{conflictCount > 1 ? 's' : ''}
            </span>
          )}
        </div>
        <button
          onClick={onScan}
          disabled={scanning}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
        >
          {scanning ? 'Scanning…' : 'Scan'}
        </button>
      </div>

      {lastScan && (
        <div className="text-sm text-neutral-500 mb-4">
          <p>
            Scanned {lastScan.totalScanned} skill(s), upserted {lastScan.totalUpserted}.
          </p>
          {lastScan.tools.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {lastScan.tools.map((t) => (
                <li key={`${t.key}:${t.path}`} className="text-xs">
                  <span className="font-medium">{t.displayName}</span>{' '}
                  <code className="text-neutral-500">{t.path}</code> — {t.scanned} scanned
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {skills.length === 0 ? (
        <p className="text-neutral-400">
          No skills indexed yet. Click <span className="font-medium">Scan</span> to discover
          skills across all enabled tool directories.
        </p>
      ) : (
        <ul className="space-y-2">
          {skills.map((skill) => (
            <SkillRow
              key={skill.id}
              skill={skill}
              expanded={expanded.has(skill.id)}
              onToggleExpand={() => toggleExpand(skill.id)}
              onDeploy={() => handleDeployClick(skill)}
              resolvedPath={resolved[skill.id]}
            />
          ))}
        </ul>
      )}

      {conflictTarget && (
        <ConflictModal
          skill={conflictTarget}
          onCancel={() => setConflictTarget(null)}
          onConfirm={handleConflictConfirm}
        />
      )}
    </div>
  )
}

function SkillRow({
  skill,
  expanded,
  onToggleExpand,
  onDeploy,
  resolvedPath
}: {
  skill: SkillView
  expanded: boolean
  onToggleExpand: () => void
  onDeploy: () => void
  resolvedPath: string | undefined
}) {
  const conflict = skill.conflict.hasConflict
  return (
    <li className="border border-neutral-200 rounded-md">
      <div
        className="flex items-center justify-between p-3 hover:bg-neutral-50 cursor-pointer"
        onClick={onToggleExpand}
      >
        <div className="flex items-center gap-2">
          <span className="text-neutral-400 text-xs select-none">{expanded ? '▼' : '▶'}</span>
          <span className="font-medium">{skill.name}</span>
          {skill.sources[0] && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-neutral-200 text-neutral-700">
              {skill.sources[0].source_type}
            </span>
          )}
          {conflict && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-300">
              conflict
            </span>
          )}
        </div>
        <div className="flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
          <span className="text-xs text-neutral-400">
            {skill.sources.length} source(s)
          </span>
          <button
            onClick={onDeploy}
            className="px-3 py-1 bg-neutral-700 text-white rounded text-xs hover:bg-neutral-800"
          >
            Deploy to…
          </button>
        </div>
      </div>

      {resolvedPath && (
        <div className="px-3 py-2 bg-green-50 border-t border-green-200 text-xs text-green-800">
          ✓ Source selected: <code>{resolvedPath}</code> — deploy action will be added in a later slice.
        </div>
      )}

      {expanded && (
        <div className="border-t border-neutral-200 bg-neutral-50 p-3">
          <h4 className="text-xs font-semibold text-neutral-500 uppercase mb-2">Sources</h4>
          {skill.sources.length === 0 ? (
            <p className="text-xs text-neutral-400">No sources registered.</p>
          ) : (
            <ul className="space-y-1.5">
              {skill.sources.map((src) => (
                <li key={src.id} className="text-xs grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 items-start">
                  <span className="text-neutral-500">path</span>
                  <code className="text-neutral-700 break-all">{src.path}</code>
                  <span className="text-neutral-500">hash</span>
                  <code className="text-neutral-700 break-all">{src.hash}</code>
                  <span className="text-neutral-500">mtime</span>
                  <span className="text-neutral-700">{new Date(src.mtime).toISOString()}</span>
                  <span className="text-neutral-500">source_type</span>
                  <span className="text-neutral-700">{src.source_type}</span>
                  <span className="text-neutral-500">discovered_at</span>
                  <span className="text-neutral-700">{src.discovered_at}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  )
}

function ConflictModal({
  skill,
  onCancel,
  onConfirm
}: {
  skill: SkillView
  onCancel: () => void
  onConfirm: (source: SkillSourceView) => void
}) {
  const [selectedId, setSelectedId] = useState<number | null>(null)
  // 把相同 hash 归一组,UI 上标"内容一致"
  const hashGroups = new Map<string, SkillSourceView[]>()
  for (const s of skill.sources) {
    const arr = hashGroups.get(s.hash) ?? []
    arr.push(s)
    hashGroups.set(s.hash, arr)
  }
  const distinctVersions = hashGroups.size

  const handleConfirm = () => {
    const picked = skill.sources.find((s) => s.id === selectedId)
    if (picked) onConfirm(picked)
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      onClick={onCancel}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[80vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-neutral-200">
          <h3 className="text-lg font-semibold">Resolve source conflict</h3>
          <p className="text-sm text-neutral-600 mt-1">
            检测到 {distinctVersions} 个版本的 <span className="font-medium">{skill.name}</span>
            ,请选择使用哪个版本。
          </p>
          <p className="text-xs text-neutral-400 mt-1">
            共 {skill.sources.length} 个 source path,{skill.conflict.distinctHashCount} 种不同内容(hash)。
          </p>
        </div>

        <div className="p-4 space-y-2">
          {skill.sources.map((src) => {
            const sameHashCount = hashGroups.get(src.hash)?.length ?? 1
            return (
              <label
                key={src.id}
                className={`block border rounded-md p-3 cursor-pointer transition-colors ${
                  selectedId === src.id
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-neutral-200 hover:bg-neutral-50'
                }`}
              >
                <div className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="conflict-source"
                    value={src.id}
                    checked={selectedId === src.id}
                    onChange={() => setSelectedId(src.id)}
                    className="mt-1"
                  />
                  <div className="flex-1 min-w-0 text-xs">
                    <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
                      <span className="text-neutral-500">path</span>
                      <code className="text-neutral-700 break-all">{src.path}</code>
                      <span className="text-neutral-500">hash</span>
                      <code className="text-neutral-700 break-all">{src.hash}</code>
                      <span className="text-neutral-500">mtime</span>
                      <span className="text-neutral-700">{new Date(src.mtime).toISOString()}</span>
                      <span className="text-neutral-500">source_type</span>
                      <span className="text-neutral-700">{src.source_type}</span>
                    </div>
                    {sameHashCount > 1 && (
                      <p className="mt-1 text-neutral-400">
                        (内容与另外 {sameHashCount - 1} 个 source 一致)
                      </p>
                    )}
                  </div>
                </div>
              </label>
            )
          })}
        </div>

        <div className="p-4 border-t border-neutral-200 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-neutral-700 hover:bg-neutral-100 rounded"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={selectedId === null}
            className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Use this source
          </button>
        </div>
      </div>
    </div>
  )
}

function SettingsPage() {
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [busy, setBusy] = useState(false)
  const [newTool, setNewTool] = useState({ key: '', displayName: '', paths: '' })
  const [editingPaths, setEditingPaths] = useState<Record<string, string>>({})
  const [retention, setRetention] = useState<number>(20)

  const load = useCallback(async () => {
    const s = await window.api.getSettings()
    setSettings(s)
    setRetention(s.backupRetention)
    const next: Record<string, string> = {}
    for (const t of s.tools) {
      next[t.key] = t.paths.join('\n')
    }
    setEditingPaths(next)
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
      const next: Record<string, string> = {}
      for (const t of s.tools) {
        next[t.key] = t.paths.join('\n')
      }
      setEditingPaths(next)
    } finally {
      setBusy(false)
    }
  }

  const handleToggle = (key: string, enabled: boolean) =>
    run(() => window.api.setPresetEnabled(key, enabled))

  const handleSavePaths = (key: string) => {
    const raw = editingPaths[key] ?? ''
    const paths = raw
      .split('\n')
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
    run(() => window.api.setPresetPaths(key, paths))
  }

  const handleAddCustom = () => {
    const paths = newTool.paths
      .split('\n')
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
    if (!newTool.key.trim() || !newTool.displayName.trim() || paths.length === 0) return
    run(() =>
      window.api.addCustomTool({
        key: newTool.key.trim(),
        displayName: newTool.displayName.trim(),
        paths
      })
    ).then(() => setNewTool({ key: '', displayName: '', paths: '' }))
  }

  const handleRemoveCustom = (key: string) =>
    run(() => window.api.removeCustomTool(key))

  const handleSaveRetention = () =>
    run(() => window.api.setBackupRetention(retention))

  if (!settings) {
    return <p className="text-neutral-400">Loading settings…</p>
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h2 className="text-xl font-semibold mb-4">Tools</h2>
        <ul className="space-y-3">
          {settings.tools.map((tool) => (
            <ToolPanel
              key={tool.key}
              tool={tool}
              editingPaths={editingPaths[tool.key] ?? ''}
              onEditingPathsChange={(v) =>
                setEditingPaths({ ...editingPaths, [tool.key]: v })
              }
              onToggle={handleToggle}
              onSavePaths={handleSavePaths}
              onRemove={handleRemoveCustom}
              busy={busy}
            />
          ))}
        </ul>

        <div className="mt-4 border border-dashed border-neutral-300 rounded-md p-3">
          <h3 className="font-medium mb-2 text-sm">Add custom tool</h3>
          <div className="grid grid-cols-2 gap-2 mb-2">
            <input
              className="border border-neutral-300 rounded px-2 py-1 text-sm"
              placeholder="key (e.g. mytool)"
              value={newTool.key}
              onChange={(e) => setNewTool({ ...newTool, key: e.target.value })}
            />
            <input
              className="border border-neutral-300 rounded px-2 py-1 text-sm"
              placeholder="Display name"
              value={newTool.displayName}
              onChange={(e) => setNewTool({ ...newTool, displayName: e.target.value })}
            />
          </div>
          <textarea
            className="w-full border border-neutral-300 rounded px-2 py-1 text-sm mb-2"
            rows={2}
            placeholder="Absolute path(s), one per line"
            value={newTool.paths}
            onChange={(e) => setNewTool({ ...newTool, paths: e.target.value })}
          />
          <button
            onClick={handleAddCustom}
            disabled={busy}
            className="px-3 py-1 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </div>

      <div>
        <h2 className="text-xl font-semibold mb-4">Backup</h2>
        <label className="block text-sm text-neutral-600 mb-1">
          Backup retention (number of backups to keep)
        </label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            className="border border-neutral-300 rounded px-2 py-1 text-sm w-24"
            value={retention}
            onChange={(e) => setRetention(Number(e.target.value))}
          />
          <button
            onClick={handleSaveRetention}
            disabled={busy}
            className="px-3 py-1 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>

      <div>
        <h2 className="text-xl font-semibold mb-4">Platform capability</h2>
        <div className="border border-neutral-200 rounded-md p-3 text-sm space-y-1">
          <div>
            <span className="text-neutral-500">platform:</span>{' '}
            <code>{settings.platform.platform}</code>
          </div>
          <div>
            <span className="text-neutral-500">canSymlink:</span>{' '}
            <span className={settings.platform.canSymlink ? 'text-green-600' : 'text-red-600'}>
              {String(settings.platform.canSymlink)}
            </span>
          </div>
          <div>
            <span className="text-neutral-500">canJunction:</span>{' '}
            <span className={settings.platform.canJunction ? 'text-green-600' : 'text-red-600'}>
              {String(settings.platform.canJunction)}
            </span>
          </div>
        </div>
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
        tool.enabled ? 'border-neutral-200' : 'border-neutral-200 bg-neutral-50 opacity-70'
      }`}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="font-medium">{tool.displayName}</span>
          {tool.isCustom && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">
              custom
            </span>
          )}
          <span
            className={`text-xs px-2 py-0.5 rounded-full ${
              tool.exists
                ? 'bg-green-100 text-green-700'
                : 'bg-neutral-200 text-neutral-500'
            }`}
          >
            {tool.exists ? 'found' : 'missing'}
          </span>
        </div>
        {!tool.isCustom && (
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={tool.enabled}
              onChange={(e) => onToggle(tool.key, e.target.checked)}
              disabled={busy}
            />
            <span>{tool.enabled ? 'enabled' : 'disabled'}</span>
          </label>
        )}
      </div>
      <textarea
        className="w-full border border-neutral-300 rounded px-2 py-1 text-sm mb-2"
        rows={Math.max(1, editingPaths.split('\n').length)}
        value={editingPaths}
        onChange={(e) => onEditingPathsChange(e.target.value)}
      />
      <div className="flex items-center gap-2">
        <button
          onClick={() => onSavePaths(tool.key)}
          disabled={busy}
          className="px-3 py-1 bg-neutral-700 text-white rounded text-xs hover:bg-neutral-800 disabled:opacity-50"
        >
          Save paths
        </button>
        {tool.isCustom && (
          <button
            onClick={() => onRemove(tool.key)}
            disabled={busy}
            className="px-3 py-1 bg-red-600 text-white rounded text-xs hover:bg-red-700 disabled:opacity-50"
          >
            Remove
          </button>
        )}
      </div>
    </li>
  )
}
