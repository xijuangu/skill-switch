import { useState, useEffect, useCallback } from 'react'

type ScanResult = Awaited<ReturnType<typeof window.api.scan>>
type SkillView = Awaited<ReturnType<typeof window.api.getSkills>>[number]
type SkillSourceView = SkillView['sources'][number]
type SettingsView = Awaited<ReturnType<typeof window.api.getSettings>>
type ToolConfigView = SettingsView['tools'][number]
type BackupView = Awaited<ReturnType<typeof window.api.listBackups>>[number]
type DeployResultView = Awaited<ReturnType<typeof window.api.deploy>>
type ToolWithDriftsView = Awaited<ReturnType<typeof window.api.getTools>>[number]
type DriftStatusView = ToolWithDriftsView['drifts'][number]
type InstallResultView = Awaited<ReturnType<typeof window.api.installFromGitHub>>

type Page = 'skills' | 'tools' | 'backups' | 'settings'
type DeployMode = 'copy' | 'symlink'

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
          <NavItem page="tools" current={page} onClick={setPage} label="Tools" />
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
            onRefresh={refresh}
          />
        )}
        {page === 'settings' && <SettingsPage />}
        {page === 'tools' && <ToolsPage />}
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

// ===== Skills 页 =====

function SkillsPage({
  skills,
  scanning,
  lastScan,
  onScan,
  onRefresh
}: {
  skills: SkillView[]
  scanning: boolean
  lastScan: ScanResult | null
  onScan: () => void
  onRefresh: () => void
}) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  // 冲突选择 modal
  const [conflictTarget, setConflictTarget] = useState<SkillView | null>(null)
  // 已选 source 的 skill(冲突解决后或无冲突时直接选 primary)
  const [resolvedSource, setResolvedSource] = useState<Record<number, string>>({})
  // Deploy dialog:正在部署的 skill + 已选 source path
  const [deployTarget, setDeployTarget] = useState<{ skill: SkillView; sourcePath: string } | null>(null)
  // Install dialog
  const [installOpen, setInstallOpen] = useState(false)
  // 反馈消息
  const [feedback, setFeedback] = useState<string | null>(null)
  // #8: 右键上下文菜单
  const [contextMenu, setContextMenu] = useState<{ skill: SkillView; x: number; y: number } | null>(null)
  // #8: View SKILL.md 弹窗
  const [viewMdTarget, setViewMdTarget] = useState<{ content: string; path: string; skillName: string } | null>(null)
  // #8: Undeploy from... 对话框(列出该 skill 已部署到的工具)
  const [undeployFromTarget, setUndeployFromTarget] = useState<{ skill: SkillView; deployments: { target_tool: string; mode: string }[] } | null>(null)
  // #8: Remove from Registry 确认
  const [removeRegistryTarget, setRemoveRegistryTarget] = useState<SkillView | null>(null)
  // #8: 操作进行中(禁用菜单)
  const [actionBusy, setActionBusy] = useState(false)

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
      setConflictTarget(skill)
    } else {
      const primary = skill.conflict.primarySource
      if (primary) {
        setDeployTarget({ skill, sourcePath: primary.path })
      }
    }
  }

  const handleConflictConfirm = (source: SkillSourceView) => {
    if (!conflictTarget) return
    setDeployTarget({ skill: conflictTarget, sourcePath: source.path })
    setConflictTarget(null)
  }

  const handleDeployDone = async (result: DeployResultView | null) => {
    setDeployTarget(null)
    if (result) {
      // #9: junction fallback / copy 降级时在反馈消息里提示
      const degradeNote =
        result.degradedFrom != null
          ? ` (requested ${result.degradedFrom}, used ${result.mode}: ${result.degradeReason ?? 'fallback applied'})`
          : ''
      const msg =
        result.action === 'skipped'
          ? `Skipped — ${result.targetPath} is already up to date.`
          : `Deployed (${result.action}) to ${result.targetPath}${degradeNote}`
      setFeedback(msg)
      await onRefresh()
      setTimeout(() => setFeedback(null), 6000)
    }
  }

  const handleInstallDone = async (result: InstallResultView | null) => {
    setInstallOpen(false)
    if (result) {
      const msg = result.overwritten
        ? `Installed "${result.skillName}" (overwrote existing, backup created).`
        : `Installed "${result.skillName}".`
      setFeedback(msg)
      await onRefresh()
      setTimeout(() => setFeedback(null), 5000)
    }
  }

  // #8: 右键菜单 — 5 个操作
  const handleContextMenu = (e: React.MouseEvent, skill: SkillView) => {
    e.preventDefault()
    setContextMenu({ skill, x: e.clientX, y: e.clientY })
  }

  // View SKILL.md
  const handleViewMd = async (skill: SkillView) => {
    setContextMenu(null)
    setActionBusy(true)
    try {
      const result = await window.api.viewSkillMd(skill.id)
      if (result) {
        setViewMdTarget({ ...result, skillName: skill.name })
      } else {
        setFeedback(`No SKILL.md found for "${skill.name}".`)
        setTimeout(() => setFeedback(null), 4000)
      }
    } finally {
      setActionBusy(false)
    }
  }

  // Undeploy from... — 先拉部署列表再弹对话框
  const handleUndeployFromInit = async (skill: SkillView) => {
    setContextMenu(null)
    setActionBusy(true)
    try {
      const deployments = await window.api.getDeploymentsForSkill(skill.id)
      if (deployments.length === 0) {
        setFeedback(`"${skill.name}" is not deployed to any tool.`)
        setTimeout(() => setFeedback(null), 4000)
        return
      }
      setUndeployFromTarget({ skill, deployments })
    } finally {
      setActionBusy(false)
    }
  }

  // Remove from Registry — 彻底删除(与 Undeploy 明确分开)
  const handleRemoveFromRegistry = (skill: SkillView) => {
    setContextMenu(null)
    setRemoveRegistryTarget(skill)
  }

  const handleRemoveFromRegistryConfirm = async () => {
    if (!removeRegistryTarget) return
    setActionBusy(true)
    setFeedback(null)
    try {
      const result = await window.api.removeFromRegistry(removeRegistryTarget.id)
      const msg = result.backedUp
        ? `Removed "${result.skillName}" from registry (backed up, undeployed from ${result.undeployedTools.length} tool(s)).`
        : `Removed "${result.skillName}" from registry (undeployed from ${result.undeployedTools.length} tool(s), no central entity to back up).`
      setFeedback(msg)
      await onRefresh()
      setTimeout(() => setFeedback(null), 6000)
    } catch (e) {
      setFeedback(e instanceof Error ? e.message : String(e))
      setTimeout(() => setFeedback(null), 6000)
    } finally {
      setRemoveRegistryTarget(null)
      setActionBusy(false)
    }
  }

  const handleUndeployFromTool = async (targetTool: string) => {
    if (!undeployFromTarget) return
    if (!window.confirm(`Undeploy "${undeployFromTarget.skill.name}" from ${targetTool}?`)) return
    setActionBusy(true)
    try {
      await window.api.undeploy(undeployFromTarget.skill.id, targetTool)
      // 刷新部署列表(可能还有别的工具)
      const remaining = await window.api.getDeploymentsForSkill(undeployFromTarget.skill.id)
      if (remaining.length === 0) {
        setUndeployFromTarget(null)
      } else {
        setUndeployFromTarget({ ...undeployFromTarget, deployments: remaining })
      }
      await onRefresh()
    } catch (e) {
      setFeedback(e instanceof Error ? e.message : String(e))
      setTimeout(() => setFeedback(null), 5000)
    } finally {
      setActionBusy(false)
    }
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
        <div className="flex items-center gap-2">
          <button
            onClick={() => setInstallOpen(true)}
            className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 text-sm font-medium"
          >
            Install
          </button>
          <button
            onClick={onScan}
            disabled={scanning}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
          >
            {scanning ? 'Scanning…' : 'Scan'}
          </button>
        </div>
      </div>

      {feedback && (
        <div className="mb-4 px-3 py-2 rounded border border-green-200 bg-green-50 text-green-700 text-sm">
          {feedback}
        </div>
      )}

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
          skills across all enabled tool directories, or <span className="font-medium">Install</span> to add from GitHub / ZIP / local dir.
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
              onContextMenu={(e) => handleContextMenu(e, skill)}
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

      {deployTarget && (
        <DeployDialog
          skill={deployTarget.skill}
          sourcePath={deployTarget.sourcePath}
          onDone={handleDeployDone}
        />
      )}

      {installOpen && <InstallDialog onDone={handleInstallDone} />}

      {/* #8: 右键上下文菜单 — 5 个操作 */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          busy={actionBusy}
          onDeploy={() => {
            const skill = contextMenu.skill
            setContextMenu(null)
            handleDeployClick(skill)
          }}
          onUndeployFrom={() => handleUndeployFromInit(contextMenu.skill)}
          onViewSources={() => {
            toggleExpand(contextMenu.skill.id)
            setContextMenu(null)
          }}
          onViewMd={() => handleViewMd(contextMenu.skill)}
          onRemoveFromRegistry={() => handleRemoveFromRegistry(contextMenu.skill)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* #8: View SKILL.md 弹窗 */}
      {viewMdTarget && (
        <ViewMdModal
          skillName={viewMdTarget.skillName}
          content={viewMdTarget.content}
          path={viewMdTarget.path}
          onClose={() => setViewMdTarget(null)}
        />
      )}

      {/* #8: Undeploy from... 对话框(列出该 skill 已部署到的工具) */}
      {undeployFromTarget && (
        <UndeployFromDialog
          skill={undeployFromTarget.skill}
          deployments={undeployFromTarget.deployments}
          busy={actionBusy}
          onUndeploy={handleUndeployFromTool}
          onClose={() => setUndeployFromTarget(null)}
        />
      )}

      {/* #8: Remove from Registry 确认对话框 */}
      {removeRegistryTarget && (
        <RemoveFromRegistryConfirm
          skill={removeRegistryTarget}
          busy={actionBusy}
          onConfirm={handleRemoveFromRegistryConfirm}
          onCancel={() => setRemoveRegistryTarget(null)}
        />
      )}
    </div>
  )
}

/** #8: 右键上下文菜单 — 定位的悬浮菜单 + 5 个操作 */
function ContextMenu({
  x,
  y,
  busy,
  onDeploy,
  onUndeployFrom,
  onViewSources,
  onViewMd,
  onRemoveFromRegistry,
  onClose
}: {
  x: number
  y: number
  busy: boolean
  onDeploy: () => void
  onUndeployFrom: () => void
  onViewSources: () => void
  onViewMd: () => void
  onRemoveFromRegistry: () => void
  onClose: () => void
}) {
  // 点遮罩关闭;点菜单内不关闭(stopPropagation)
  const items: { label: string; onClick: () => void; danger?: boolean }[] = [
    { label: 'Deploy to…', onClick: onDeploy },
    { label: 'Undeploy from…', onClick: onUndeployFrom },
    { label: 'View Sources', onClick: onViewSources },
    { label: 'View SKILL.md', onClick: onViewMd },
    { label: 'Remove from Registry', onClick: onRemoveFromRegistry, danger: true }
  ]
  return (
    <div className="fixed inset-0 z-50" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }}>
      <div
        className="absolute bg-white border border-neutral-200 rounded-md shadow-lg py-1 min-w-[200px]"
        style={{ left: x, top: y }}
        onClick={(e) => e.stopPropagation()}
      >
        {items.map((item) => (
          <button
            key={item.label}
            onClick={item.onClick}
            disabled={busy}
            className={`block w-full text-left px-3 py-1.5 text-sm hover:bg-neutral-100 disabled:opacity-50 disabled:cursor-not-allowed ${
              item.danger ? 'text-red-600 hover:bg-red-50' : 'text-neutral-700'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** #8: View SKILL.md 弹窗(展示 SKILL.md 原文 + 文件路径) */
function ViewMdModal({
  skillName,
  content,
  path,
  onClose
}: {
  skillName: string
  content: string
  path: string
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-neutral-200">
          <h3 className="text-lg font-semibold">{skillName} — SKILL.md</h3>
          <p className="text-xs text-neutral-500 mt-1 truncate" title={path}>
            <code>{path}</code>
          </p>
        </div>
        <div className="flex-1 overflow-auto p-4">
          <pre className="text-sm text-neutral-800 whitespace-pre-wrap break-words font-mono">{content}</pre>
        </div>
        <div className="p-4 border-t border-neutral-200 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-neutral-700 hover:bg-neutral-100 rounded"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

/** #8: Undeploy from... 对话框(列出该 skill 已部署到的工具,逐个 Undeploy) */
function UndeployFromDialog({
  skill,
  deployments,
  busy,
  onUndeploy,
  onClose
}: {
  skill: SkillView
  deployments: { target_tool: string; mode: string }[]
  busy: boolean
  onUndeploy: (targetTool: string) => void
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      onClick={() => !busy && onClose()}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-lg w-full mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-neutral-200">
          <h3 className="text-lg font-semibold">Undeploy {skill.name} from…</h3>
          <p className="text-sm text-neutral-600 mt-1">
            {deployments.length} deployment(s). This only removes the deployment (link/copy), not the source.
          </p>
        </div>
        <div className="p-4 space-y-1.5 max-h-[50vh] overflow-auto">
          {deployments.map((d) => (
            <div
              key={d.target_tool}
              className="flex items-center justify-between border border-neutral-200 rounded px-3 py-2"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-sm font-medium">{d.target_tool}</span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-neutral-200 text-neutral-700">{d.mode}</span>
              </div>
              <button
                onClick={() => onUndeploy(d.target_tool)}
                disabled={busy}
                className="px-3 py-1 bg-red-600 text-white rounded text-xs hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Undeploy
              </button>
            </div>
          ))}
        </div>
        <div className="p-4 border-t border-neutral-200 flex justify-end">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 text-sm text-neutral-700 hover:bg-neutral-100 rounded disabled:opacity-50"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

/** #8: Remove from Registry 确认对话框(彻底移除 skill,删前备份) */
function RemoveFromRegistryConfirm({
  skill,
  busy,
  onConfirm,
  onCancel
}: {
  skill: SkillView
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      onClick={() => !busy && onCancel()}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-lg w-full mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-neutral-200">
          <h3 className="text-lg font-semibold text-red-700">Remove "{skill.name}" from Registry?</h3>
        </div>
        <div className="p-4 space-y-2 text-sm text-neutral-700">
          <p>
            This will <span className="font-medium text-red-700">permanently remove</span> the skill from the registry:
          </p>
          <ul className="list-disc list-inside space-y-1 text-neutral-600 ml-2">
            <li>Back up the central repo entity (if any) to the backups directory.</li>
            <li>Undeploy from all tools ({skill.sources.length} source(s) registered).</li>
            <li>Delete the skill record and all its sources from the registry.</li>
          </ul>
          <p className="text-xs text-neutral-500 mt-2">
            This cannot be undone. The backup is kept in the Backups page for manual restore.
          </p>
        </div>
        <div className="p-4 border-t border-neutral-200 flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 text-sm text-neutral-700 hover:bg-neutral-100 rounded disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="px-4 py-2 bg-red-600 text-white rounded text-sm hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? 'Removing…' : 'Remove from Registry'}
          </button>
        </div>
      </div>
    </div>
  )
}

function SkillRow({
  skill,
  expanded,
  onToggleExpand,
  onDeploy,
  onContextMenu
}: {
  skill: SkillView
  expanded: boolean
  onToggleExpand: () => void
  onDeploy: () => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  const conflict = skill.conflict.hasConflict
  return (
    <li className="border border-neutral-200 rounded-md">
      <div
        className="flex items-center justify-between p-3 hover:bg-neutral-50 cursor-pointer"
        onClick={onToggleExpand}
        onContextMenu={onContextMenu}
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
                  {src.repo_url && (
                    <>
                      <span className="text-neutral-500">repo</span>
                      <code className="text-neutral-700 break-all">{src.repo_url}</code>
                    </>
                  )}
                  {src.commit_sha && (
                    <>
                      <span className="text-neutral-500">sha</span>
                      <code className="text-neutral-700">{src.commit_sha.slice(0, 12)}</code>
                    </>
                  )}
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

// ===== Deploy 对话框(#6)=====

function DeployDialog({
  skill,
  sourcePath,
  onDone
}: {
  skill: SkillView
  sourcePath: string
  onDone: (result: DeployResultView | null) => void
}) {
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [selectedTool, setSelectedTool] = useState<string>('')
  const [mode, setMode] = useState<DeployMode>('copy')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.api.getSettings().then((s) => {
      setSettings(s)
      // 默认选第一个 enabled + existing 的工具
      const first = s.tools.find((t) => t.enabled && t.exists)
      if (first) setSelectedTool(first.key)
      // 平台支持 symlink 则默认 symlink,否则 copy
      setMode(s.platform.canSymlink ? 'symlink' : 'copy')
    })
  }, [])

  const availableTools = settings?.tools.filter((t) => t.enabled && t.exists) ?? []
  const canSymlink = settings?.platform.canSymlink ?? false
  const canJunction = settings?.platform.canJunction ?? false
  // #9: Windows 普通用户(canSymlink=false + canJunction=true)— symlink 不可用,
  //   选 symlink 时 deployer 自动尝试 junction;UI 标灰并提示开发者模式/管理员
  const isWindowsNormalUser = !canSymlink && canJunction

  const handleDeploy = async () => {
    if (!selectedTool) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.deploy(skill.id, selectedTool, mode, sourcePath)
      onDone(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      onClick={() => !busy && onDone(null)}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-lg w-full mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-neutral-200">
          <h3 className="text-lg font-semibold">Deploy {skill.name}</h3>
          <p className="text-sm text-neutral-600 mt-1">
            Source: <code className="text-xs break-all">{sourcePath}</code>
          </p>
        </div>

        <div className="p-4 space-y-4">
          {error && (
            <div className="px-3 py-2 rounded border border-red-200 bg-red-50 text-red-700 text-sm">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-1">Target tool</label>
            <select
              value={selectedTool}
              onChange={(e) => setSelectedTool(e.target.value)}
              disabled={busy}
              className="w-full border border-neutral-300 rounded px-2 py-1.5 text-sm"
            >
              {availableTools.length === 0 && (
                <option value="" disabled>No tools available (enable in Settings)</option>
              )}
              {availableTools.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.displayName} — {t.existingPaths[0]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-1">Mode</label>
            <div className="flex gap-3">
              <label
                className={`flex items-center gap-2 text-sm cursor-pointer ${!canSymlink ? 'opacity-50' : ''}`}
                title={
                  isWindowsNormalUser
                    ? '需要开启开发者模式或以管理员运行。选择此模式时将自动尝试 junction(仅限目录,同卷)。'
                    : canSymlink
                      ? ''
                      : 'symlink is unavailable on this platform'
                }
              >
                <input
                  type="radio"
                  name="deploy-mode"
                  value="symlink"
                  checked={mode === 'symlink'}
                  onChange={() => setMode('symlink')}
                  disabled={(!canSymlink && !canJunction) || busy}
                />
                <span>
                  symlink
                  {!canSymlink && (
                    <span className="text-xs text-neutral-400 ml-1">
                      {isWindowsNormalUser
                        ? '(需要开发者模式/管理员;选此将自动尝试 junction)'
                        : '(unavailable on this platform)'}
                    </span>
                  )}
                </span>
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="deploy-mode"
                  value="copy"
                  checked={mode === 'copy'}
                  onChange={() => setMode('copy')}
                  disabled={busy}
                />
                <span>copy</span>
              </label>
            </div>
            <p className="text-xs text-neutral-400 mt-1">
              {mode === 'symlink'
                ? isWindowsNormalUser
                  ? 'symlink 不可用 — 将自动尝试 junction(目录场景),失败则降级 copy。'
                  : 'Source updates auto-propagate (link is transparent).'
                : 'Snapshot copy — source updates require manual redeploy.'}
            </p>
          </div>
        </div>

        <div className="p-4 border-t border-neutral-200 flex justify-end gap-2">
          <button
            onClick={() => onDone(null)}
            disabled={busy}
            className="px-4 py-2 text-sm text-neutral-700 hover:bg-neutral-100 rounded disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleDeploy}
            disabled={busy || !selectedTool}
            className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? 'Deploying…' : 'Deploy'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ===== Tools 页(#6)=====

function ToolsPage() {
  const [tools, setTools] = useState<ToolWithDriftsView[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const result = await window.api.getTools()
    setTools(result)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const toggleExpand = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  const handleUndeploy = async (skillId: number, targetTool: string, skillName: string) => {
    if (!window.confirm(`Undeploy "${skillName}" from ${targetTool}?\n\nThis only removes the deployment (link/copy), not the source.`)) {
      return
    }
    setBusy(`${skillId}:${targetTool}`)
    setError(null)
    try {
      await window.api.undeploy(skillId, targetTool)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  // #8: 从清单移除(仅删 deployments 记录,不碰磁盘)— 用于 drift 状态(目标已被用户删了)
  const handleRemoveFromManifest = async (skillId: number, targetTool: string, skillName: string) => {
    if (!window.confirm(`Remove "${skillName}" from the deployment manifest for ${targetTool}?\n\nThe target is already gone from disk; this only cleans up the manifest record.`)) {
      return
    }
    setBusy(`${skillId}:${targetTool}`)
    setError(null)
    try {
      await window.api.removeFromManifest(skillId, targetTool)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const handleRedeploy = async (skillId: number, targetTool: string, skillName: string) => {
    setBusy(`${skillId}:${targetTool}`)
    setError(null)
    try {
      // 重新部署:用清单记录的 source_path 和 mode
      const tool = tools.find((t) => t.config.key === targetTool)
      const drift = tool?.drifts.find((d) => d.skillId === skillId)
      if (!drift?.deployment) {
        throw new Error('no deployment record to redeploy from')
      }
      await window.api.deploy(
        skillId,
        targetTool,
        drift.deployment.mode,
        drift.deployment.source_path
      )
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold">Tools</h2>
        <button
          onClick={load}
          className="px-3 py-1.5 bg-neutral-700 text-white rounded text-sm hover:bg-neutral-800"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 rounded border border-red-200 bg-red-50 text-red-700 text-sm">
          {error}
        </div>
      )}

      {tools.length === 0 ? (
        <p className="text-neutral-400">No tools configured. Visit Settings to enable tools.</p>
      ) : (
        <ul className="space-y-3">
          {tools.map((tool) => (
            <ToolCard
              key={tool.config.key}
              tool={tool}
              expanded={expanded.has(tool.config.key)}
              onToggleExpand={() => toggleExpand(tool.config.key)}
              onUndeploy={handleUndeploy}
              onRedeploy={handleRedeploy}
              onRemoveFromManifest={handleRemoveFromManifest}
              busyKey={busy}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function ToolCard({
  tool,
  expanded,
  onToggleExpand,
  onUndeploy,
  onRedeploy,
  onRemoveFromManifest,
  busyKey
}: {
  tool: ToolWithDriftsView
  expanded: boolean
  onToggleExpand: () => void
  onUndeploy: (skillId: number, targetTool: string, skillName: string) => void
  onRedeploy: (skillId: number, targetTool: string, skillName: string) => void
  onRemoveFromManifest: (skillId: number, targetTool: string, skillName: string) => void
  busyKey: string | null
}) {
  const { config, drifts } = tool
  // #8: 外部 skill 单独分区 — 不与自管部署混排
  const managed = drifts.filter((d) => d.kind !== 'external')
  const external = drifts.filter((d) => d.kind === 'external')
  const driftCount = managed.filter((d) => d.kind === 'drift' || d.kind === 'source-updated').length

  if (!config.enabled || !config.exists) {
    return (
      <li className={`border rounded-md p-3 ${config.enabled ? 'border-neutral-200' : 'border-neutral-200 bg-neutral-50 opacity-60'}`}>
        <div className="flex items-center gap-2">
          <span className="font-medium">{config.displayName}</span>
          {!config.exists && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-neutral-200 text-neutral-500">missing</span>
          )}
          {config.enabled && config.exists && (
            <span className="text-xs text-neutral-400">no skills dir</span>
          )}
        </div>
      </li>
    )
  }

  return (
    <li className="border border-neutral-200 rounded-md">
      <div
        className="flex items-center justify-between p-3 hover:bg-neutral-50 cursor-pointer"
        onClick={onToggleExpand}
      >
        <div className="flex items-center gap-2">
          <span className="text-neutral-400 text-xs select-none">{expanded ? '▼' : '▶'}</span>
          <span className="font-medium">{config.displayName}</span>
          <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">found</span>
          {driftCount > 0 && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-300">
              {driftCount} drift
            </span>
          )}
          {external.length > 0 && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">
              {external.length} external
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-neutral-400">
            {managed.length} deployed · {drifts.length} total
          </span>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-neutral-200 bg-neutral-50 p-3">
          <p className="text-xs text-neutral-400 mb-2">
            <code>{config.existingPaths[0]}</code>
          </p>
          {drifts.length === 0 ? (
            <p className="text-xs text-neutral-400">No skills in this tool directory.</p>
          ) : (
            <>
              {/* 自管部署分区(normal / source-updated / drift) */}
              {managed.length > 0 && (
                <ul className="space-y-1.5 mb-3">
                  {managed.map((d) => (
                    <DriftRow
                      key={`${d.skillId}:${d.skillName}`}
                      drift={d}
                      busy={busyKey === `${d.skillId}:${d.targetTool}`}
                      onUndeploy={() => onUndeploy(d.skillId, d.targetTool, d.skillName)}
                      onRedeploy={() => onRedeploy(d.skillId, d.targetTool, d.skillName)}
                      onRemoveFromManifest={() => onRemoveFromManifest(d.skillId, d.targetTool, d.skillName)}
                    />
                  ))}
                </ul>
              )}
              {/* #8: 外部 skill 单独分区(清单无记录,不自动纳入管理) */}
              {external.length > 0 && (
                <div className="border-t border-dashed border-neutral-300 pt-2">
                  <p className="text-xs font-semibold text-neutral-500 uppercase mb-1.5">
                    External skills (not managed by skill-switch)
                  </p>
                  <ul className="space-y-1.5">
                    {external.map((d) => (
                      <DriftRow
                        key={`ext:${d.skillName}`}
                        drift={d}
                        busy={false}
                        onUndeploy={() => {}}
                        onRedeploy={() => {}}
                        onRemoveFromManifest={() => {}}
                      />
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </li>
  )
}

function DriftRow({
  drift,
  busy,
  onUndeploy,
  onRedeploy,
  onRemoveFromManifest
}: {
  drift: DriftStatusView
  busy: boolean
  onUndeploy: () => void
  onRedeploy: () => void
  onRemoveFromManifest: () => void
}) {
  const badge = DRIFT_BADGE[drift.kind]
  // #8: drift 状态标灰(目标已被用户删了,清单与现实不一致)
  const isDrift = drift.kind === 'drift'
  return (
    <li className={`flex items-center justify-between bg-white border border-neutral-200 rounded px-3 py-1.5 ${isDrift ? 'opacity-50' : ''}`}>
      <div className="flex items-center gap-2 min-w-0">
        <span className={`text-xs px-2 py-0.5 rounded-full ${badge.cls}`}>{badge.label}</span>
        <span className="text-sm font-medium truncate">{drift.skillName}</span>
        {drift.deployment && (
          <span className="text-xs text-neutral-400">{drift.deployment.mode}</span>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
        {drift.kind === 'drift' && (
          <>
            <button
              onClick={onRedeploy}
              disabled={busy}
              className="px-2 py-0.5 bg-blue-600 text-white rounded text-xs hover:bg-blue-700 disabled:opacity-50"
            >
              Redeploy
            </button>
            {/* #8: 从清单移除(目标已不在,只清清单记录) */}
            <button
              onClick={onRemoveFromManifest}
              disabled={busy}
              className="px-2 py-0.5 bg-neutral-500 text-white rounded text-xs hover:bg-neutral-600 disabled:opacity-50"
            >
              Remove from manifest
            </button>
          </>
        )}
        {drift.kind === 'source-updated' && (
          <button
            onClick={onRedeploy}
            disabled={busy}
            className="px-2 py-0.5 bg-amber-600 text-white rounded text-xs hover:bg-amber-700 disabled:opacity-50"
          >
            Update
          </button>
        )}
        {drift.deployment !== null && drift.kind !== 'drift' && (
          <button
            onClick={onUndeploy}
            disabled={busy}
            className="px-2 py-0.5 bg-red-600 text-white rounded text-xs hover:bg-red-700 disabled:opacity-50"
          >
            Undeploy
          </button>
        )}
        {drift.kind === 'external' && (
          <span className="text-xs text-neutral-400">not managed</span>
        )}
      </div>
    </li>
  )
}

const DRIFT_BADGE: Record<string, { label: string; cls: string }> = {
  normal: { label: '✅', cls: 'bg-green-100 text-green-700' },
  'source-updated': { label: '⚠️ source updated', cls: 'bg-amber-100 text-amber-800' },
  drift: { label: '⚠️ drift', cls: 'bg-red-100 text-red-700' },
  external: { label: '🆕 external', cls: 'bg-blue-100 text-blue-700' }
}

// ===== Install 对话框(#7)=====

function InstallDialog({
  onDone
}: {
  onDone: (result: InstallResultView | null) => void
}) {
  const [tab, setTab] = useState<'github' | 'zip' | 'local-dir'>('github')
  const [githubUrl, setGithubUrl] = useState('')
  const [zipPath, setZipPath] = useState<string | null>(null)
  const [localPath, setLocalPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSelectZip = async () => {
    const path = await window.api.selectZipFile()
    if (path) setZipPath(path)
  }

  const handleSelectDir = async () => {
    const path = await window.api.selectLocalDir()
    if (path) setLocalPath(path)
  }

  const handleInstall = async () => {
    setBusy(true)
    setError(null)
    try {
      let result: InstallResultView
      if (tab === 'github') {
        if (!githubUrl.trim()) {
          setError('Please enter a GitHub URL.')
          setBusy(false)
          return
        }
        result = await window.api.installFromGitHub(githubUrl.trim())
      } else if (tab === 'zip') {
        if (!zipPath) {
          setError('Please select a ZIP file.')
          setBusy(false)
          return
        }
        result = await window.api.installFromZip(zipPath)
      } else {
        if (!localPath) {
          setError('Please select a directory.')
          setBusy(false)
          return
        }
        result = await window.api.installFromLocalDir(localPath)
      }
      onDone(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      onClick={() => !busy && onDone(null)}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-lg w-full mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-neutral-200">
          <h3 className="text-lg font-semibold">Install skill</h3>
        </div>

        <div className="p-4 space-y-4">
          {error && (
            <div className="px-3 py-2 rounded border border-red-200 bg-red-50 text-red-700 text-sm">
              {error}
            </div>
          )}

          <div className="flex gap-1 border-b border-neutral-200">
            {(['github', 'zip', 'local-dir'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                disabled={busy}
                className={`px-3 py-1.5 text-sm font-medium border-b-2 transition-colors ${
                  tab === t
                    ? 'border-blue-600 text-blue-700'
                    : 'border-transparent text-neutral-500 hover:text-neutral-700'
                }`}
              >
                {t === 'github' ? 'GitHub URL' : t === 'zip' ? 'ZIP file' : 'Local dir'}
              </button>
            ))}
          </div>

          {tab === 'github' && (
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1">
                GitHub repository URL
              </label>
              <input
                type="text"
                value={githubUrl}
                onChange={(e) => setGithubUrl(e.target.value)}
                disabled={busy}
                placeholder="https://github.com/owner/repo[/tree/main/skills/grilling]"
                className="w-full border border-neutral-300 rounded px-2 py-1.5 text-sm"
              />
              <p className="text-xs text-neutral-400 mt-1">
                Single-skill repo or sub-path (e.g. <code>/tree/main/skills/grilling</code>).
              </p>
            </div>
          )}

          {tab === 'zip' && (
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1">
                ZIP file
              </label>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleSelectZip}
                  disabled={busy}
                  className="px-3 py-1.5 bg-neutral-700 text-white rounded text-sm hover:bg-neutral-800"
                >
                  Select ZIP…
                </button>
                {zipPath && (
                  <code className="text-xs text-neutral-600 truncate">{zipPath}</code>
                )}
              </div>
            </div>
          )}

          {tab === 'local-dir' && (
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1">
                Local directory (indexed, files not moved)
              </label>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleSelectDir}
                  disabled={busy}
                  className="px-3 py-1.5 bg-neutral-700 text-white rounded text-sm hover:bg-neutral-800"
                >
                  Select directory…
                </button>
                {localPath && (
                  <code className="text-xs text-neutral-600 truncate">{localPath}</code>
                )}
              </div>
              <p className="text-xs text-neutral-400 mt-1">
                Registers the directory as an indexed source — files stay in place.
              </p>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-neutral-200 flex justify-end gap-2">
          <button
            onClick={() => onDone(null)}
            disabled={busy}
            className="px-4 py-2 text-sm text-neutral-700 hover:bg-neutral-100 rounded disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleInstall}
            disabled={busy}
            className="px-4 py-2 bg-green-600 text-white rounded text-sm hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? 'Installing…' : tab === 'local-dir' ? 'Add' : 'Install'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ===== Settings 页 =====

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
