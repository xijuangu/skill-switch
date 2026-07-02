type StatusDotVariant = 'success' | 'warning' | 'danger' | 'neutral'

interface StatusDotProps {
  variant: StatusDotVariant
  label: string
  size?: 'sm' | 'md'
}

const variantColors: Record<StatusDotVariant, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  neutral: 'bg-foreground-muted',
}

const sizeClasses: Record<string, string> = {
  sm: 'h-1.5 w-1.5',
  md: 'h-2 w-2',
}

export function StatusDot({ variant, label, size = 'sm' }: StatusDotProps) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`inline-block rounded-full shrink-0 ${sizeClasses[size]} ${variantColors[variant]}`}
        role="img"
        aria-label={label}
      />
      <span className="text-xs text-foreground-secondary">{label}</span>
    </span>
  )
}
