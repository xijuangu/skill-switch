import React from 'react'
import { render, screen } from '@testing-library/react'
import { StatusDot } from '../../src/renderer/src/shared/components/StatusDot'

describe('StatusDot', () => {
  it('renders with label', () => {
    render(<StatusDot variant="success" label="正常" />)
    expect(screen.getByText('正常')).toBeInTheDocument()
  })

  it('has aria-label on the dot for accessibility', () => {
    render(<StatusDot variant="danger" label="漂移" />)
    const dot = screen.getByRole('img')
    expect(dot).toHaveAttribute('aria-label', '漂移')
  })

  it('renders neutral variant', () => {
    render(<StatusDot variant="neutral" label="未部署" />)
    expect(screen.getByText('未部署')).toBeInTheDocument()
    const dot = screen.getByRole('img')
    expect(dot.className).toContain('bg-foreground-muted')
  })

  it('renders warning variant', () => {
    render(<StatusDot variant="warning" label="源已更新" />)
    const dot = screen.getByRole('img')
    expect(dot.className).toContain('bg-warning')
  })
})
