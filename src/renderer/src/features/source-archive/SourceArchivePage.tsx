import { useCallback, useEffect, useState } from 'react'
import { ArchiveRestore, ArchiveX, ChevronRight, ChevronDown } from 'lucide-react'
import { Button, Dialog, EmptyState, Skeleton, StatusDot } from '../../shared'
import { useToast } from '../../app/Toast'

type Batch = Awaited<ReturnType<typeof window.api.getSkillLibrary>>['consolidationBatches'][number]
type PurgePreview = Extract<Awaited<ReturnType<typeof window.api.previewSourceArchivePurge>>, { status: 'confirmation-required' }>

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Number((bytes / 1024).toFixed(1))} KB`
  return `${Number((bytes / 1024 / 1024).toFixed(1))} MB`
}

// #116:恢复内容优先展示可恢复/已清理/需要处理三种状态与建议动作,
// UUID、完整哈希与完整路径进入可展开的技术详情。
type RecoveryState = 'recoverable' | 'cleaned' | 'needs-handling' | 'restored'

function batchRecoveryState(batch: Batch): RecoveryState {
  if (batch.status === 'recovery-required') return 'needs-handling'
  if (batch.archive.purgedAt) return 'cleaned'
  if (batch.status === 'undone') return 'restored'
  if (batch.archive.recoverable) return 'recoverable'
  return 'needs-handling'
}

const STATE_META: Record<RecoveryState, { label: string; variant: 'success' | 'warning' | 'neutral'; recommendation: string }> = {
  recoverable: { label: '可恢复', variant: 'success', recommendation: '可恢复原候选来源与旧工具入口，建议确认后整批恢复。' },
  cleaned: { label: '已清理', variant: 'neutral', recommendation: '归档已永久清理，仅保留审计记录，不可再恢复。' },
  'needs-handling': { label: '需要处理', variant: 'warning', recommendation: '请检查批次状态，重试恢复或确认永久清理。' },
  restored: { label: '已恢复', variant: 'neutral', recommendation: '本批次已恢复，权威来源已回退到整理前状态。' }
}

export function SourceArchiveContent() {
  const [batches, setBatches] = useState<Batch[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [restoreTarget, setRestoreTarget] = useState<Batch | null>(null)
  const [purgeTarget, setPurgeTarget] = useState<Batch | null>(null)
  const [purgePreview, setPurgePreview] = useState<PurgePreview | null>(null)
  const { success, error } = useToast()
  const archiveBatches = batches.filter((batch) =>
    batch.status === 'completed' || batch.status === 'undone' || batch.status === 'recovery-required'
  )

  const refresh = useCallback(async () => {
    try {
      const library = await window.api.getSkillLibrary()
      setBatches(library.consolidationBatches)
    } catch (cause) {
      error(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [error])

  useEffect(() => { refresh().catch(() => {}) }, [refresh])

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const restore = async () => {
    if (!restoreTarget) return
    setBusy(true)
    try {
      const outcome = await window.api.restoreConsolidation(restoreTarget.id)
      if (outcome.status === 'undone') {
        success('已整批恢复权威来源、原候选来源和旧工具入口')
        setRestoreTarget(null)
        await refresh()
      } else if (outcome.status === 'rejected') error(outcome.message)
      else error(outcome.message)
    } catch (cause) {
      error(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const purge = async () => {
    if (!purgeTarget) return
    setBusy(true)
    try {
      if (!purgePreview) {
        const outcome = await window.api.previewSourceArchivePurge(purgeTarget.id)
        if (outcome.status === 'confirmation-required') setPurgePreview(outcome)
        else error(outcome.message)
      } else {
        const outcome = await window.api.confirmSourceArchivePurge(purgePreview.confirmationId)
        if (outcome.status === 'purged') {
          success('归档载荷已永久清理，审计记录仍保留')
          setPurgeTarget(null)
          setPurgePreview(null)
          await refresh()
        } else error(outcome.message)
      }
    } catch (cause) {
      error(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <Skeleton lines={6} />

  return (
    <div>
      <p className="mb-3 text-xs text-foreground-muted">整理批次默认永久保留，不受普通备份保留策略影响。</p>
      {archiveBatches.length === 0 ? (
        <EmptyState
          icon={<ArchiveRestore className="h-8 w-8" />}
          title="暂无来源归档"
          description="完成整理后，原候选来源与旧工具入口会按批次显示在这里。"
        />
      ) : (
        <div className="space-y-3">
          {archiveBatches.map((batch) => {
            const state = batchRecoveryState(batch)
            const meta = STATE_META[state]
            const isOpen = expanded.has(batch.id)
            return (
              <section key={batch.id} className="rounded border border-border bg-surface p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <StatusDot variant={meta.variant} label={meta.label} />
                      <span className="text-2xs text-foreground-muted">整理时间：{new Date(batch.createdAt).toLocaleString('zh-CN')}</span>
                    </div>
                    <p className="mt-1 text-xs text-foreground-secondary">{meta.recommendation}</p>
                    <p className="mt-1 text-2xs text-foreground-muted">归档占用：{formatBytes(batch.archive.sizeBytes)}</p>
                    {!batch.archive.recoverable && batch.archive.recoveryBlockedReason && (
                      <p className="mt-1 text-2xs text-warning">不可恢复：{batch.archive.recoveryBlockedReason}</p>
                    )}
                    <p className="mt-2 text-2xs text-foreground-muted">
                      涉及 Skill：
                      {batch.items.length === 0
                        ? '无'
                        : batch.items.map((item, i) => (
                            <span key={item.skillId}>{item.skillName}{i > 0 ? '、' : ''}</span>
                          ))}
                    </p>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <Button size="sm" variant="secondary" disabled={!batch.archive.recoverable} onClick={() => setRestoreTarget(batch)}>
                      恢复批次
                    </Button>
                    <Button size="sm" variant="danger" disabled={!batch.archive.purgeable} onClick={() => { setPurgeTarget(batch); setPurgePreview(null) }}>
                      <ArchiveX className="h-3 w-3" />永久清理
                    </Button>
                  </div>
                </div>

                <div className="mt-3">
                  <button
                    type="button"
                    onClick={() => toggleExpand(batch.id)}
                    aria-expanded={isOpen}
                    className="inline-flex items-center gap-1 text-2xs text-foreground-secondary hover:text-foreground transition-colors duration-fast"
                  >
                    {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    技术详情
                  </button>
                  {isOpen && (
                    <div className="mt-2 space-y-2">
                      <p className="text-2xs text-foreground-muted">
                        批次 ID：<code className="font-mono break-all">{batch.id}</code>
                      </p>
                      {batch.items.map((item) => (
                        <div key={`${batch.id}:${item.skillId}`} className="rounded bg-surface-secondary p-3">
                          <p className="text-xs font-medium">{item.skillName}</p>
                          {item.originalPaths.map((path, index) => (
                            <div key={path} className="mt-1">
                              <p className="text-2xs text-foreground-muted">原始路径</p>
                              <code className="block text-2xs break-all">{path}</code>
                              <p className="text-2xs text-foreground-muted">原始内容哈希</p>
                              <code className="block text-2xs break-all">{item.originalHashes[index] ?? ''}</code>
                            </div>
                          ))}
                          <p className="mt-1 text-2xs text-foreground-muted">权威路径</p>
                          <code className="block text-2xs break-all">{item.canonicalPath}</code>
                          {item.archivedToolPaths.map((path) => (
                            <code key={path} className="mt-1 block text-2xs break-all text-foreground-secondary">{path}</code>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>
            )
          })}
        </div>
      )}

      {restoreTarget && (
        <Dialog open title="恢复来源归档批次" description="将整批恢复原候选来源与旧工具入口，并移除本批次建立的权威来源。任何原位置被占用时都会整批拒绝。" confirmLabel="确认恢复" busy={busy} onConfirm={restore} onClose={() => { if (!busy) setRestoreTarget(null) }} />
      )}
      {purgeTarget && (
        <Dialog open title="永久清理来源归档" description={purgePreview ? `将永久清理 ${purgePreview.itemCount} 个归档项（${formatBytes(purgePreview.sizeBytes)}）。审计记录会保留，但本批次之后无法恢复。` : '先生成清理预览，再单独确认永久清理归档载荷。'} confirmLabel={purgePreview ? '确认永久清理' : '预览清理'} busy={busy} onConfirm={purge} onClose={() => { if (!busy) { setPurgeTarget(null); setPurgePreview(null) } }} closeOnOverlay={false} />
      )}
    </div>
  )
}
