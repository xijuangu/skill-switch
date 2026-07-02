import { useEffect, useRef, type ReactNode, type KeyboardEvent } from 'react'
import { X, AlertTriangle } from 'lucide-react'
import { Button } from './Button'

interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children?: ReactNode
  variant?: 'default' | 'danger'
  busy?: boolean
  confirmLabel?: string
  cancelLabel?: string
  onConfirm?: () => void
  hideCancel?: boolean
  closeOnOverlay?: boolean
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  variant = 'default',
  busy = false,
  confirmLabel = '确认',
  cancelLabel = '取消',
  onConfirm,
  hideCancel = false,
  closeOnOverlay = true
}: DialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (open) {
      previousFocusRef.current = document.activeElement as HTMLElement
      setTimeout(() => {
        const firstFocusable = dialogRef.current?.querySelector<HTMLElement>(
          'button:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
        firstFocusable?.focus()
      }, 0)
    } else if (previousFocusRef.current) {
      previousFocusRef.current.focus()
      previousFocusRef.current = null
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!busy) {
          onClose()
        }
        return
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [tabindex]:not([tabindex="-1"]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])'
        )
        if (focusable.length === 0) {
          e.preventDefault()
          return
        }
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose, busy, variant])

  if (!open) return null

  const isDanger = variant === 'danger'
  const canClose = !busy && (isDanger ? false : true)

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 motion-safe:animate-[dialogFadeIn_150ms_ease-out]"
      onClick={() => {
        if (closeOnOverlay && canClose) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        aria-describedby={description ? 'dialog-desc' : undefined}
        className="bg-surface rounded-lg shadow-dialog max-w-lg w-full mx-4 max-h-[80vh] flex flex-col motion-safe:animate-[dialogScaleIn_150ms_ease-out]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`p-4 border-b border-border flex items-start gap-3 ${isDanger ? 'bg-danger-subtle' : ''}`}>
          {isDanger && (
            <AlertTriangle className="h-5 w-5 text-danger shrink-0 mt-0.5" />
          )}
          <div className="flex-1 min-w-0">
            <h3 id="dialog-title" className={`text-sm font-semibold ${isDanger ? 'text-danger' : 'text-foreground'}`}>
              {title}
            </h3>
            {description && (
              <p id="dialog-desc" className="text-xs text-foreground-secondary mt-1">
                {description}
              </p>
            )}
          </div>
          {canClose && (
            <button
              onClick={onClose}
              className="text-foreground-muted hover:text-foreground-secondary shrink-0 mt-0.5"
              aria-label="关闭"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {children && (
          <div className="p-4 overflow-auto flex-1">{children}</div>
        )}

        <div className="p-4 border-t border-border flex justify-end gap-2">
          {!hideCancel && !isDanger && (
            <Button variant="secondary" onClick={onClose} disabled={busy} size="sm">
              {cancelLabel}
            </Button>
          )}
          {onConfirm && (
            <Button
              variant={isDanger ? 'danger' : 'primary'}
              onClick={onConfirm}
              loading={busy}
              disabled={busy}
              size="sm"
            >
              {busy ? '处理中…' : confirmLabel}
            </Button>
          )}
          {isDanger && !hideCancel && (
            <Button variant="secondary" onClick={onClose} disabled={busy} size="sm">
              {cancelLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
