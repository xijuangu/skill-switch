import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'
import { X, CheckCircle, AlertCircle, Info } from 'lucide-react'

// 通知系统归 app/ (ADR 0002),非视觉原语,不归 shared/components/。
// feature 页通过 useToast 消费 app 层提供的通知能力。

type ToastType = 'success' | 'error' | 'info'

interface Toast {
  id: string
  type: ToastType
  message: string
  createdAt: number
}

interface ToastContextValue {
  toasts: Toast[]
  success: (message: string) => void
  error: (message: string) => void
  info: (message: string) => void
  dismiss: (id: string) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}

const MAX_TOASTS = 3
const SUCCESS_DURATION = 4000
const INFO_DURATION = 6000

let toastIdCounter = 0

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const addToast = useCallback((type: ToastType, message: string) => {
    const id = `toast-${++toastIdCounter}`
    const toast: Toast = { id, type, message, createdAt: Date.now() }
    setToasts((prev) => {
      const next = [...prev, toast]
      if (next.length > MAX_TOASTS) {
        const nonErrorIndex = next.findIndex((t) => t.type !== 'error')
        if (nonErrorIndex >= 0) {
          next.splice(nonErrorIndex, 1)
        } else {
          next.shift()
        }
      }
      return next
    })

    if (type === 'success') {
      setTimeout(() => dismiss(id), SUCCESS_DURATION)
    } else if (type === 'info') {
      setTimeout(() => dismiss(id), INFO_DURATION)
    }
  }, [])

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const success = useCallback((msg: string) => addToast('success', msg), [addToast])
  const errorToast = useCallback((msg: string) => addToast('error', msg), [addToast])
  const info = useCallback((msg: string) => addToast('info', msg), [addToast])

  return (
    <ToastContext.Provider value={{ toasts, success, error: errorToast, info, dismiss }}>
      {children}
      <ToastContainer />
    </ToastContext.Provider>
  )
}

function ToastContainer() {
  const { toasts, dismiss } = useToast()

  if (toasts.length === 0) return null

  return (
    <div
      className="fixed bottom-4 right-4 z-[100] flex flex-col-reverse gap-2 pointer-events-none"
      aria-live="polite"
      aria-label="通知"
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
      ))}
    </div>
  )
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const icons: Record<ToastType, ReactNode> = {
    success: <CheckCircle className="h-4 w-4 text-success shrink-0" />,
    error: <AlertCircle className="h-4 w-4 text-danger shrink-0" />,
    info: <Info className="h-4 w-4 text-primary shrink-0" />,
  }

  return (
    <div
      role="alert"
      className={`pointer-events-auto bg-surface border rounded-md shadow-toast px-3 py-2.5 flex items-start gap-2.5 max-w-sm motion-safe:animate-[toastSlideUp_150ms_ease-out] ${
        toast.type === 'error' ? 'border-danger-subtle' : 'border-border'
      }`}
    >
      {icons[toast.type]}
      <span className="text-xs text-foreground-secondary flex-1 min-w-0">{toast.message}</span>
      <button
        onClick={onDismiss}
        className="text-foreground-muted hover:text-foreground-secondary shrink-0 mt-0.5"
        aria-label="关闭通知"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
