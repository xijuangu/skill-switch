import { useState, useEffect, useCallback } from 'react'
import { RotateCcw, Trash2, Archive } from 'lucide-react'
import { Button, StatusDot, EmptyState, Skeleton, Dialog } from '../../shared'
import { useToast } from '../../app/Toast'

type BackupView = Awaited<ReturnType<typeof window.api.listBackups>>[number]

export function BackupsPage() {
  const [backups, setBackups] = useState<BackupView[]>([])
  const [retention, setRetention] = useState<number>(20)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
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
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold">备份</h2>
        </div>
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
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Archive className="h-4 w-4 text-foreground-secondary" />
          <h2 className="text-sm font-semibold">备份</h2>
        </div>
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
          {backups.map((b) => (
            <li
              key={b.backupId}
              className="border border-border rounded-md p-3 flex items-center justify-between hover:bg-surface-hover transition-colors duration-fast"
            >
              <div className="flex flex-col gap-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{b.skillName}</span>
                  <span className="text-2xs px-1.5 py-0.5 rounded-full bg-surface-secondary text-foreground-secondary border border-border-subtle">
                    {b.targetTool}
                  </span>
                </div>
                <div className="text-xs text-foreground-muted flex items-center gap-3">
                  <span>{new Date(b.backupTime).toLocaleString()}</span>
                  <code className="font-mono text-foreground-tertiary" title={b.sourceHash}>
                    {b.sourceHash.slice(0, 8)}
                  </code>
                </div>
                <div className="text-2xs text-foreground-muted truncate font-mono" title={b.sourcePath}>
                  {b.sourcePath}
                </div>
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
          ))}
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
