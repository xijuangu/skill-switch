import { useState, useMemo, useEffect } from 'react'
import {
  Search, Filter, Plus, FolderOpen, MoreHorizontal,
  Download, Trash2, FileText, ExternalLink, Package, Upload,
  ChevronRight, ChevronDown, Hash, Calendar, GitBranch, AlertCircle
} from 'lucide-react'
import {
  Button, Input, StatusDot, EmptyState, Tabs, Skeleton,
  Dialog, Menu, useToast
} from '../../shared'
import { completeMutation } from '../../async-state'

type DeployMode = 'copy' | 'symlink'
type SkillView = Awaited<ReturnType<typeof window.api.getSkills>>[number]
type SkillSourceView = SkillView['sources'][number]
type ToolWithDriftsView = Awaited<ReturnType<typeof window.api.getTools>>[number]
type DeployResultView = Awaited<ReturnType<typeof window.api.deploy>>
type DeployTargetOptionView = Awaited<ReturnType<typeof window.api.getDeployTargets>>[number]
type SettingsView = Awaited<ReturnType<typeof window.api.getSettings>>
type ScanResult = Awaited<ReturnType<typeof window.api.scan>>
type InstallResultView = Awaited<ReturnType<typeof window.api.installFromGitHub>>

type DeployFilter = 'all' | 'deployed' | 'undeployed'
type DeployTarget = { skill: SkillView; sourcePath: string }

function sourceOriginLabel(origin: SkillSourceView['source_origin']): string {
  const labels: Record<SkillSourceView['source_origin'], string> = {
    scan: '扫描发现',
    local: '添加本地',
    github: 'GitHub 安装',
    zip: 'ZIP 安装',
    legacy: '旧版来源',
  }
  return labels[origin]
}

