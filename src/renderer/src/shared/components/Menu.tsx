import { useEffect, useRef, useState, type ReactNode, useCallback } from 'react'
import { ChevronRight } from 'lucide-react'

interface MenuAction {
  key: string
  label: string
  danger?: boolean
  disabled?: boolean
  onClick: () => void
}

interface MenuProps {
  anchor: { x: number; y: number } | HTMLElement | null
  actions: MenuAction[]
  onClose: () => void
  label?: string
}

const MENU_WIDTH = 220
const MENU_ITEM_HEIGHT = 32
const MENU_PADDING = 8

export function Menu({ anchor, actions, onClose, label = '菜单' }: MenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const [activeIndex, setActiveIndex] = useState(-1)

  const calcPosition = useCallback(() => {
    if (!anchor) return null
    const viewportW = window.innerWidth
    const viewportH = window.innerHeight
    const menuH = Math.min(actions.length * MENU_ITEM_HEIGHT + MENU_PADDING * 2, 320)

    let anchorX: number
    let anchorY: number

    if ('x' in anchor && 'y' in anchor) {
      anchorX = anchor.x
      anchorY = anchor.y
    } else {
      const rect = anchor.getBoundingClientRect()
      anchorX = rect.left
      anchorY = rect.bottom
    }

    let left = anchorX
    let top = anchorY

    if (left + MENU_WIDTH > viewportW - 8) {
      left = anchorX - MENU_WIDTH
    }
    if (left < 8) {
      left = 8
    }

    if (top + menuH > viewportH - 8) {
      top = anchorY - menuH
      if ('y' in anchor) {
        top = anchor.y - menuH
      } else {
        const rect = (anchor as HTMLElement).getBoundingClientRect()
        top = rect.top - menuH
      }
    }
    if (top < 8) {
      top = 8
    }

    return { left, top }
  }, [anchor, actions.length])

  useEffect(() => {
    setPosition(calcPosition())
  }, [calcPosition])

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement
    setTimeout(() => {
      const firstItem = menuRef.current?.querySelector<HTMLElement>(
        'button:not([disabled])'
      )
      firstItem?.focus()
    }, 0)

    return () => {
      previousFocusRef.current?.focus()
    }
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      const enabledActions = actions.filter((a) => !a.disabled)
      if (enabledActions.length === 0) return

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((prev) => (prev + 1) % enabledActions.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((prev) => (prev - 1 + enabledActions.length) % enabledActions.length)
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        const action = enabledActions[activeIndex]
        if (action) {
          action.onClick()
          onClose()
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [actions, activeIndex, onClose])

  useEffect(() => {
    if (activeIndex >= 0 && menuRef.current) {
      const enabled = actions.filter((a) => !a.disabled)
      const targetAction = enabled[activeIndex]
      if (targetAction) {
        const btn = menuRef.current.querySelector<HTMLElement>(
          `[data-action-key="${targetAction.key}"]`
        )
        btn?.focus()
      }
    }
  }, [activeIndex, actions])

  if (!position) return null

  const enabledActions = actions.filter((a) => !a.disabled)

  return (
    <div className="fixed inset-0 z-50" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }}>
      <div
        ref={menuRef}
        role="menu"
        aria-label={label}
        className="absolute bg-surface border border-border rounded-md shadow-menu py-1 w-[220px] max-h-80 overflow-auto motion-safe:animate-[menuFadeIn_100ms_ease-out]"
        style={{ left: position.left, top: position.top }}
        onClick={(e) => e.stopPropagation()}
      >
        {actions.map((action, i) => {
          const enabledIndex = enabledActions.indexOf(action)
          const isFocused = enabledIndex >= 0 && activeIndex === enabledIndex
          return (
            <button
              key={action.key}
              data-action-key={action.key}
              role="menuitem"
              disabled={action.disabled}
              onClick={() => {
                action.onClick()
                onClose()
              }}
              className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-fast ${
                action.danger
                  ? 'text-danger hover:bg-danger-subtle'
                  : isFocused
                    ? 'bg-surface-hover text-foreground'
                    : 'text-foreground-secondary hover:bg-surface-hover hover:text-foreground'
              }`}
            >
              <span className="flex-1">{action.label}</span>
              {action.danger && <ChevronRight className="h-3 w-3 opacity-0" />}
            </button>
          )
        })}
      </div>
    </div>
  )
}
