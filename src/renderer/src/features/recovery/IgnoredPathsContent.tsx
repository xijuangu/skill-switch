import { useState, useEffect, useCallback } from 'react'
import { EyeOff } from 'lucide-react'
import { Button, EmptyState } from '../../shared'
import { useToast } from '../../app/Toast'

type IgnoredPathView = Awaited<ReturnType<typeof window.api.getIgnoredSourcePaths>>[number]

// 忽略名单(ignored_source_paths)的恢复页入口:列出被忽略的来源目录,
// 允许逐条解除——解除后下次扫描该目录可重新登记为 Skill Source。
export function IgnoredPathsContent() {
  const [items, setItems] = useState<IgnoredPathView[]>([])
  const [loading, setLoading] = useState(true)
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const { success, error: toastError } = useToast()

  const load = useCallback(async () => {
    try {
      setItems(await window.api.getIgnoredSourcePaths())
    } catch (e) {
      toastError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [toastError])

  useEffect(() => {
    load()
  }, [load])

  const handleUnignore = async (path: string) => {
    setBusyPath(path)
    try {
      await window.api.unignoreSourcePath(path)
      success('已解除忽略，下次扫描可重新登记')
      await load()
    } catch (e) {
      toastError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyPath(null)
    }
  }

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="h-12 rounded-md border border-border p-3">
            <div className="h-3 w-48 rounded-sm bg-border-subtle" />
            <div className="mt-2 h-2.5 w-24 rounded-sm bg-border-subtle" />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div>
      <p className="text-xs text-foreground-muted mb-3">
        从注册表移除 Skill 时忽略的来源目录。忽略期间扫描不会重新登记它们；解除忽略后下次扫描恢复登记。
      </p>
      {items.length === 0 ? (
        <EmptyState
          icon={<EyeOff className="h-8 w-8" />}
          title="暂无忽略的来源目录"
          description="从注册表移除 Skill 时勾选「忽略这些来源目录」后，会出现在这里。"
        />
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li
              key={item.path}
              className="flex items-center justify-between gap-3 rounded-md border border-border p-3"
            >
              <div className="min-w-0">
                <div className="font-mono text-xs text-foreground break-all">{item.path}</div>
                <div className="text-2xs text-foreground-muted mt-0.5">
                  {item.skill_name} · 忽略于 {new Date(item.created_at).toLocaleString()}
                </div>
              </div>
              <Button
                variant="secondary"
                size="sm"
                aria-label={`解除忽略 ${item.path}`}
                loading={busyPath === item.path}
                onClick={() => handleUnignore(item.path)}
              >
                解除忽略
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
