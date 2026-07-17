import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, ChevronRight, ChevronDown, Wrench, FolderTree, Plus } from 'lucide-react'
import { Button, Input, StatusDot, EmptyState, Skeleton, Dialog, getDriftStatus } from '../../shared'
import { useToast } from '../../app/Toast'
import { type DriftKey, driftKeyEquals } from './driftKey'

type ToolWithDriftsView = Awaited<ReturnType<typeof window.api.getTools>>[number]
type DriftStatusView = ToolWithDriftsView['drifts'][number]
type ConfirmationRequiredView = Extract<Awaited<ReturnType<typeof window.api.deploymentConfirm>>, { status: 'confirmation-required' }>
type BulkAdoptionPreviewView = Extract<Awaited<ReturnType<typeof window.api.previewBulkAdoption>>, { status: 'confirmation-required' }>
type BulkAdoptionResultView = Extract<Awaited<ReturnType<typeof window.api.confirmBulkAdoption>>, { status: 'completed' }>
type SettingsView = Awaited<ReturnType<typeof window.api.getSettings>>
type ToolConfigView = SettingsView['tools'][number]
type SourceRootView = Awaited<ReturnType<typeof window.api.getSourceRoots>>[number]

// #116:工具页集中「工具启用 / 发现目录 / 外部订阅 / 受管 Deployment 状态」,
// 让工具相关配置不再混入全局设置。
export function ToolsPage({
  tools,
  loading,
  onRefresh
}: {
  tools: ToolWithDriftsView[]
  loading: boolean
  onRefresh: () => Promise<void>
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [busyKey, setBusyKey] = useState<DriftKey | null>(null)
  const [confirmUndeploy, setConfirmUndeploy] = useState<{ deploymentId: number; skillId: number; targetTool: string; skillName: string } | null>(null)
  const [confirmRemoveManifest, setConfirmRemoveManifest] = useState<{ deploymentId: number; skillId: number; targetTool: string; skillName: string; targetPath: string; staleTarget: boolean } | null>(null)
  const [confirmRedeploy, setConfirmRedeploy] = useState<{ deploymentId: number; skillId: number; targetTool: string; skillName: string } | null>(null)
  const [confirmAdopt, setConfirmAdopt] = useState<{ deploymentId: number; skillId: number; targetTool: string; skillName: string } | null>(null)
  const [redeployRisk, setRedeployRisk] = useState<ConfirmationRequiredView | null>(null)
  const [bulkPreview, setBulkPreview] = useState<BulkAdoptionPreviewView | null>(null)
  const [bulkResult, setBulkResult] = useState<BulkAdoptionResultView | null>(null)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkFacts, setBulkFacts] = useState<Awaited<ReturnType<typeof window.api.getBulkAdoptionFacts>>>({ total: 0, tools: [] })

  // 工具配置 + 发现目录(原设置页内容)
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [configBusy, setConfigBusy] = useState(false)
  const [newToolKey, setNewToolKey] = useState('')
  const [newToolName, setNewToolName] = useState('')
  const [newToolPaths, setNewToolPaths] = useState('')
  const [editingPaths, setEditingPaths] = useState<Record<string, string>>({})
  const [sourceRoots, setSourceRoots] = useState<SourceRootView[]>([])
  const [sourceRootBusy, setSourceRootBusy] = useState(false)
  const [sourceRootMessage, setSourceRootMessage] = useState<string | null>(null)

  const { success, error: toastError, info } = useToast()
  const observedCount = bulkFacts.total

  const refreshBulkFacts = async () => {
    setBulkFacts(await window.api.getBulkAdoptionFacts())
  }

  const loadConfig = useCallback(async () => {
    const [s, roots] = await Promise.all([
      window.api.getSettings(),
      window.api.getSourceRoots()
    ])
    setSettings(s)
    setSourceRoots(roots)
    const pathsMap: Record<string, string> = {}
    for (const t of s.tools) {
      pathsMap[t.key] = t.paths.join('\n')
    }
    setEditingPaths(pathsMap)
  }, [])

  useEffect(() => {
    void refreshBulkFacts().catch((error) => toastError(error instanceof Error ? error.message : String(error)))
    void loadConfig().catch((error) => toastError(error instanceof Error ? error.message : String(error)))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const refreshPage = async () => {
    await onRefresh()
    await refreshBulkFacts()
  }

  const runConfig = async (fn: () => Promise<SettingsView>) => {
    setConfigBusy(true)
    try {
      const s = await fn()
      setSettings(s)
      const pathsMap: Record<string, string> = {}
      for (const t of s.tools) {
        pathsMap[t.key] = t.paths.join('\n')
      }
      setEditingPaths(pathsMap)
      // 工具启用/路径变化会影响 ToolCard 的 enabled/exists 展示,刷新工具读模型
      await onRefresh()
    } finally {
      setConfigBusy(false)
    }
  }

  const handleToggle = (key: string, enabled: boolean) =>
    runConfig(() => window.api.setPresetEnabled(key, enabled))

  const handleSavePaths = (key: string) => {
    const raw = editingPaths[key] ?? ''
    const paths = raw.split('\n').map((p) => p.trim()).filter((p) => p.length > 0)
    runConfig(() => window.api.setPresetPaths(key, paths))
  }

  const handleAddCustom = () => {
    const paths = newToolPaths.split('\n').map((p) => p.trim()).filter((p) => p.length > 0)
    if (!newToolKey.trim() || !newToolName.trim() || paths.length === 0) return
    runConfig(() =>
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
    runConfig(() => window.api.removeCustomTool(key))

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

  const toggleExpand = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const handleUndeploy = async () => {
    if (!confirmUndeploy) return
    const { deploymentId, skillId, targetTool } = confirmUndeploy
    setBusyKey({ skillId, targetTool })
    try {
      const outcome = await window.api.undeploy(deploymentId)
      if (outcome.status !== 'completed') throw new Error(outcome.message)
      await refreshPage()
      success(`已从 ${targetTool} 取消部署`)
      setConfirmUndeploy(null)
    } catch (e) {
      toastError(e instanceof Error ? e.message : String(e))
      await refreshPage()
    } finally {
      setBusyKey(null)
    }
  }

  const handleRemoveFromManifest = async () => {
    if (!confirmRemoveManifest) return
    const { deploymentId, skillId, targetTool, staleTarget } = confirmRemoveManifest
    setBusyKey({ skillId, targetTool })
    try {
      if (staleTarget) {
        const outcome = await window.api.detachStaleDeployment(deploymentId)
        if (outcome.status !== 'completed') throw new Error(outcome.message)
      } else {
        await window.api.removeFromManifest(deploymentId)
      }
      await refreshPage()
      success('已从清单移除')
      setConfirmRemoveManifest(null)
    } catch (e) {
      toastError(e instanceof Error ? e.message : String(e))
      await refreshPage()
    } finally {
      setBusyKey(null)
    }
  }

  const handleRedeploy = async () => {
    if (!confirmRedeploy) return
    const { deploymentId, skillId, targetTool } = confirmRedeploy
    setBusyKey({ skillId, targetTool })
    try {
      const outcome = await window.api.redeploy(deploymentId)
      if (outcome.status === 'confirmation-required') {
        setRedeployRisk(outcome)
        return
      }
      if (outcome.status !== 'completed') throw new Error(outcome.message)
      await onRefresh()
      success(`已重新部署`)
      setConfirmRedeploy(null)
    } catch (e) {
      toastError(e instanceof Error ? e.message : String(e))
      await onRefresh()
    } finally {
      setBusyKey(null)
    }
  }

  const handleAdopt = async () => {
    if (!confirmAdopt) return
    const { deploymentId, skillId, targetTool } = confirmAdopt
    setBusyKey({ skillId, targetTool })
    try {
      const outcome = await window.api.adoptDeployment(deploymentId)
      if (outcome.status !== 'completed') throw new Error(outcome.message)
      await refreshPage()
      success('已接管外部订阅')
      setConfirmAdopt(null)
    } catch (e) {
      toastError(e instanceof Error ? e.message : String(e))
      await refreshPage()
    } finally {
      setBusyKey(null)
    }
  }

  const handleBulkPreview = async () => {
    setBulkBusy(true)
    try {
      const outcome = await window.api.previewBulkAdoption()
      setBulkFacts(outcome.facts)
      setBulkResult(null)
      if (outcome.status === 'empty') {
        setBulkPreview(null)
        info('当前没有可接管的外部订阅')
        return
      }
      setBulkPreview(outcome)
    } catch (e) {
      toastError(e instanceof Error ? e.message : String(e))
    } finally {
      setBulkBusy(false)
    }
  }

  const handleBulkConfirm = async () => {
    if (!bulkPreview) return
    setBulkBusy(true)
    try {
      const outcome = await window.api.confirmBulkAdoption(bulkPreview.confirmationId)
      if (outcome.status !== 'completed') throw new Error(outcome.message)
      setBulkPreview(null)
      setBulkResult(outcome)
      await refreshPage()
      if (outcome.failed.length === 0) success(`已接管 ${outcome.adopted.length} 个外部订阅`)
    } catch (e) {
      toastError(e instanceof Error ? e.message : String(e))
    } finally {
      setBulkBusy(false)
    }
  }

  const handleRedeployRiskConfirm = async () => {
    if (!redeployRisk) return
    if (confirmRedeploy) setBusyKey({ skillId: confirmRedeploy.skillId, targetTool: confirmRedeploy.targetTool })
    try {
      const outcome = await window.api.deploymentConfirm(redeployRisk.confirmationId)
      if (outcome.status === 'confirmation-required') {
        setRedeployRisk(outcome)
        return
      }
      if (outcome.status !== 'completed') throw new Error(outcome.message)
      setRedeployRisk(null)
      setConfirmRedeploy(null)
      await onRefresh()
      success('已重新部署')
    } catch (e) {
      toastError(e instanceof Error ? e.message : String(e))
      await onRefresh()
    } finally {
      setBusyKey(null)
    }
  }

  const redeployRiskDescription = redeployRisk == null ? '' : [
    ...redeployRisk.facts.reasons.map((reason) => ({
      'external-overwrite': '目标包含外部内容，将覆盖现有内容。',
      'target-modified': '部署目标已被修改，将用当前来源覆盖。',
      'mode-degraded': `请求模式 ${redeployRisk.facts.requestedMode} 不可用，实际将使用 ${redeployRisk.facts.actualMode}。`
    })[reason]),
    `目标：${redeployRisk.facts.targetDisplayName}`,
    redeployRisk.facts.backup.required
      ? `覆盖前会备份到：${redeployRisk.facts.backup.directory ?? '应用备份目录'}`
      : '本次不会创建外部内容备份。'
  ].join('\n')

  if (loading) {
    return (
      <div className="h-full overflow-auto">
        <Skeleton lines={6} />
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Wrench className="h-4 w-4 text-foreground-secondary" />
          <h2 className="text-sm font-semibold">工具</h2>
        </div>
        <div className="flex items-center gap-2">
          {observedCount > 0 && (
            <Button variant="primary" size="sm" onClick={handleBulkPreview} disabled={bulkBusy}>
              一键接管 {observedCount} 个外部订阅
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={refreshPage} icon={<RefreshCw className="h-3 w-3" />}>
            刷新
          </Button>
        </div>
      </div>

      <section className="mb-8">
        <h3 className="text-xs font-semibold text-foreground mb-3">工具配置</h3>
        {settings && settings.tools.length > 0 ? (
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
                busy={configBusy}
              />
            ))}
          </ul>
        ) : (
          <div className="border border-dashed border-border rounded-md p-4 text-xs text-foreground-muted">
            尚未配置任何工具。
          </div>
        )}

        <div className="mt-4 border border-dashed border-border rounded-md p-3">
          <h4 className="text-xs font-semibold text-foreground mb-2">添加自定义工具</h4>
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
          <Button variant="primary" onClick={handleAddCustom} disabled={configBusy} size="sm" icon={<Plus className="h-3 w-3" />}>
            添加
          </Button>
        </div>
      </section>

      <section className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold text-foreground">发现目录</h3>
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

      <section>
        <div className="flex items-center gap-2 mb-3">
          <FolderTree className="h-3.5 w-3.5 text-foreground-secondary" />
          <h3 className="text-xs font-semibold text-foreground">部署关系</h3>
        </div>
        {tools.length === 0 ? (
          <EmptyState
            icon={<Wrench className="h-8 w-8" />}
            title="暂无部署关系"
            description="启用工具并扫描后，受管部署与外部订阅会显示在这里。"
          />
        ) : (
          <ul className="space-y-2">
            {tools.map((tool) => (
              <ToolCard
                key={tool.config.key}
                tool={tool}
                expanded={expanded.has(tool.config.key)}
                onToggleExpand={() => toggleExpand(tool.config.key)}
                busyKey={busyKey}
                onUndeploy={(deploymentId, skillId, targetTool, skillName) => setConfirmUndeploy({ deploymentId, skillId, targetTool, skillName })}
                onRedeploy={(deploymentId, skillId, targetTool, skillName) => setConfirmRedeploy({ deploymentId, skillId, targetTool, skillName })}
                onRemoveFromManifest={(deploymentId, skillId, targetTool, skillName, targetPath, staleTarget) =>
                  setConfirmRemoveManifest({ deploymentId, skillId, targetTool, skillName, targetPath, staleTarget })}
                onAdopt={(deploymentId, skillId, targetTool, skillName) => setConfirmAdopt({ deploymentId, skillId, targetTool, skillName })}
              />
            ))}
          </ul>
        )}
      </section>

      <Dialog
        open={bulkPreview !== null}
        onClose={() => setBulkPreview(null)}
        title="一键接管外部订阅"
        description={`共 ${bulkPreview?.facts.total ?? 0} 个外部订阅；确认时会逐条重新校验，失败项不会影响其他项。接管不会修改文件或链接。`}
        confirmLabel="确认接管全部"
        onConfirm={handleBulkConfirm}
        busy={bulkBusy}
        closeOnOverlay={false}
      >
        <div className="space-y-3">
          {bulkPreview?.facts.tools.map((tool) => (
            <section key={tool.targetTool}>
              <h4 className="text-xs font-semibold text-foreground">
                {tool.targetDisplayName} · {tool.items.length}
              </h4>
              <ul className="mt-1 space-y-1">
                {tool.items.map((item) => (
                  <li key={item.deploymentId} className="text-xs text-foreground-secondary">
                    <div>{item.skillName}</div>
                    <div className="text-2xs text-foreground-muted">{item.targetId} · {item.targetPath}</div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </Dialog>

      <Dialog
        open={bulkResult !== null}
        onClose={() => setBulkResult(null)}
        title="批量接管结果"
        description={`已接管 ${bulkResult?.adopted.length ?? 0} 个，失败 ${bulkResult?.failed.length ?? 0} 个`}
        confirmLabel={(bulkResult?.failed.length ?? 0) > 0 ? '重试剩余' : '完成'}
        onConfirm={(bulkResult?.failed.length ?? 0) > 0 ? handleBulkPreview : () => setBulkResult(null)}
        hideCancel
        busy={bulkBusy}
        closeOnOverlay={false}
      >
        {(bulkResult?.failed.length ?? 0) > 0 && (
          <ul className="space-y-1">
            {bulkResult?.failed.map((item) => (
              <li key={item.deploymentId} className="text-xs text-warning">
                {item.skillName}：{item.message}
              </li>
            ))}
          </ul>
        )}
      </Dialog>

      <Dialog
        open={confirmAdopt !== null}
        onClose={() => setConfirmAdopt(null)}
        title={`接管 ${confirmAdopt?.targetTool ?? ''} 的外部订阅「${confirmAdopt?.skillName ?? ''}」?`}
        description="接管前会重新校验链接仍指向登记的权威 Source；接管不会重建链接或修改文件。接管后才允许重新部署和取消部署。"
        confirmLabel="接管"
        onConfirm={handleAdopt}
        busy={driftKeyEquals(busyKey, confirmAdopt)}
        closeOnOverlay={false}
      />

      <Dialog
        open={confirmUndeploy !== null}
        onClose={() => setConfirmUndeploy(null)}
        title={`从 ${confirmUndeploy?.targetTool ?? ''} 取消部署「${confirmUndeploy?.skillName ?? ''}」?`}
        description="此操作只移除部署（链接/副本），不删源文件。"
        variant="danger"
        confirmLabel="取消部署"
        onConfirm={handleUndeploy}
        busy={driftKeyEquals(busyKey, confirmUndeploy)}
        closeOnOverlay={false}
      />

      <Dialog
        open={confirmRemoveManifest !== null}
        onClose={() => setConfirmRemoveManifest(null)}
        title={`${confirmRemoveManifest?.staleTarget ? '解除陈旧目标登记' : `从 ${confirmRemoveManifest?.targetTool ?? ''} 清单移除`}「${confirmRemoveManifest?.skillName ?? ''}」?`}
        description={confirmRemoveManifest?.staleTarget
          ? `原 Discovery Target 已从设置中移除：\n${confirmRemoveManifest.targetPath}\n此操作只解除关系登记，不删除 Source 或任何磁盘内容。`
          : '目标已从磁盘移除，此操作只清理清单记录。'}
        confirmLabel={confirmRemoveManifest?.staleTarget ? '确认解除登记' : '移除'}
        onConfirm={handleRemoveFromManifest}
        busy={driftKeyEquals(busyKey, confirmRemoveManifest)}
      />

      <Dialog
        open={confirmRedeploy !== null}
        onClose={() => setConfirmRedeploy(null)}
        title={`重新部署「${confirmRedeploy?.skillName ?? ''}」到 ${confirmRedeploy?.targetTool ?? ''}?`}
        confirmLabel="重新部署"
        onConfirm={handleRedeploy}
        busy={driftKeyEquals(busyKey, confirmRedeploy)}
      />

      <Dialog
        open={redeployRisk !== null}
        onClose={() => setRedeployRisk(null)}
        title={`确认重新部署风险「${confirmRedeploy?.skillName ?? ''}」?`}
        description={redeployRiskDescription}
        variant="danger"
        confirmLabel="确认并重新部署"
        onConfirm={handleRedeployRiskConfirm}
        busy={driftKeyEquals(busyKey, confirmRedeploy)}
        closeOnOverlay={false}
      />
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

function ToolCard({
  tool,
  expanded,
  onToggleExpand,
  busyKey,
  onUndeploy,
  onRedeploy,
  onRemoveFromManifest,
  onAdopt
}: {
  tool: ToolWithDriftsView
  expanded: boolean
  onToggleExpand: () => void
  busyKey: DriftKey | null
  onUndeploy: (deploymentId: number, skillId: number, targetTool: string, skillName: string) => void
  onRedeploy: (deploymentId: number, skillId: number, targetTool: string, skillName: string) => void
  onRemoveFromManifest: (deploymentId: number, skillId: number, targetTool: string, skillName: string, targetPath: string, staleTarget: boolean) => void
  onAdopt: (deploymentId: number, skillId: number, targetTool: string, skillName: string) => void
}) {
  const { config, drifts } = tool
  const managed = drifts.filter((d) => d.kind !== 'external' && d.deployment?.management !== 'observed')
  const observed = drifts.filter((d) => d.deployment?.management === 'observed')
  const external = drifts.filter((d) => d.kind === 'external')
  const driftCount = managed.filter((d) => d.kind !== 'normal').length

  if (!config.enabled || !config.exists) {
    return (
      <li className="border border-border rounded-md p-3 bg-surface-secondary opacity-60">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-foreground-secondary">{config.displayName}</span>
          {!config.exists && (
            <span className="text-2xs px-1.5 py-0.5 rounded-full bg-surface text-foreground-muted">缺失</span>
          )}
          {config.enabled && config.exists && (
            <span className="text-xs text-foreground-muted">无 skill 目录</span>
          )}
        </div>
      </li>
    )
  }

  return (
    <li className="border border-border rounded-md">
      <button
        className="w-full flex items-center justify-between p-3 text-left hover:bg-surface-hover transition-colors duration-fast"
        onClick={onToggleExpand}
      >
        <div className="flex items-center gap-2">
          {expanded ? <ChevronDown className="h-3.5 w-3.5 text-foreground-muted" /> : <ChevronRight className="h-3.5 w-3.5 text-foreground-muted" />}
          <span className="text-sm font-medium text-foreground">{config.displayName}</span>
          <StatusDot variant="success" label="已发现" />
          {driftCount > 0 && (
            <span className="text-2xs px-1.5 py-0.5 rounded-full bg-warning-subtle text-warning font-medium">
              {driftCount} 个异常
            </span>
          )}
          {external.length > 0 && (
            <span className="text-2xs px-1.5 py-0.5 rounded-full bg-primary-subtle text-primary font-medium">
              {external.length} 个外部
            </span>
          )}
          {observed.length > 0 && (
            <span className="text-2xs px-1.5 py-0.5 rounded-full bg-warning-subtle text-warning font-medium">
              {observed.length} 个外部订阅
            </span>
          )}
        </div>
        <span className="text-xs text-foreground-muted">
          已部署 {managed.length} · 共 {drifts.length}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border p-3">
          <div className="text-2xs text-foreground-muted mb-2 space-y-0.5">
            {config.existingPaths.map((path: string) => (
              <div key={path} className="font-mono">{path}</div>
            ))}
          </div>
          {drifts.length === 0 ? (
            <p className="text-xs text-foreground-muted">该工具目录下无 skill。</p>
          ) : (
            <>
              {managed.length > 0 && (
                <ul className="space-y-1.5 mb-3">
                  {managed.map((d) => (
                    <DriftItem
                      key={`managed:${d.deployment?.id ?? `${d.skillId}:${d.skillName}`}`}
                      drift={d}
                      busy={driftKeyEquals(busyKey, { skillId: d.skillId, targetTool: d.targetTool })}
                      onUndeploy={() => d.deployment && onUndeploy(d.deployment.id, d.skillId, d.targetTool, d.skillName)}
                      onRedeploy={() => d.deployment && onRedeploy(d.deployment.id, d.skillId, d.targetTool, d.skillName)}
                      onRemoveFromManifest={() => d.deployment && onRemoveFromManifest(
                        d.deployment.id,
                        d.skillId,
                        d.targetTool,
                        d.skillName,
                        d.targetPath,
                        d.kind === 'target-unconfigured'
                      )}
                    />
                  ))}
                </ul>
              )}
              {observed.length > 0 && (
                <div className="border-t border-border-subtle pt-2 mb-3">
                  <p className="text-2xs font-semibold text-foreground-muted uppercase mb-1.5">
                    外部订阅（只读，接管后可变更）
                  </p>
                  <ul className="space-y-1.5">
                    {observed.map((d) => (
                      <DriftItem
                        key={`observed:${d.deployment!.id}`}
                        drift={d}
                        busy={driftKeyEquals(busyKey, { skillId: d.skillId, targetTool: d.targetTool })}
                        onRemoveFromManifest={() => onRemoveFromManifest(
                          d.deployment!.id,
                          d.skillId,
                          d.targetTool,
                          d.skillName,
                          d.targetPath,
                          d.kind === 'target-unconfigured'
                        )}
                        onAdopt={() => onAdopt(d.deployment!.id, d.skillId, d.targetTool, d.skillName)}
                      />
                    ))}
                  </ul>
                </div>
              )}
              {external.length > 0 && (
                <div className="border-t border-border-subtle pt-2">
                  <p className="text-2xs font-semibold text-foreground-muted uppercase mb-1.5">
                    外部 skill（skill-switch 未管理）
                  </p>
                  <ul className="space-y-1.5">
                    {external.map((d) => (
                      <DriftItem
                        key={`ext:${d.skillName}`}
                        drift={d}
                        busy={false}
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

function DriftItem({
  drift,
  busy,
  onUndeploy,
  onRedeploy,
  onRemoveFromManifest,
  onAdopt
}: {
  drift: DriftStatusView
  busy: boolean
  onUndeploy?: () => void
  onRedeploy?: () => void
  onRemoveFromManifest?: () => void
  onAdopt?: () => void
}) {
  const status = getDriftStatus(drift.kind)
  const isExternal = drift.kind === 'external'
  const isDrift = drift.kind === 'drift'
  const isObserved = drift.deployment?.management === 'observed'

  return (
    <li className={`flex items-center justify-between bg-surface border border-border rounded px-2.5 py-1.5 ${isDrift ? 'opacity-50' : ''}`}>
      <div className="flex items-center gap-2 min-w-0">
        <StatusDot variant={status.variant} label={status.label} />
        <span className="text-xs font-medium text-foreground truncate">{drift.skillName}</span>
        {drift.deployment && (
          <span className="text-2xs text-foreground-secondary">{drift.deployment.mode}</span>
        )}
        {isObserved && (
          <span className="text-2xs px-1.5 py-0.5 rounded bg-warning-subtle text-warning">外部订阅</span>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {!isObserved && onRedeploy && (drift.kind === 'drift' || drift.kind === 'target-modified' || drift.kind === 'link-mismatch') && (
          <>
            <Button variant="primary" size="sm" onClick={onRedeploy} disabled={busy}>
              重新部署
            </Button>
            {drift.kind === 'drift' && onRemoveFromManifest && (
              <Button variant="secondary" size="sm" onClick={onRemoveFromManifest} disabled={busy}>
                从清单移除
              </Button>
            )}
          </>
        )}
        {!isObserved && onRedeploy && drift.kind === 'source-updated' && (
          <Button variant="primary" size="sm" onClick={onRedeploy} disabled={busy}>
            更新
          </Button>
        )}
        {!isObserved && onRemoveFromManifest && drift.kind === 'unresolved' && (
          <Button variant="secondary" size="sm" onClick={onRemoveFromManifest} disabled={busy}>
            从清单移除
          </Button>
        )}
        {!isObserved && onUndeploy && drift.deployment !== null && drift.kind !== 'drift' && drift.kind !== 'unresolved' && drift.kind !== 'target-unconfigured' && (
          <Button variant="danger" size="sm" onClick={onUndeploy} disabled={busy}>
            取消部署
          </Button>
        )}
        {drift.kind === 'target-unconfigured' && onRemoveFromManifest && (
          <Button variant="secondary" size="sm" onClick={onRemoveFromManifest} disabled={busy}>
            解除登记
          </Button>
        )}
        {isObserved && drift.kind !== 'target-unconfigured' && onAdopt && (
          <Button variant="primary" size="sm" onClick={onAdopt} disabled={busy}>
            接管
          </Button>
        )}
        {isExternal && (
          <span className="text-2xs text-foreground-muted">未管理</span>
        )}
      </div>
    </li>
  )
}
