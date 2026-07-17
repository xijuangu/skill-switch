import { useState, useEffect, useCallback } from 'react'
import { RotateCcw, Trash2, Archive, ChevronRight, ChevronDown } from 'lucide-react'
import { Button, StatusDot, EmptyState, Dialog } from '../../shared'
import { useToast } from '../../app/Toast'

type BackupView = Awaited<ReturnType<typeof window.api.listBackups>>[number]

// #116:备份作为「恢复」页的标签之一。每条备份优先展示可恢复状态与恢复/删除建议动作,
// backupId (UUID)、完整哈希与完整路径放入可展开的技术详情。
export function BackupsContent() {
  const [backups, setBackups] = useState<BackupView[]>([])
  const [retention, setRetention] = useState<number>(20)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [confirmRestore, setConfirmRestore] = useState<BackupView | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<BackupView | null>(null)
  const { success, error: toastError } = useToast()

  const load = useCallback(async () => {
    try {
      const [list, settings] = await Promise.all([
        window.api.listBackups(),
        window.api.getSettings()
      ])
      setBackups(list)
      setRetention(settings.backupRetention)
    } catch (e) {
      toastError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [toastError])

  useEffect(() => {
    load()
  }, [load])

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleRestore = async () => {
    if (!confirmRestore) return
    const backup = confirmRestore
    setBusyId(backup.backupId)
    try {
      await window.api.restoreBackup(backup.backupId)
      await load()
      success(`已恢复备份「${backup.skillName}」`)
      setConfirmRestore(null)
    } catch (e) {
      toastError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  const handleDelete = async () => {
    if (!confirmDelete) return
    const backup = confirmDelete
    setBusyId(backup.backupId)
    try {
      await window.api.deleteBackup(backup.backupId)
      await load()
      success(`已删除备份「${backup.skillName}」`)
      setConfirmDelete(null)
    } catch (e) {
      toastError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-16 rounded-md border border-border p-3">
            <div className="flex items-center gap-2">
              <div className="h-3 w-24 rounded-sm bg-border-subtle" />
              <div className="h-2.5 w-12 rounded-full bg-border-subtle" />
            </div>
            <div className="mt-2 flex items-center gap-3">
              <div className="h-2 w-32 rounded-sm bg-border-subtle" />
              <div className="h-2 w-16 rounded-sm bg-border-subtle" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-foreground-muted">覆盖部署或删除 skill 时会自动在此备份。</p>
        <span className="text-xs text-foreground-muted">
          保留数 <span className="font-semibold text-foreground-secondary">{retention}</span>
        </span>
      </div>

      {backups.length === 0 ? (
        <EmptyState
          icon={<Archive className="h-8 w-8" />}
          title="暂无备份"
          description="覆盖部署或删除 skill 时会自动在此备份。"
        />
      ) : (
        <ul className="space-y-2">
          {backups.map((b) => {
            const isOpen = expanded.has(b.backupId)
            return (
              <li
                key={b.backupId}
                className="border border-border rounded-md p-3 flex items-center justify-between hover:bg-surface-hover transition-colors duration-fast"
              >
                <div className="flex flex-col gap-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <StatusDot variant="success" label="可恢复" />
                    <span className="text-sm font-medium text-foreground">{b.skillName}</span>
                    <span className="text-2xs px-1.5 py-0.5 rounded-full bg-surface-secondary text-foreground-secondary border border-border-subtle">
                      {b.targetTool}
                    </span>
                  </div>
                  <div className="text-xs text-foreground-muted">
                    {new Date(b.backupTime).toLocaleString()}
                  </div>
                  <button
                    type="button"
                    onClick={() => toggleExpand(b.backupId)}
                    aria-expanded={isOpen}
                    className="inline-flex items-center gap-1 text-2xs text-foreground-secondary hover:text-foreground transition-colors duration-fast w-fit"
                  >
                    {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    技术详情
                  </button>
                  {isOpen && (
                    <div className="mt-1 space-y-0.5">
                      <p className="text-2xs text-foreground-muted">
                        备份 ID：<code className="font-mono break-all">{b.backupId}</code>
                      </p>
                      <p className="text-2xs text-foreground-muted">
                        内容哈希：<code className="font-mono break-all">{b.sourceHash}</code>
                      </p>
                      <p className="text-2xs text-foreground-muted">
                        来源路径：<code className="font-mono break-all">{b.sourcePath}</code>
                      </p>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0 ml-3">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setConfirmRestore(b)}
                    disabled={busyId !== null}
                    icon={<RotateCcw className="h-3 w-3" />}
                  >
                    恢复
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => setConfirmDelete(b)}
                    disabled={busyId !== null}
                    icon={<Trash2 className="h-3 w-3" />}
                  >
                    删除
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <Dialog
        open={confirmRestore !== null}
        onClose={() => setConfirmRestore(null)}
        title={`恢复备份「${confirmRestore?.skillName ?? ''}」`}
        description="将备份恢复到原路径。如果目标路径已有内容，会先创建一份安全网备份再覆盖目标。"
        confirmLabel="恢复"
        busy={busyId === confirmRestore?.backupId}
        onConfirm={handleRestore}
      />

      <Dialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title={`删除备份「${confirmDelete?.skillName ?? ''}」?`}
        description="此操作不可撤销。备份删除后无法恢复。"
        variant="danger"
        confirmLabel="删除"
        busy={busyId === confirmDelete?.backupId}
        onConfirm={handleDelete}
        closeOnOverlay={false}
      />
    </div>
  )
}
