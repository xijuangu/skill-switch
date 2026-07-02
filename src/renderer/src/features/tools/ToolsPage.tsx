import { useState } from 'react'
import { RotateCcw, Trash2, RefreshCw, ChevronRight, ChevronDown, Wrench, AlertCircle } from 'lucide-react'
import { Button, StatusDot, EmptyState, Skeleton, Dialog, getDriftStatus } from '../../shared'
import { useToast } from '../../app/Toast'
import { type DriftKey, driftKeyEquals } from './driftKey'

type ToolWithDriftsView = Awaited<ReturnType<typeof window.api.getTools>>[number]
type DriftStatusView = ToolWithDriftsView['drifts'][number]

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
  const [confirmUndeploy, setConfirmUndeploy] = useState<{ skillId: number; targetTool: string; skillName: string } | null>(null)
  const [confirmRemoveManifest, setConfirmRemoveManifest] = useState<{ skillId: number; targetTool: string; skillName: string } | null>(null)
  const [confirmRedeploy, setConfirmRedeploy] = useState<{ skillId: number; targetTool: string; skillName: string } | null>(null)

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
    const { skillId, targetTool } = confirmUndeploy
    setBusyKey({ skillId, targetTool })
    try {
      await window.api.undeploy(skillId, targetTool)
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
    const { skillId, targetTool } = confirmRemoveManifest
    setBusyKey({ skillId, targetTool })
    try {
      await window.api.removeFromManifest(skillId, targetTool)
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
    const { skillId, targetTool } = confirmRedeploy
    setBusyKey({ skillId, targetTool })
    try {
      const tool = tools.find((t) => t.config.key === targetTool)
      const drift = tool?.drifts.find((d) => d.skillId === skillId)
      if (!drift?.deployment) throw new Error('没有可重新部署的部署记录')
      await window.api.redeploy(skillId, targetTool, drift.deployment.mode)
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
              onUndeploy={(skillId, targetTool, skillName) => setConfirmUndeploy({ skillId, targetTool, skillName })}
              onRedeploy={(skillId, targetTool, skillName) => setConfirmRedeploy({ skillId, targetTool, skillName })}
              onRemoveFromManifest={(skillId, targetTool, skillName) => setConfirmRemoveManifest({ skillId, targetTool, skillName })}
            />
          ))}
        </ul>
      )}

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
  onRemoveFromManifest
}: {
  tool: ToolWithDriftsView
  expanded: boolean
  onToggleExpand: () => void
  busyKey: DriftKey | null
  onUndeploy: (skillId: number, targetTool: string, skillName: string) => void
  onRedeploy: (skillId: number, targetTool: string, skillName: string) => void
  onRemoveFromManifest: (skillId: number, targetTool: string, skillName: string) => void
}) {
  const { config, drifts } = tool
  const managed = drifts.filter((d) => d.kind !== 'external')
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
                      key={`${d.skillId}:${d.skillName}`}
                      drift={d}
                      busy={driftKeyEquals(busyKey, { skillId: d.skillId, targetTool: d.targetTool })}
                      onUndeploy={() => onUndeploy(d.skillId, d.targetTool, d.skillName)}
                      onRedeploy={() => onRedeploy(d.skillId, d.targetTool, d.skillName)}
                      onRemoveFromManifest={() => onRemoveFromManifest(d.skillId, d.targetTool, d.skillName)}
                    />
                  ))}
                </ul>
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
  onRemoveFromManifest
}: {
  drift: DriftStatusView
  busy: boolean
  onUndeploy: () => void
  onRedeploy: () => void
  onRemoveFromManifest: () => void
}) {
  const status = getDriftStatus(drift.kind)
  const isExternal = drift.kind === 'external'
  const isDrift = drift.kind === 'drift'

  return (
    <li className={`flex items-center justify-between bg-surface border border-border rounded px-2.5 py-1.5 ${isDrift ? 'opacity-50' : ''}`}>
      <div className="flex items-center gap-2 min-w-0">
        <StatusDot variant={status.variant} label={status.label} />
        <span className="text-xs font-medium text-foreground truncate">{drift.skillName}</span>
        {drift.deployment && (
          <span className="text-2xs text-foreground-secondary">{drift.deployment.mode}</span>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {(drift.kind === 'drift' || drift.kind === 'target-modified' || drift.kind === 'link-mismatch') && (
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
        {drift.kind === 'source-updated' && (
          <Button variant="primary" size="sm" onClick={onRedeploy} disabled={busy}>
            更新
          </Button>
        )}
        {drift.kind === 'unresolved' && (
          <Button variant="secondary" size="sm" onClick={onRemoveFromManifest} disabled={busy}>
            从清单移除
          </Button>
        )}
        {drift.deployment !== null && drift.kind !== 'drift' && drift.kind !== 'unresolved' && (
          <Button variant="danger" size="sm" onClick={onUndeploy} disabled={busy}>
            取消部署
          </Button>
        )}
        {isExternal && (
          <span className="text-2xs text-foreground-muted">未管理</span>
        )}
      </div>
    </li>
  )
}