export function SkillsPage({
  skills,
  tools,
  scanning,
  lastScan,
  loading,
  onScan,
  onRefresh
}: {
  skills: SkillView[]
  tools: ToolWithDriftsView[]
  scanning: boolean
  lastScan: ScanResult | null
  loading: boolean
  onScan: () => void
  onRefresh: () => Promise<void>
}) {
  const [search, setSearch] = useState('')
  const [deployFilter, setDeployFilter] = useState<DeployFilter>('all')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [detailTab, setDetailTab] = useState('sources')

  const [conflictTarget, setConflictTarget] = useState<SkillView | null>(null)
  const [deployTarget, setDeployTarget] = useState<DeployTarget | null>(null)
  const [installOpen, setInstallOpen] = useState(false)
  const [installInitialTab, setInstallInitialTab] = useState<'github' | 'zip' | 'local-dir'>('github')
  const [contextMenu, setContextMenu] = useState<{ skill: SkillView; x: number; y: number } | null>(null)
  const [visibleMenuAnchor, setVisibleMenuAnchor] = useState<HTMLElement | null>(null)
  const [visibleMenuSkill, setVisibleMenuSkill] = useState<SkillView | null>(null)
  const [viewMdTarget, setViewMdTarget] = useState<{ content: string; path: string; skillName: string } | null>(null)
  const [viewMdSourcePicker, setViewMdSourcePicker] = useState<SkillView | null>(null)
  const [undeployFromTarget, setUndeployFromTarget] = useState<{ skill: SkillView; deployments: { target_tool: string; mode: string }[] } | null>(null)
  const [removeRegistryTarget, setRemoveRegistryTarget] = useState<SkillView | null>(null)
  const [actionBusy, setActionBusy] = useState(false)

  const { success, error: toastError, info } = useToast()

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    let result = skills

    if (deployFilter === 'deployed') {
      result = result.filter((s) => s.deployments.length > 0)
    } else if (deployFilter === 'undeployed') {
      result = result.filter((s) => s.deployments.length === 0)
    }

    if (q) {
      result = result.filter((s) => {
        for (const src of s.sources) {
          if (src.path.toLowerCase().includes(q)) return true
        }
        for (const dep of s.deployments) {
          if (dep.target_path?.toLowerCase().includes(q)) return true
          if (dep.target_tool.toLowerCase().includes(q)) return true
        }
        if (s.name.toLowerCase().includes(q)) return true
        return false
      })
    }

    return result
  }, [skills, search, deployFilter])

  const selected = useMemo(
    () => (selectedId != null ? skills.find((s) => s.id === selectedId) : null),
    [skills, selectedId]
  )

  const conflictCount = useMemo(
    () => skills.filter((s) => s.conflict.hasConflict).length,
    [skills]
  )

  useEffect(() => {
    if (filtered.length > 0) {
      const stillVisible = filtered.find((s) => s.id === selectedId)
      if (!stillVisible) {
        setSelectedId(filtered[0].id)
        setDetailTab('sources')
      }
    } else {
      setSelectedId(null)
    }
  }, [filtered, selectedId])

  useEffect(() => {
    if (skills.length > 0 && selectedId == null) {
      setSelectedId(skills[0].id)
    }
  }, [skills, selectedId])

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
    if (!result) {
      setDeployTarget(null)
      return
    }
    const degradeNote = result.degradedFrom != null
      ? ` (请求 ${result.degradedFrom}，使用 ${result.mode}: ${result.degradeReason ?? '已降级'})`
      : ''
    const msg = result.action === 'skipped'
      ? `跳过 — ${result.targetPath} 已是最新`
      : `已部署 (${result.action}) 到 ${result.targetPath}${degradeNote}`
    success(msg)
    await onRefresh()
    setDeployTarget(null)
  }

  const handleViewMd = async (skill: SkillView) => {
    setContextMenu(null)
    setVisibleMenuAnchor(null)
    setVisibleMenuSkill(null)
    if (skill.conflict.hasConflict) {
      setViewMdSourcePicker(skill)
      return
    }
    setActionBusy(true)
    try {
      const result = await window.api.viewSkillMd(skill.id)
      if (result) {
        setViewMdTarget({ ...result, skillName: skill.name })
      } else {
        info(`未找到「${skill.name}」的 SKILL.md`)
      }
    } finally {
      setActionBusy(false)
    }
  }

  const handleViewMdPickSource = async (source: SkillSourceView) => {
    if (!viewMdSourcePicker) return
    const skill = viewMdSourcePicker
    setViewMdSourcePicker(null)
    setActionBusy(true)
    try {
      const result = await window.api.viewSkillMd(skill.id, source.path)
      if (result) {
        setViewMdTarget({ ...result, skillName: skill.name })
      } else {
        info(`未找到「${skill.name}」的 SKILL.md`)
      }
    } finally {
      setActionBusy(false)
    }
  }

  const handleUndeployFromInit = async (skill: SkillView) => {
    setContextMenu(null)
    setVisibleMenuAnchor(null)
    setVisibleMenuSkill(null)
    setActionBusy(true)
    try {
      const deployments = await window.api.getDeploymentsForSkill(skill.id)
      if (deployments.length === 0) {
        info(`「${skill.name}」未部署到任何工具`)
        return
      }
      setUndeployFromTarget({ skill, deployments })
    } finally {
      setActionBusy(false)
    }
  }

  const handleRemoveFromRegistry = (skill: SkillView) => {
    setContextMenu(null)
    setVisibleMenuAnchor(null)
    setVisibleMenuSkill(null)
    setRemoveRegistryTarget(skill)
  }

  const handleRemoveFromRegistryConfirm = async () => {
    if (!removeRegistryTarget) return
    setActionBusy(true)
    try {
      const result = await window.api.removeFromRegistry(removeRegistryTarget.id)
      const msg = result.backedUp
        ? `已移除「${result.skillName}」(已备份，从 ${result.undeployedTools.length} 个工具取消部署)`
        : `已移除「${result.skillName}」(从 ${result.undeployedTools.length} 个工具取消部署)`
      success(msg)
      await onRefresh()
      if (selectedId === removeRegistryTarget.id) {
        setSelectedId(null)
      }
    } catch (e) {
      toastError(e instanceof Error ? e.message : String(e))
      await onRefresh()
    } finally {
      setRemoveRegistryTarget(null)
      setActionBusy(false)
    }
  }

  const handleUndeployFromTool = async (targetTool: string) => {
    if (!undeployFromTarget) return
    setActionBusy(true)
    try {
      await window.api.undeploy(undeployFromTarget.skill.id, targetTool)
      const remaining = await window.api.getDeploymentsForSkill(undeployFromTarget.skill.id)
      if (remaining.length === 0) {
        setUndeployFromTarget(null)
      } else {
        setUndeployFromTarget({ ...undeployFromTarget, deployments: remaining })
      }
      await onRefresh()
      success(`已从 ${targetTool} 取消部署`)
    } catch (e) {
      toastError(e instanceof Error ? e.message : String(e))
      await onRefresh()
    } finally {
      setActionBusy(false)
    }
  }

  const handleInstallDone = async (result: InstallResultView | null) => {
    if (!result) {
      setInstallOpen(false)
      return
    }
    const msg = result.overwritten
      ? `已安装「${result.skillName}」(覆盖了已有版本)`
      : `已安装「${result.skillName}」`
    success(msg)
    await onRefresh()
    setInstallOpen(false)
  }

  const getMenuActions = (skill: SkillView) => [
    { key: 'deploy', label: '部署到…', onClick: () => handleDeployClick(skill) },
    { key: 'undeploy', label: '从…取消部署', onClick: () => handleUndeployFromInit(skill), disabled: actionBusy },
    { key: 'view-md', label: '查看 SKILL.md', onClick: () => handleViewMd(skill), disabled: actionBusy },
    { key: 'remove', label: '从注册表移除', onClick: () => handleRemoveFromRegistry(skill), danger: true as const, disabled: actionBusy },
  ]

  const getMatchReason = (skill: SkillView): string | null => {
    const q = search.toLowerCase().trim()
    if (!q) return null
    if (skill.name.toLowerCase().includes(q)) return null
    for (const src of skill.sources) {
      if (src.path.toLowerCase().includes(q)) return `路径: ${src.path}`
    }
    for (const dep of skill.deployments) {
      if (dep.target_path?.toLowerCase().includes(q)) return `部署目标: ${dep.target_tool}`
      if (dep.target_tool.toLowerCase().includes(q)) return `工具: ${dep.target_tool}`
    }
    return null
  }

  if (loading) {
    return (
      <div className="flex gap-0 h-full">
        <div className="w-72 shrink-0 border-r border-border p-3 space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-12 rounded-md border border-border p-2">
              <div className="h-3 w-2/3 rounded-sm bg-border-subtle mb-1.5" />
              <div className="h-2 w-1/3 rounded-sm bg-border-subtle" />
            </div>
          ))}
        </div>
        <div className="flex-1 p-4 space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-3 rounded-sm bg-border-subtle w-3/4" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="flex gap-0 h-full -mx-6 -my-6">
      <div className="w-72 shrink-0 border-r border-border flex flex-col bg-surface">
        <div className="p-3 space-y-2 border-b border-border">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-foreground-muted" />
              <Input
                placeholder="搜索名称、路径或工具…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-7 w-full"
              />
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Filter className="h-3 w-3 text-foreground-muted" />
            {(['all', 'deployed', 'undeployed'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setDeployFilter(f)}
                className={`text-2xs px-2 py-0.5 rounded transition-colors duration-fast ${
                  deployFilter === f
                    ? 'bg-primary text-primary-foreground'
                    : 'text-foreground-secondary hover:bg-surface-hover'
                }`}
              >
                {f === 'all' ? '全部' : f === 'deployed' ? '已部署' : '未部署'}
              </button>
            ))}
          </div>
        </div>

        <div className="p-2 border-b border-border flex gap-1">
          <Button
            variant="secondary" size="sm"
            onClick={onScan}
            loading={scanning}
            className="flex-1"
          >
            {scanning ? '扫描中…' : '扫描'}
          </Button>
          <Button
            variant="secondary" size="sm"
            onClick={() => { setInstallInitialTab('github'); setInstallOpen(true) }}
            className="flex-1"
          >
            安装
          </Button>
          <Button
            variant="secondary" size="sm"
            onClick={() => { setInstallInitialTab('local-dir'); setInstallOpen(true) }}
          >
            添加
          </Button>
        </div>

        {lastScan && (
          <div className="px-3 py-1.5 text-2xs text-foreground-muted border-b border-border">
            已扫描 {lastScan.totalScanned} 个 skill，登记 {lastScan.totalUpserted} 个
          </div>
        )}

        <div className="flex-1 overflow-auto" role="listbox" aria-label="Skill 列表">
          {filtered.length === 0 ? (
            <div className="p-6 text-center">
              <p className="text-xs text-foreground-muted mb-2">
                {search || deployFilter !== 'all' ? '无匹配结果' : '无 Skill'}
              </p>
              {(search || deployFilter !== 'all') ? (
                <Button
                  variant="ghost" size="sm"
                  onClick={() => { setSearch(''); setDeployFilter('all') }}
                >
                  清除筛选
                </Button>
              ) : (
                <Button variant="primary" size="sm" onClick={onScan}>
                  扫描发现 Skill
                </Button>
              )}
            </div>
          ) : (
            filtered.map((skill) => (
              <SkillMasterItem
                key={skill.id}
                skill={skill}
                selected={selectedId === skill.id}
                matchReason={getMatchReason(skill)}
                onSelect={() => setSelectedId(skill.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setContextMenu({ skill, x: e.clientX, y: e.clientY })
                }}
              />
            ))
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {selected ? (
          <SkillDetail
            skill={selected}
            tab={detailTab}
            onTabChange={setDetailTab}
            onDeploy={() => handleDeployClick(selected)}
            onMoreClick={(el) => {
              setVisibleMenuAnchor(el)
              setVisibleMenuSkill(selected)
            }}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-foreground-muted text-xs">
            {filtered.length === 0 ? '无 Skill 可选' : '请选择一个 Skill'}
          </div>
        )}
      </div>

      {conflictTarget && (
        <ConflictDialog
          skill={conflictTarget}
          onCancel={() => setConflictTarget(null)}
          onConfirm={handleConflictConfirm}
        />
      )}

      {deployTarget && (
        <DeployDialogContent
          skill={deployTarget.skill}
          sourcePath={deployTarget.sourcePath}
          onDone={handleDeployDone}
        />
      )}

      {installOpen && (
        <InstallDialogContent
          initialTab={installInitialTab}
          onDone={handleInstallDone}
        />
      )}

      {contextMenu && (
        <Menu
          anchor={{ x: contextMenu.x, y: contextMenu.y }}
          actions={getMenuActions(contextMenu.skill)}
          onClose={() => setContextMenu(null)}
          label="Skill 操作"
        />
      )}

      {visibleMenuSkill && visibleMenuAnchor && (
        <Menu
          anchor={visibleMenuAnchor}
          actions={getMenuActions(visibleMenuSkill)}
          onClose={() => { setVisibleMenuAnchor(null); setVisibleMenuSkill(null) }}
          label="Skill 操作"
        />
      )}

      {viewMdTarget && (
        <ViewMdDialog
          skillName={viewMdTarget.skillName}
          content={viewMdTarget.content}
          path={viewMdTarget.path}
          onClose={() => setViewMdTarget(null)}
        />
      )}

      {viewMdSourcePicker && (
        <ViewMdSourcePicker
          skill={viewMdSourcePicker}
          onPick={handleViewMdPickSource}
          onCancel={() => setViewMdSourcePicker(null)}
        />
      )}

      {undeployFromTarget && (
        <UndeployDialog
          skill={undeployFromTarget.skill}
          deployments={undeployFromTarget.deployments}
          busy={actionBusy}
          onUndeploy={handleUndeployFromTool}
          onClose={() => setUndeployFromTarget(null)}
        />
      )}

      {removeRegistryTarget && (
        <RemoveRegistryDialog
          skill={removeRegistryTarget}
          busy={actionBusy}
          onConfirm={handleRemoveFromRegistryConfirm}
          onCancel={() => setRemoveRegistryTarget(null)}
        />
      )}
    </div>
  )
}

