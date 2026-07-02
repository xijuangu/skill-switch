import type { ReactNode } from 'react'
import { Button } from './Button'

interface EmptyStateProps {
  icon?: ReactNode
  title: string
  description?: string
  action?: {
    label: string
    onClick: () => void
    variant?: 'primary' | 'secondary'
  }
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      {icon && (
        <div className="mb-4 text-foreground-muted">{icon}</div>
      )}
      <h3 className="text-sm font-medium text-foreground-secondary mb-1">{title}</h3>
      {description && (
        <p className="text-xs text-foreground-muted max-w-md mb-4">{description}</p>
      )}
      {action && (
        <Button variant={action.variant ?? 'primary'} size="md" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  )
}
