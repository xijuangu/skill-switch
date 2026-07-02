interface SkeletonProps {
  lines?: number
  className?: string
}

export function Skeleton({ lines = 3, className = '' }: SkeletonProps) {
  const widths = ['w-full', 'w-3/4', 'w-1/2']

  return (
    <div className={`space-y-3 ${className}`} role="status" aria-label="加载中">
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