function SkillMasterItem({
  skill,
  selected,
  matchReason,
  onSelect,
  onContextMenu
}: {
  skill: SkillView
  selected: boolean
  matchReason: string | null
  onSelect: () => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  const deployed = skill.deployments.length > 0
  const sourceCount = skill.sources.length
  const conflict = skill.conflict.hasConflict
  const sourceLabels = skill.sources.map((s) => sourceOriginLabel(s.source_origin))
  const uniqueSourceLabels = [...new Set(sourceLabels)]

  return (
    <div
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      className={`px-3 py-2.5 cursor-pointer border-b border-border-subtle transition-colors duration-fast ${
        selected ? 'bg-primary-subtle border-l-2 border-l-primary pl-2.5' : 'hover:bg-surface-hover border-l-2 border-l-transparent'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <StatusDot
            variant={deployed ? 'success' : 'neutral'}
            label={deployed ? `已部署 · ${skill.deployments.length}` : '未部署'}
          />
          <span className="text-xs font-medium text-foreground truncate">{skill.name}</span>
        </div>
      </div>
      <div className="flex items-center gap-1.5 mt-1 ml-[calc(0.375rem+0.375rem+0.375rem)]">
        <span className="text-2xs text-foreground-muted">
          {sourceCount === 1
            ? uniqueSourceLabels[0] ?? sourceOriginLabel(skill.sources[0].source_origin)
            : `${sourceCount} 个来源`}
        </span>
        {sourceCount > 1 && conflict && (
          <span className="text-2xs px-1 py-px rounded bg-warning-subtle text-warning font-medium">
            版本冲突
          </span>
        )}
        {matchReason && (
          <span className="text-2xs text-foreground-muted truncate">
            · {matchReason}
          </span>
        )}
      </div>
    </div>
  )
}

function SkillDetail({
  skill,
  tab,
  onTabChange,
  onDeploy,
  onMoreClick
}: {
  skill: SkillView
  tab: string
  onTabChange: (tab: string) => void
  onDeploy: () => void
  onMoreClick: (el: HTMLElement) => void
}) {
  const conflict = skill.conflict.hasConflict

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="text-sm font-semibold text-foreground truncate">{skill.name}</h2>
          {conflict && (
            <span className="text-2xs px-1.5 py-0.5 rounded bg-warning-subtle text-warning font-medium shrink-0">
              版本冲突
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button variant="primary" size="sm" onClick={onDeploy} icon={<Upload className="h-3 w-3" />}>
            部署
          </Button>
          <Button
            variant="ghost" size="sm"
            onClick={(e) => onMoreClick(e.currentTarget)}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <Tabs
        tabs={[
          { key: 'sources', label: `来源 (${skill.sources.length})` },
          { key: 'deployments', label: `部署 (${skill.deployments.length})` },
        ]}
        activeKey={tab}
        onChange={onTabChange}
      />

      <div className="flex-1 overflow-auto p-4">
        {tab === 'sources' && <SourcePanel skill={skill} />}
        {tab === 'deployments' && <DeploymentPanel skill={skill} />}
      </div>
    </div>
  )
}

function SourcePanel({ skill }: { skill: SkillView }) {
  if (skill.sources.length === 0) {
    return <p className="text-xs text-foreground-muted">未登记任何来源。</p>
  }

  const hashGroups = new Map<string, SkillSourceView[]>()
  for (const s of skill.sources) {
    const arr = hashGroups.get(s.hash) ?? []
    arr.push(s)
    hashGroups.set(s.hash, arr)
  }
  const distinctVersions = hashGroups.size

  return (
    <div className="space-y-2">
      {distinctVersions > 1 && (
        <div className="flex items-center gap-1.5 text-2xs text-warning mb-2">
          <AlertCircle className="h-3 w-3" />
          {distinctVersions} 个不同版本
        </div>
      )}
      {skill.sources.map((src) => (
        <SourceItem key={src.id} source={src} />
      ))}
    </div>
  )
}

function SourceItem({ source }: { source: SkillSourceView }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="border border-border rounded-md">
      <button
        className="w-full flex items-center justify-between p-2.5 text-left hover:bg-surface-hover transition-colors duration-fast"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-2xs px-1.5 py-0.5 rounded-full bg-surface-secondary text-foreground-secondary border border-border-subtle">
            {sourceOriginLabel(source.source_origin)}
          </span>
          <code className="text-xs font-mono text-foreground truncate">{source.path}</code>
        </div>
        {expanded ? <ChevronDown className="h-3.5 w-3.5 text-foreground-muted shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-foreground-muted shrink-0" />}
      </button>
      {expanded && (
        <div className="border-t border-border p-2.5 space-y-1">
          <MetaRow icon={Hash} label="hash" value={source.hash} />
          <MetaRow icon={Calendar} label="mtime" value={new Date(source.mtime).toLocaleString()} />
          {source.repo_url && <MetaRow icon={GitBranch} label="repo" value={source.repo_url} />}
          {source.commit_sha && <MetaRow icon={GitBranch} label="sha" value={source.commit_sha.slice(0, 12)} />}
          <MetaRow icon={Calendar} label="发现时间" value={source.discovered_at} />
        </div>
      )}
    </div>
  )
}

function MetaRow({ icon: Icon, label, value }: { icon: typeof Hash; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2 text-2xs">
      <span className="text-foreground-muted w-14 shrink-0">{label}</span>
      <code className="font-mono text-foreground-secondary break-all">{value}</code>
    </div>
  )
}

function DeploymentPanel({ skill }: { skill: SkillView }) {
  if (skill.deployments.length === 0) {
    return <p className="text-xs text-foreground-muted">未部署到任何工具。</p>
  }

  return (
    <div className="space-y-2">
      {skill.deployments.map((dep) => (
        <div
          key={`${dep.target_tool}:${dep.target_path}`}
          className="border border-border rounded-md p-2.5"
        >
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-medium text-foreground">{dep.target_tool}</span>
              <span className="text-2xs px-1 py-px rounded bg-surface-secondary text-foreground-secondary">
                {dep.mode}
              </span>
            </div>
            <StatusDot
              variant={
                dep.status === 'normal' ? 'success' :
                dep.status === 'source-updated' || dep.status === 'target-modified' ? 'warning' : 'danger'
              }
              label={DRIFT_LABEL[dep.status] ?? dep.status}
            />
          </div>
          <div className="space-y-1">
            <MetaRow icon={ExternalLink} label="目标路径" value={dep.target_path ?? ''} />
            <MetaRow icon={Calendar} label="部署时间" value={dep.deployed_at} />
          </div>
        </div>
      ))}
    </div>
  )
}

const DRIFT_LABEL: Record<string, string> = {
  normal: '正常',
  'source-updated': '源已更新',
  'target-modified': '目标已修改',
  'link-mismatch': '链接异常',
  'source-missing': '源缺失',
  unresolved: '待确认',
  drift: '漂移',
}

function ConflictDialog({
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

  return (
    <Dialog
      open
      onClose={onCancel}
      title={`解决版本冲突 — ${skill.name}`}
      description={`检测到 ${distinctVersions} 个不同版本 (共 ${skill.sources.length} 个来源)，请选择要使用哪个版本。`}
      confirmLabel="使用此版本"
      onConfirm={() => {
        const picked = skill.sources.find((s) => s.id === selectedId)
        if (picked) onConfirm(picked)
      }}
      closeOnOverlay={false}
    >
      <div className="space-y-2">
        {skill.sources.map((src) => {
          const sameHashCount = hashGroups.get(src.hash)?.length ?? 1
          return (
            <label
              key={src.id}
              className={`block border rounded p-2.5 cursor-pointer transition-colors duration-fast ${
                selectedId === src.id
                  ? 'border-primary bg-primary-subtle'
                  : 'border-border hover:bg-surface-hover'
              }`}
            >
              <div className="flex items-start gap-2">
                <input
                  type="radio"
                  name="conflict-source"
                  checked={selectedId === src.id}
                  onChange={() => setSelectedId(src.id)}
                  className="mt-0.5"
                />
                <div className="flex-1 min-w-0 text-xs space-y-0.5">
                  <div className="font-mono text-foreground break-all">{src.path}</div>
                  <div className="font-mono text-foreground-secondary text-2xs">{src.hash}</div>
                  <div className="text-foreground-muted text-2xs">
                    {sourceOriginLabel(src.source_origin)} · {src.source_type}
                    {sameHashCount > 1 && ` · 与另外 ${sameHashCount - 1} 个来源内容一致`}
                  </div>
                </div>
              </div>
            </label>
          )
        })}
      </div>
    </Dialog>
  )
}

function DeployDialogContent({
  skill,
  sourcePath,
  onDone
}: {
  skill: SkillView
  sourcePath: string
  onDone: (result: DeployResultView | null) => Promise<void>
}) {
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [targetOptions, setTargetOptions] = useState<DeployTargetOptionView[]>([])
  const [selectedTool, setSelectedTool] = useState('')
  const [selectedTargetRoot, setSelectedTargetRoot] = useState('')
  const [mode, setMode] = useState<DeployMode>('copy')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { success: toastSuccess, error: toastError } = useToast()

  useEffect(() => {
    Promise.all([
      window.api.getSettings(),
      window.api.getDeployTargets(skill.id, sourcePath)
    ])
      .then(([s, options]) => {
        setSettings(s)
        setTargetOptions(options)
        const existing = options.find(
          (o) => o.eligible &&
            skill.deployments.some((d) => d.target_path === o.targetPath)
        )
        const firstSafe = options.find((o) => o.eligible)
        if (existing) {
          setSelectedTool(existing.targetTool)
          setSelectedTargetRoot(existing.targetRoot)
        } else if (firstSafe) {
          setSelectedTool(firstSafe.targetTool)
          setSelectedTargetRoot(firstSafe.targetRoot)
        }
        setMode(s.platform.canSymlink ? 'symlink' : 'copy')
      })
      .catch((loadError) => {
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      })
  }, [skill.id, skill.deployments, sourcePath])

  const targetSelectionValid = targetOptions.some(
    (o) => o.targetRoot === selectedTargetRoot && o.eligible
  )
  const canSymlink = settings?.platform.canSymlink ?? false
  const canJunction = settings?.platform.canJunction ?? false
  const isWindowsNormalUser = !canSymlink && canJunction
  const selectedDeployment = skill.deployments.find(
    (d) => d.target_tool === selectedTool
  )

  const handleDeploy = async () => {
    if (!selectedTool || !selectedTargetRoot || !targetSelectionValid) return
    setBusy(true)
    setError(null)
    try {
      const plan = await window.api.prepareDeploy(
        skill.id, selectedTool, mode, sourcePath, selectedTargetRoot
      )
      let confirmationToken: string | undefined
      if (plan.kind === 'external-overwrite') {
        const proceed = window.confirm(
          `目标已存在外部 skill「${skill.name}」:\n${plan.targetPath}\n\n覆盖前会自动备份。是否继续?`
        )
        if (!proceed) { setBusy(false); return }
        if (!plan.confirmationToken) {
          throw new Error('无法获取外部覆盖确认令牌')
        }
        confirmationToken = plan.confirmationToken
      }
      const result = await window.api.deploy(
        skill.id, selectedTool, mode, sourcePath, selectedTargetRoot, confirmationToken
      )
      await completeMutation(result, onDone)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={() => !busy && onDone(null)}
      title={`部署 ${skill.name}`}
      confirmLabel="部署"
      onConfirm={handleDeploy}
      busy={busy}
      closeOnOverlay={!busy}
    >
      <div className="space-y-4">
        <p className="text-xs text-foreground-secondary font-mono break-all">
          {sourcePath}
        </p>

        {error && (
          <div className="px-3 py-2 rounded border border-danger-subtle bg-danger-subtle text-danger text-xs">{error}</div>
        )}

        <div>
          <label className="block text-xs font-medium text-foreground mb-1">目标工具</label>
          <select
            value={selectedTargetRoot}
            onChange={(e) => {
              const selected = targetOptions.find((o) => o.targetRoot === e.target.value)
              setSelectedTargetRoot(e.target.value)
              setSelectedTool(selected?.targetTool ?? '')
            }}
            disabled={busy}
            className="w-full h-8 border border-border rounded bg-surface px-2.5 text-xs text-foreground focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none disabled:opacity-50"
          >
            {targetOptions.length === 0 && (
              <option value="" disabled>无可用工具目标</option>
            )}
            {targetOptions.map((o) => (
              <option key={`${o.targetTool}:${o.targetRoot}`} value={o.targetRoot} disabled={!o.eligible}>
                {o.displayName} — {o.targetRoot}
                {!o.eligible ? ` (不可用：${o.reason})` : ''}
              </option>
            ))}
          </select>
          {selectedDeployment && (
            <p className="text-2xs text-foreground-muted mt-1">
              此工具已有部署，只能更新原目标
            </p>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-foreground mb-1">模式</label>
          <div className="flex gap-3">
            <label
              className={`flex items-center gap-1.5 text-xs cursor-pointer ${canSymlink || canJunction ? '' : 'opacity-50'}`}
              title={isWindowsNormalUser ? '需要开启开发者模式或以管理员运行' : !canSymlink ? '此平台不支持 symlink' : ''}
            >
              <input
                type="radio"
                name="deploy-mode"
                checked={mode === 'symlink'}
                onChange={() => setMode('symlink')}
                disabled={(!canSymlink && !canJunction) || busy}
              />
              symlink
            </label>
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input
                type="radio"
                name="deploy-mode"
                checked={mode === 'copy'}
                onChange={() => setMode('copy')}
                disabled={busy}
              />
              copy
            </label>
          </div>
          <p className="text-2xs text-foreground-muted mt-1">
            {mode === 'symlink'
              ? isWindowsNormalUser ? '将自动尝试 junction，失败则降级 copy' : '源更新自动生效'
              : '快照副本 — 源更新需手动重新部署'}
          </p>
        </div>
      </div>
    </Dialog>
  )
}

function InstallDialogContent({
  initialTab,
  onDone
}: {
  initialTab: 'github' | 'zip' | 'local-dir'
  onDone: (result: InstallResultView | null) => Promise<void>
}) {
  const [tab, setTab] = useState<'github' | 'zip' | 'local-dir'>(initialTab)
  const [githubUrl, setGithubUrl] = useState('')
  const [zipPath, setZipPath] = useState<string | null>(null)
  const [localPath, setLocalPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { success: toastSuccess, error: toastError } = useToast()

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
          setError('请输入 GitHub URL')
          setBusy(false)
          return
        }
        result = await window.api.installFromGitHub(githubUrl.trim())
      } else if (tab === 'zip') {
        if (!zipPath) {
          setError('请选择 ZIP 文件')
          setBusy(false)
          return
        }
        result = await window.api.installFromZip(zipPath)
      } else {
        if (!localPath) {
          setError('请选择目录')
          setBusy(false)
          return
        }
        result = await window.api.installFromLocalDir(localPath)
      }
      await completeMutation(result, onDone)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={() => !busy && onDone(null)}
      title="安装 Skill"
      confirmLabel={tab === 'local-dir' ? '添加' : '安装'}
      onConfirm={handleInstall}
      busy={busy}
    >
      <div className="space-y-4">
        {error && (
          <div className="px-3 py-2 rounded border border-danger-subtle bg-danger-subtle text-danger text-xs">{error}</div>
        )}

        <div className="flex gap-1 border-b border-border">
          {(['github', 'zip', 'local-dir'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              disabled={busy}
              className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors -mb-px ${
                tab === t ? 'border-primary text-primary' : 'border-transparent text-foreground-secondary hover:text-foreground'
              }`}
            >
              {t === 'github' ? 'GitHub URL' : t === 'zip' ? 'ZIP 文件' : '本地目录'}
            </button>
          ))}
        </div>

        {tab === 'github' && (
          <div>
            <label className="block text-xs text-foreground-secondary mb-1">GitHub 仓库 URL</label>
            <Input
              value={githubUrl}
              onChange={(e) => setGithubUrl(e.target.value)}
              disabled={busy}
              placeholder="https://github.com/owner/repo[/tree/main/skills/grilling]"
              mono
              className="w-full"
            />
            <p className="text-2xs text-foreground-muted mt-1">
              单 skill 仓库或子路径（如 <code className="font-mono text-2xs">/tree/main/skills/grilling</code>）
            </p>
          </div>
        )}

        {tab === 'zip' && (
          <div>
            <label className="block text-xs text-foreground-secondary mb-1">ZIP 文件</label>
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={handleSelectZip} disabled={busy} size="sm">
                选择 ZIP…
              </Button>
              {zipPath && <code className="text-xs font-mono text-foreground-secondary truncate">{zipPath}</code>}
            </div>
          </div>
        )}

        {tab === 'local-dir' && (
          <div>
            <label className="block text-xs text-foreground-secondary mb-1">本地目录（索引模式，不搬文件）</label>
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={handleSelectDir} disabled={busy} size="sm">
                选择目录…
              </Button>
              {localPath && <code className="text-xs font-mono text-foreground-secondary truncate">{localPath}</code>}
            </div>
            <p className="text-2xs text-foreground-muted mt-1">
              将目录登记为索引 source，文件保留在原位。
            </p>
          </div>
        )}
      </div>
    </Dialog>
  )
}

