interface SkeletonProps {
  lines?: number
  className?: string
}

export function Skeleton({ lines = 3, className = '' }: SkeletonProps) {
  const widths = ['w-full', 'w-3/4', 'w-1/2']

  return (
    <div className={`space-y-3 animate-pulse ${className}`} role="status" aria-label="加载中">
      <div className="space-y-3">
        {Array.from({ length: lines }).map((_, i) => (
          <div
            key={i}
            className={`h-3.5 rounded-sm bg-border-subtle ${widths[Math.min(i, widths.length - 1)]}`}
          />
        ))}
      </div>
      <span className="sr-only">加载中…</span>
    </div>
  )
}

export function SkeletonCard({ className = '' }: { className?: string }) {
  return (
    <div className={`rounded-md border border-border p-4 animate-pulse ${className}`} role="status" aria-label="加载中">
      <div className="flex items-center gap-3">
        <div className="h-8 w-8 rounded-full bg-border-subtle" />
        <div className="flex-1 space-y-2">
          <div className="h-3 w-1/3 rounded-sm bg-border-subtle" />
          <div className="h-2.5 w-2/3 rounded-sm bg-border-subtle" />
        </div>
      </div>
      <span className="sr-only">加载中…</span>
    </div>
  )
}
