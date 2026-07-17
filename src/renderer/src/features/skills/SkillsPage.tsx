import { useState, useMemo, useEffect, useRef } from 'react'
import {
  Search, Filter, Plus, FolderOpen, MoreHorizontal,
  Download, Trash2, FileText, ExternalLink, Package, Upload,
  ChevronRight, ChevronDown, Hash, Calendar, GitBranch, AlertCircle
} from 'lucide-react'
import {
  Button, Input, StatusDot, EmptyState, Tabs, Skeleton, Menu, getDriftStatus
} from '../../shared'
import { useToast } from '../../app/Toast'
import {
  ConflictDialog,
  BulkSkillActionsDialog,
  DeployDialogContent,
  InstallDialogContent,
  ViewMdDialog,
  ViewMdSourcePicker,
  UndeployDialog,
  RemoveRegistryDialog,
  ConsolidationDialog,
  BatchConsolidationDialog,
  ConflictResolutionDialog,
  UndoConsolidationDialog,
  SourceRelocationDialog,
  UndoRelocationDialog,
  sourceOriginLabel,
  sourceRoleLabel,
  type SkillView,
  type SkillSourceView,
  type DeployResultView,
  type InstallResultView,
  type ConsolidationBatch,
  type SourceRelocation,
  type UndoBatch,
} from './dialogs'
import { useConsolidationFlow, useBatchConsolidationFlow, useConflictResolutionFlow, useSourceRelocationFlow } from './hooks'
import { groupByHash, shortHash } from './sourceGrouping'

type ToolWithDriftsView = Awaited<ReturnType<typeof window.api.getTools>>[number]
type ScanResult = Awaited<ReturnType<typeof window.api.scan>>

type DeployFilter = 'all' | 'deployed' | 'undeployed'
type DeployTarget = { skill: SkillView; sourceId: number }

function managedDeploymentCount(skill: SkillView): number {
  return skill.deployments.filter((deployment) => deployment.management === 'managed').length
}