function ViewMdDialog({
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
    <Dialog open onClose={onClose} title={`${skillName} — SKILL.md`} hideCancel confirmLabel="关闭" onConfirm={onClose}>
      <p className="text-2xs text-foreground-muted mb-2 font-mono break-all">{path}</p>
      <pre className="text-xs text-foreground whitespace-pre-wrap break-words font-mono">{content}</pre>
    </Dialog>
  )
}

function ViewMdSourcePicker({
  skill,
  onPick,
  onCancel
}: {
  skill: SkillView
  onPick: (source: SkillSourceView) => void
  onCancel: () => void
}) {
  const [selectedId, setSelectedId] = useState<number | null>(null)
  return (
    <Dialog
      open
      onClose={onCancel}
      title={`选择 Source — ${skill.name}`}
      description="存在多个 source，请选择要查看哪个 SKILL.md"
      confirmLabel="查看"
      onConfirm={() => {
        const picked = skill.sources.find((s) => s.id === selectedId)
        if (picked) onPick(picked)
      }}
    >
      <div className="space-y-2">
        {skill.sources.map((src) => (
          <label
            key={src.id}
            className={`block border rounded p-2 cursor-pointer transition-colors ${
              selectedId === src.id ? 'border-primary bg-primary-subtle' : 'border-border hover:bg-surface-hover'
            }`}
          >
            <div className="flex items-start gap-2">
              <input
                type="radio"
                name="viewmd-source"
                checked={selectedId === src.id}
                onChange={() => setSelectedId(src.id)}
                className="mt-0.5"
              />
              <div className="flex-1 min-w-0 text-xs space-y-0.5">
                <div className="font-mono text-foreground break-all">{src.path}</div>
                <div className="font-mono text-foreground-secondary text-2xs">{src.hash}</div>
                <div className="text-foreground-muted text-2xs">{sourceOriginLabel(src.source_origin)}</div>
              </div>
            </div>
          </label>
        ))}
      </div>
    </Dialog>
  )
}

