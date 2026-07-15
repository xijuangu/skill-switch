import { useState } from 'react'
import { RotateCcw, Trash2, RefreshCw, ChevronRight, ChevronDown, Wrench, AlertCircle } from 'lucide-react'
import { Button, StatusDot, EmptyState, Skeleton, Dialog, getDriftStatus } from '../../shared'
import { useToast } from '../../app/Toast'
import { type DriftKey, driftKeyEquals } from './driftKey'

type ToolWithDriftsView = Awaited<ReturnType<typeof window.api.getTools>>[number]
type DriftStatusView = ToolWithDriftsView['drifts'][number]
type ConfirmationRequiredView = Extract<Awaited<ReturnType<typeof window.api.deploymentConfirm>>, { status: 'confirmation-required' }>

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
  const [confirmRemoveManifest, setConfirmRemoveManifest] = useState<{ deploymentId: number; skillId: number; targetTool: string; skillName: string } | null>(null)
  const [confirmRedeploy, setConfirmRedeploy] = useState<{ deploymentId: number; skillId: number; targetTool: string; skillName: string } | null>(null)
  const [confirmAdopt, setConfirmAdopt] = useState<{ deploymentId: number; skillId: number; targetTool: string; skillName: string } | null>(null)
  const [redeployRisk, setRedeployRisk] = useState<ConfirmationRequiredView | null>(null)

  const { success, error: toastError } = useToast()

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
      await onRefresh()
      success(`已从 ${targetTool} 取消部署`)
      setConfirmUndeploy(null)
    } catch (e) {
      toastError(e instanceof Error ? e.message : String(e))
      await onRefresh()
    } finally {
      setBusyKey(null)
    }
  }

  const handleRemoveFromManifest = async () => {
    if (!confirmRemoveManifest) return
    const { deploymentId, skillId, targetTool } = confirmRemoveManifest
    setBusyKey({ skillId, targetTool })
    try {
      await window.api.removeFromManifest(deploymentId)
      await onRefresh()
      success('已从清单移除')
      setConfirmRemoveManifest(null)
    } catch (e) {
      toastError(e instanceof Error ? e.message : String(e))
      await onRefresh()
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
      await onRefresh()
      success('已接管外部订阅')
      setConfirmAdopt(null)
    } catch (e) {
      toastError(e instanceof Error ? e.message : String(e))
      await onRefresh()
    } finally {
      setBusyKey(null)
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
        <Button variant="secondary" size="sm" onClick={onRefresh} icon={<RefreshCw className="h-3 w-3" />}>
          刷新
        </Button>
      </div>

      {tools.length === 0 ? (
        <EmptyState
          icon={<Wrench className="h-8 w-8" />}
          title="未配置工具"
          description="请到设置中启用工具。"
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
              onRemoveFromManifest={(deploymentId, skillId, targetTool, skillName) => setConfirmRemoveManifest({ deploymentId, skillId, targetTool, skillName })}
              onAdopt={(deploymentId, skillId, targetTool, skillName) => setConfirmAdopt({ deploymentId, skillId, targetTool, skillName })}
            />
          ))}
        </ul>
      )}

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
        title={`从 ${confirmRemoveManifest?.targetTool ?? ''} 清单移除「${confirmRemoveManifest?.skillName ?? ''}」?`}
        description="目标已从磁盘移除，此操作只清理清单记录。"
        confirmLabel="移除"
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
  onRemoveFromManifest: (deploymentId: number, skillId: number, targetTool: string, skillName: string) => void
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
                      onRemoveFromManifest={() => d.deployment && onRemoveFromManifest(d.deployment.id, d.skillId, d.targetTool, d.skillName)}
                      onAdopt={() => {}}
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
                        onAdopt={() => onAdopt(d.deployment!.id, d.skillId, d.targetTool, d.skillName)}
                        onUndeploy={() => {}}
                        onRedeploy={() => {}}
                        onRemoveFromManifest={() => {}}
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
                        onUndeploy={() => {}}
                        onRedeploy={() => {}}
                        onRemoveFromManifest={() => {}}
                        onAdopt={() => {}}
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
  onUndeploy: () => void
  onRedeploy: () => void
  onRemoveFromManifest: () => void
  onAdopt: () => void
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
        {!isObserved && (drift.kind === 'drift' || drift.kind === 'target-modified' || drift.kind === 'link-mismatch') && (
          <>
            <Button variant="primary" size="sm" onClick={onRedeploy} disabled={busy}>
              重新部署
            </Button>
            {drift.kind === 'drift' && (
              <Button variant="secondary" size="sm" onClick={onRemoveFromManifest} disabled={busy}>
                从清单移除
              </Button>
            )}
          </>
        )}
        {!isObserved && drift.kind === 'source-updated' && (
          <Button variant="primary" size="sm" onClick={onRedeploy} disabled={busy}>
            更新
          </Button>
        )}
        {!isObserved && drift.kind === 'unresolved' && (
          <Button variant="secondary" size="sm" onClick={onRemoveFromManifest} disabled={busy}>
            从清单移除
          </Button>
        )}
        {!isObserved && drift.deployment !== null && drift.kind !== 'drift' && drift.kind !== 'unresolved' && (
          <Button variant="danger" size="sm" onClick={onUndeploy} disabled={busy}>
            取消部署
          </Button>
        )}
        {isObserved && (
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
