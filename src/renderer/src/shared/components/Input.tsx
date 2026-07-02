import { forwardRef, type InputHTMLAttributes } from 'react'

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ mono, className = '', ...props }, ref) => {
    return (
      <input
        ref={ref}
        className={`h-8 rounded border border-border bg-surface px-2.5 text-xs text-foreground placeholder:text-foreground-muted focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-surface-secondary transition-colors duration-fast ${mono ? 'font-mono' : ''} ${className}`}
        {...props}
      />
    )
  }
)

Input.displayName = 'Input'