export function SkillsPage({
  skills,
  tools,
  scanning,
  lastScan,
  loading,
  loadError,
  onScan,
  onRefresh,
  onRetry
}: {
  skills: SkillView[]
  tools: ToolWithDriftsView[]
  scanning: boolean
  lastScan: ScanResult | null
  loading: boolean
  loadError: string | null
  onScan: () => void
  onRefresh: () => Promise<void>
  onRetry: () => Promise<void>
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
  const [undeployFromTarget, setUndeployFromTarget] = useState<{ skill: SkillView; deployments: { id: number; target_tool: string; target_path: string | null; mode: string; management: 'managed' | 'observed' }[] } | null>(null)
  const [removeRegistryTarget, setRemoveRegistryTarget] = useState<SkillView | null>(null)
  const [actionBusy, setActionBusy] = useState(false)
  const [bulkSelecting, setBulkSelecting] = useState(false)
  const [bulkSelectedIds, setBulkSelectedIds] = useState<Set<number>>(new Set())
  const [bulkActionsOpen, setBulkActionsOpen] = useState(false)
  // 删除当前 Skill 后选相邻项:记录被删项在旧 filtered 中的索引,refresh 后据此选下一项/上一项
  const pendingAdjacentSelectRef = useRef<number | null>(null)

  const { success, error: toastError, info } = useToast()

  const refreshLibrary = async () => {
    const library = await window.api.getSkillLibrary()
    consolidationFlow.applyLibrary(library)
    batchFlow.applyLibrary(library)
    relocationFlow.applyLibrary(library)
    return library
  }

  const flowDeps = { actionBusy, setActionBusy, onRefresh, success, toastError }
  const consolidationFlow = useConsolidationFlow(flowDeps, refreshLibrary)
  const batchFlow = useBatchConsolidationFlow(flowDeps, refreshLibrary)
  const conflictFlow = useConflictResolutionFlow(
    flowDeps,
    skills,
    (skillId, cr) => batchFlow.updateDraft(skillId, { selected: true, conflictResolution: cr })
  )
  const relocationFlow = useSourceRelocationFlow(flowDeps, refreshLibrary)

  useEffect(() => {
    refreshLibrary().catch((e) => {
      toastError(e instanceof Error ? e.message : String(e))
    })
  }, [skills]) // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    let result = skills

    if (deployFilter === 'deployed') {
      result = result.filter((s) => managedDeploymentCount(s) > 0)
    } else if (deployFilter === 'undeployed') {
      result = result.filter((s) => managedDeploymentCount(s) === 0)
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
      // 删除当前项后选相邻项:优先下一项,回退上一项
      if (pendingAdjacentSelectRef.current !== null) {
        const idx = pendingAdjacentSelectRef.current
        const next = filtered[idx] ?? filtered[idx - 1] ?? filtered[0]
        pendingAdjacentSelectRef.current = null
        if (next.id !== selectedId) {
          setSelectedId(next.id)
          setDetailTab('sources')
        }
        return
      }
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
    // 守卫 filtered.length > 0:当筛选结果为空时,Effect A 已将 selectedId 置 null,
    // 此处不能再翻回 skills[0].id(它不在 filtered 中),否则会与 Effect A 形成无限循环(#59)。
    if (filtered.length > 0 && skills.length > 0 && selectedId == null && pendingAdjacentSelectRef.current === null) {
      setSelectedId(skills[0].id)
    }
  }, [filtered, skills, selectedId])

  const handleDeployClick = (skill: SkillView) => {
    if (skill.conflict.hasConflict) {
      setConflictTarget(skill)
    } else {
      const primary = skill.conflict.primarySource
      if (primary) {
        setDeployTarget({ skill, sourceId: primary.id })
      }
    }
  }

  const handleConflictConfirm = (source: SkillSourceView) => {
    if (!conflictTarget) return
    setDeployTarget({ skill: conflictTarget, sourceId: source.id })
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
      ? `跳过 — ${result.targetDisplayName} 已是最新`
      : `已部署 (${result.action}) 到 ${result.targetDisplayName}${degradeNote}`
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
      const deployments = (await window.api.getDeploymentsForSkill(skill.id))
        .filter((deployment) => deployment.management === 'managed')
      if (deployments.length === 0) {
        info(`「${skill.name}」没有可取消的受管部署；外部订阅请先在工具页接管`)
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
    const removedId = removeRegistryTarget.id
    // 记录被删项在当前 filtered 中的索引,用于 refresh 后选相邻项
    const removedIndex = filtered.findIndex((s) => s.id === removedId)
    setActionBusy(true)
    try {
      const result = await window.api.removeFromRegistry(removedId)
      const msg = result.backedUp
        ? `已移除「${result.skillName}」(已备份，从 ${result.undeployedTools.length} 个工具取消部署)`
        : `已移除「${result.skillName}」(从 ${result.undeployedTools.length} 个工具取消部署)`
      success(msg)
      await onRefresh()
      if (selectedId === removedId) {
        // refresh 后 skills 已更新;基于旧 filtered 索引选相邻项(优先下一项,回退上一项)
        // skills state 此时已更新,但闭包 filtered 是旧值,用最新 skills 重新过滤
        // 此处用 setSelectedId(null) 会让 effect 选第一条,不符合"选相邻项"
        // 改为延迟到下个 effect 周期基于最新 filtered 选择
        pendingAdjacentSelectRef.current = removedIndex
      }
    } catch (e) {
      toastError(e instanceof Error ? e.message : String(e))
      await onRefresh()
    } finally {
      setRemoveRegistryTarget(null)
      setActionBusy(false)
    }
  }

  const handleUndeployFromTool = async (deploymentId: number) => {
    if (!undeployFromTarget) return
    setActionBusy(true)
    try {
      const deployment = undeployFromTarget.deployments.find((candidate) => candidate.id === deploymentId)
      if (!deployment) throw new Error('部署记录不存在，请刷新后重试')
      const outcome = await window.api.undeploy(deploymentId)
      if (outcome.status !== 'completed') throw new Error(outcome.message)
      const remaining = await window.api.getDeploymentsForSkill(undeployFromTarget.skill.id)
      if (remaining.length === 0) {
        setUndeployFromTarget(null)
      } else {
        setUndeployFromTarget({ ...undeployFromTarget, deployments: remaining })
      }
      await onRefresh()
      success(`已从 ${deployment.target_tool} 取消部署`)
    } catch (e) {
      toastError(e instanceof Error ? e.message : String(e))
      await onRefresh()
    } finally {
      setActionBusy(false)
    }
  }

  const handleInstalled = async (result: InstallResultView) => {
    const msg = result.overwritten
      ? `已安装「${result.skillName}」(覆盖了已有版本)`
      : `已安装「${result.skillName}」`
    success(msg)
    await onRefresh()
  }

  const getMenuActions = (skill: SkillView) => [
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

  const toggleBulkSkill = (skillId: number) => {
    setBulkSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(skillId)) next.delete(skillId)
      else next.add(skillId)
      return next
    })
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

  if (loadError && skills.length === 0) {
    return (
      <EmptyState
        icon={<AlertCircle className="h-8 w-8" />}
        title="加载失败"
        description={loadError}
        action={{ label: '重试', onClick: () => onRetry().catch(() => {}) }}
      />
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
          <Button
            variant={bulkSelecting ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => {
              setBulkSelecting((current) => !current)
              if (bulkSelecting) setBulkSelectedIds(new Set())
            }}
          >
            批量
          </Button>
        </div>

        {bulkSelecting && (
          <div className="p-2 border-b border-border flex items-center gap-2">
            <button
              className="text-2xs text-primary"
              onClick={() => setBulkSelectedIds(new Set(filtered.map((skill) => skill.id)))}
            >
              全选当前
            </button>
            <span className="text-2xs text-foreground-muted flex-1">已选 {bulkSelectedIds.size}</span>
            <Button
              variant="primary"
              size="sm"
              disabled={bulkSelectedIds.size === 0}
              onClick={() => setBulkActionsOpen(true)}
            >
              操作
            </Button>
          </div>
        )}

        {batchFlow.plan.length > 0 && (
          <div className="p-2 border-b border-border">
            <Button variant="primary" size="sm" className="w-full" onClick={batchFlow.open}>
              批量整理 ({batchFlow.plan.length})
            </Button>
          </div>
        )}

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
                selecting={bulkSelecting}
                checked={bulkSelectedIds.has(skill.id)}
                matchReason={getMatchReason(skill)}
                onSelect={() => bulkSelecting ? toggleBulkSkill(skill.id) : setSelectedId(skill.id)}
                onToggleChecked={() => toggleBulkSkill(skill.id)}
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
            consolidationBatches={consolidationFlow.batches}
            sourceRelocations={relocationFlow.relocations}
            tab={detailTab}
            onTabChange={setDetailTab}
            onDeploy={() => handleDeployClick(selected)}
            onConsolidate={(source) => consolidationFlow.open(selected, source)}
            onUndoConsolidation={consolidationFlow.setUndoBatch}
            onRelocate={(source) => relocationFlow.open(selected, source)}
            onUndoRelocation={relocationFlow.setUndo}
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
          sourceId={deployTarget.sourceId}
          onDone={handleDeployDone}
        />
      )}

      {installOpen && (
        <InstallDialogContent
          initialTab={installInitialTab}
          onInstalled={handleInstalled}
          onRefresh={onRefresh}
          onClose={() => setInstallOpen(false)}
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

      {bulkActionsOpen && (
        <BulkSkillActionsDialog
          skills={skills.filter((skill) => bulkSelectedIds.has(skill.id))}
          onRefresh={onRefresh}
          onClose={() => setBulkActionsOpen(false)}
        />
      )}

      {consolidationFlow.target && (
        <ConsolidationDialog
          skill={consolidationFlow.target.skill}
          source={consolidationFlow.target.source}
          preview={consolidationFlow.preview}
          busy={actionBusy}
          onPreview={consolidationFlow.handlePreview}
          onConfirm={consolidationFlow.handleConfirm}
          onClose={consolidationFlow.close}
        />
      )}

      {batchFlow.drafts && (
        <BatchConsolidationDialog
          drafts={batchFlow.drafts}
          preview={batchFlow.preview}
          busy={actionBusy}
          onApplyBatchParent={batchFlow.applyBatchParent}
          onToggleDraft={batchFlow.toggleDraft}
          onDraftParentChange={batchFlow.draftParentChange}
          onResolveConflict={conflictFlow.open}
          onPreview={batchFlow.handlePreview}
          onConfirm={batchFlow.handleConfirm}
          onClose={batchFlow.close}
        />
      )}

      {conflictFlow.editor && (
        <ConflictResolutionDialog
          editor={conflictFlow.editor}
          busy={actionBusy}
          onEditorChange={conflictFlow.updateEditor}
          onApply={conflictFlow.apply}
          onClose={conflictFlow.close}
        />
      )}

      {consolidationFlow.undoBatch && (
        <UndoConsolidationDialog
          undoBatch={consolidationFlow.undoBatch}
          busy={actionBusy}
          onConfirm={consolidationFlow.handleUndo}
          onClose={() => { if (!actionBusy) consolidationFlow.setUndoBatch(null) }}
        />
      )}

      {relocationFlow.target && (
        <SourceRelocationDialog
          skill={relocationFlow.target.skill}
          source={relocationFlow.target.source}
          preview={relocationFlow.preview}
          busy={actionBusy}
          onPreview={relocationFlow.handlePreview}
          onConfirm={relocationFlow.handleConfirm}
          onClose={relocationFlow.close}
        />
      )}

      {relocationFlow.undo && (
        <UndoRelocationDialog
          relocation={relocationFlow.undo}
          busy={actionBusy}
          onConfirm={relocationFlow.handleUndo}
          onClose={() => { if (!actionBusy) relocationFlow.setUndo(null) }}
        />
      )}
    </div>
  )
}

function SkillMasterItem({
  skill,
  selected,
  selecting,
  checked,
  matchReason,
  onSelect,
  onToggleChecked,
  onContextMenu
}: {
  skill: SkillView
  selected: boolean
  selecting: boolean
  checked: boolean
  matchReason: string | null
  onSelect: () => void
  onToggleChecked: () => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  const managedCount = managedDeploymentCount(skill)
  const observedCount = skill.deployments.filter((deployment) => deployment.management === 'observed').length
  const deployed = managedCount > 0
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
          {selecting && (
            <input
              type="checkbox"
              aria-label={`选择 ${skill.name}`}
              checked={checked}
              onClick={(event) => event.stopPropagation()}
              onChange={onToggleChecked}
            />
          )}
          <StatusDot
            variant={deployed ? 'success' : observedCount > 0 ? 'warning' : 'neutral'}
            label={deployed
              ? `已部署 · ${managedCount}${observedCount > 0 ? ` · 外部订阅 ${observedCount}` : ''}`
              : observedCount > 0 ? `外部订阅 · ${observedCount}` : '未部署'}
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
  consolidationBatches,
  sourceRelocations,
  tab,
  onTabChange,
  onDeploy,
  onConsolidate,
  onUndoConsolidation,
  onRelocate,
  onUndoRelocation,
  onMoreClick
}: {
  skill: SkillView
  consolidationBatches: ConsolidationBatch[]
  sourceRelocations: SourceRelocation[]
  tab: string
  onTabChange: (tab: string) => void
  onDeploy: () => void
  onConsolidate: (source: SkillSourceView) => void
  onUndoConsolidation: (batch: UndoBatch) => void
  onRelocate: (source: SkillSourceView) => void
  onUndoRelocation: (relocation: SourceRelocation) => void
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
          { key: 'deployments', label: `目标关系 (${skill.deployments.length})` },
        ]}
        activeKey={tab}
        onChange={onTabChange}
      />

      <div className="flex-1 overflow-auto p-4">
        {tab === 'sources' && (
          <SourcePanel
            skill={skill}
            consolidationBatches={consolidationBatches}
            sourceRelocations={sourceRelocations}
            onConsolidate={onConsolidate}
            onUndoConsolidation={onUndoConsolidation}
            onRelocate={onRelocate}
            onUndoRelocation={onUndoRelocation}
          />
        )}
        {tab === 'deployments' && <DeploymentPanel skill={skill} />}
      </div>
    </div>
  )
}