function UndeployDialog({
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
    <Dialog
      open
      onClose={() => !busy && onClose()}
      title={`从…取消部署 ${skill.name}`}
      description={`${deployments.length} 个部署。此操作只移除部署（链接/副本），不删源文件。`}
      hideCancel
      closeOnOverlay={!busy}
    >
      <div className="space-y-2 max-h-48 overflow-auto">
        {deployments.map((d) => (
          <div key={d.target_tool} className="flex items-center justify-between border border-border rounded px-2.5 py-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-xs font-medium">{d.target_tool}</span>
              <span className="text-2xs px-1 py-px rounded bg-surface-secondary text-foreground-secondary">{d.mode}</span>
            </div>
            <Button variant="danger" size="sm" onClick={() => onUndeploy(d.target_tool)} disabled={busy}>
              取消部署
            </Button>
          </div>
        ))}
      </div>
      <div className="mt-3 flex justify-end">
        <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
          关闭
        </Button>
      </div>
    </Dialog>
  )
}

function RemoveRegistryDialog({
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
    <Dialog
      open
      onClose={onCancel}
      title={`从注册表移除「${skill.name}」?`}
      variant="danger"
      description="此操作将永久从注册表移除该 skill：将中央仓库实体备份（如有），从所有工具取消部署，并删除注册表记录。此操作不可撤销。"
      confirmLabel="从注册表移除"
      onConfirm={onConfirm}
      busy={busy}
      closeOnOverlay={false}
    />
  )
}