function SourcePanel({
  skill,
  consolidationBatches,
  sourceRelocations,
  onConsolidate,
  onUndoConsolidation,
  onRelocate,
  onUndoRelocation
}: {
  skill: SkillView
  consolidationBatches: ConsolidationBatch[]
  sourceRelocations: SourceRelocation[]
  onConsolidate: (source: SkillSourceView) => void
  onUndoConsolidation: (batch: UndoBatch) => void
  onRelocate: (source: SkillSourceView) => void
  onUndoRelocation: (relocation: SourceRelocation) => void
}) {
  if (skill.sources.length === 0) {
    return <p className="text-xs text-foreground-muted">未登记任何来源。</p>
  }

  const hashGroups = groupByHash(skill.sources)
  const distinctVersions = hashGroups.size
  const latestCompletedBatch = consolidationBatches
    .flatMap((batch) => batch.items
      .filter((item) => item.skillId === skill.id)
      .map((item) => ({ batch, item })))
    .filter(({ batch }) => batch.status === 'completed')
    .sort((a, b) => Date.parse(b.batch.completedAt ?? b.batch.createdAt) - Date.parse(a.batch.completedAt ?? a.batch.createdAt))[0] ?? null
  const latestCompletedRelocation = sourceRelocations
    .filter((relocation) => relocation.skillId === skill.id && relocation.status === 'completed')
    .sort((a, b) => Date.parse(b.completedAt ?? b.createdAt) - Date.parse(a.completedAt ?? a.createdAt))[0] ?? null
  const hasExactlyOneCandidate = skill.sources.filter((source) => source.source_role === 'candidate').length === 1
  const hasCanonical = skill.sources.some((source) => source.source_role === 'canonical')
  const renderSource = (source: SkillSourceView) => (
    <SourceItem
      key={source.id}
      source={source}
      canConsolidate={source.source_role === 'candidate' && hasExactlyOneCandidate && !hasCanonical && !skill.conflict.hasConflict}
      undoBatch={source.source_role === 'canonical' && !latestCompletedRelocation ? latestCompletedBatch : null}
      canRelocate={source.source_role === 'canonical'}
      undoRelocation={source.source_role === 'canonical' ? latestCompletedRelocation : null}
      onConsolidate={() => onConsolidate(source)}
      onUndoConsolidation={onUndoConsolidation}
      onRelocate={() => onRelocate(source)}
      onUndoRelocation={onUndoRelocation}
    />
  )

  // 单版本:保持平铺,不显示分组结构
  if (distinctVersions <= 1) {
    return (
      <div className="space-y-2">
        {skill.sources.map(renderSource)}
      </div>
    )
  }

  // 多版本:按 hash 分组渲染,同组聚拢、异组分隔
  const groups = Array.from(hashGroups.entries())
  const versionLabels = 'ABCDEFGH'

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 text-2xs text-warning">
        <AlertCircle className="h-3 w-3" />
        {distinctVersions} 个不同版本
      </div>
      {groups.map(([hash, sources], idx) => {
        const label = versionLabels[idx] ?? String(idx + 1)
        return (
          <div key={hash} className="border border-border rounded-md overflow-hidden">
            <div className="px-2.5 py-1.5 bg-surface-secondary border-b border-border flex items-center gap-2">
              <span className="text-2xs font-semibold text-foreground-secondary">
                版本 {label}
              </span>
              <span className="text-2xs text-foreground-muted">
                · {sources.length} 个来源
              </span>
              <code className="text-2xs font-mono text-foreground-muted ml-auto">
                hash: {shortHash(hash)}
              </code>
            </div>
            <div className="p-2 space-y-2 bg-surface">
              {sources.map(renderSource)}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function SourceItem({
  source,
  canConsolidate,
  undoBatch,
  canRelocate,
  undoRelocation,
  onConsolidate,
  onUndoConsolidation,
  onRelocate,
  onUndoRelocation
}: {
  source: SkillSourceView
  canConsolidate: boolean
  undoBatch: UndoBatch | null
  canRelocate: boolean
  undoRelocation: SourceRelocation | null
  onConsolidate: () => void
  onUndoConsolidation: (batch: UndoBatch) => void
  onRelocate: () => void
  onUndoRelocation: (relocation: SourceRelocation) => void
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="border border-border rounded-md">
      <div className="flex items-center hover:bg-surface-hover transition-colors duration-fast">
        <button
          className="flex-1 flex items-center justify-between p-2.5 text-left min-w-0"
          onClick={() => setExpanded(!expanded)}
        >
        <div className="flex items-center gap-2 min-w-0">
          <span className={`text-2xs px-1.5 py-0.5 rounded-full border ${
            source.source_role === 'canonical'
              ? 'bg-primary-subtle text-primary border-primary/20'
              : 'bg-warning-subtle text-warning border-warning/20'
          }`}>
            {sourceRoleLabel(source.source_role)}
          </span>
          <span className="text-2xs px-1.5 py-0.5 rounded-full bg-surface-secondary text-foreground-secondary border border-border-subtle">
            {sourceOriginLabel(source.source_origin)}
          </span>
          <code className="text-xs font-mono text-foreground truncate">{source.path}</code>
        </div>
          {expanded ? <ChevronDown className="h-3.5 w-3.5 text-foreground-muted shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-foreground-muted shrink-0" />}
        </button>
        {canConsolidate && (
          <Button variant="secondary" size="sm" className="mr-2" onClick={onConsolidate}>整理</Button>
        )}
        {undoBatch && (
          <Button variant="secondary" size="sm" className="mr-2" onClick={() => onUndoConsolidation(undoBatch)}>撤销整理</Button>
        )}
        {canRelocate && (
          <Button variant="secondary" size="sm" className="mr-2" onClick={onRelocate}>移动权威 Source</Button>
        )}
        {undoRelocation && (
          <Button variant="secondary" size="sm" className="mr-2" onClick={() => onUndoRelocation(undoRelocation)}>撤销移动</Button>
        )}
      </div>
      {expanded && (
        <div className="border-t border-border p-2.5 space-y-1">
          <MetaRow icon={Hash} label="hash" value={source.hash} />
          <MetaRow icon={Calendar} label="mtime" value={new Date(source.mtime).toLocaleString()} />
          {source.repo_url && <MetaRow icon={GitBranch} label="repo" value={source.repo_url} />}
          {source.commit_sha && <MetaRow icon={GitBranch} label="sha" value={source.commit_sha.slice(0, 12)} />}
          <MetaRow icon={Calendar} label="发现时间" value={new Date(source.discovered_at).toLocaleString()} />
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
    return <p className="text-xs text-foreground-muted">没有受管部署或外部订阅。</p>
  }

  return (
    <div className="space-y-2">
      {skill.deployments.map((dep) => {
        const status = getDriftStatus(dep.status)
        return (
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
                {dep.management === 'observed' && (
                  <span className="text-2xs px-1.5 py-0.5 rounded bg-warning-subtle text-warning">
                    外部订阅
                  </span>
                )}
              </div>
              <StatusDot variant={status.variant} label={status.label} />
            </div>
            <div className="space-y-1">
              <MetaRow icon={ExternalLink} label="目标路径" value={dep.target_path ?? ''} />
              <MetaRow
                icon={Calendar}
                label={dep.management === 'observed' ? '观察时间' : '部署时间'}
                value={new Date(dep.deployed_at).toLocaleString()}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
