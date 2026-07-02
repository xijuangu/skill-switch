import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Dialog } from '../../src/renderer/src/shared/components/Dialog'

describe('Dialog', () => {
  it('renders when open', () => {
    render(
      <Dialog open onClose={vi.fn()} title="确认操作" description="你确定吗？" />
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('确认操作')).toBeInTheDocument()
    expect(screen.getByText('你确定吗？')).toBeInTheDocument()
  })

  it('does not render when closed', () => {
    render(
      <Dialog open={false} onClose={vi.fn()} title="确认操作" />
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('calls onClose on cancel button', async () => {
    const handleClose = vi.fn()
    render(
      <Dialog open onClose={handleClose} title="确认" confirmLabel="确认" />
    )
    await userEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(handleClose).toHaveBeenCalledTimes(1)
  })

  it('calls onConfirm when confirm is clicked', async () => {
    const handleConfirm = vi.fn()
    render(
      <Dialog open onClose={vi.fn()} title="确认" onConfirm={handleConfirm} confirmLabel="删除" />
    )
    await userEvent.click(screen.getByRole('button', { name: '删除' }))
    expect(handleConfirm).toHaveBeenCalledTimes(1)
  })

  it('renders danger variant', () => {
    render(
      <Dialog open onClose={vi.fn()} title="危险操作" variant="danger" confirmLabel="删除" />
    )
    expect(screen.getByText('危险操作').className).toContain('text-danger')
  })

  it('does not close on overlay click in danger mode', async () => {
    const handleClose = vi.fn()
    render(
      <Dialog
        open
        onClose={handleClose}
        title="危险操作"
        variant="danger"
        confirmLabel="删除"
        closeOnOverlay={false}
      />
    )
    const overlay = screen.getByRole('dialog').parentElement!
    await userEvent.click(overlay)
    expect(handleClose).not.toHaveBeenCalled()
  })

  it('has proper ARIA attributes', () => {
    render(
      <Dialog
        open
        onClose={vi.fn()}
        title="确认"
        description="描述文字"
        confirmLabel="确认"
      />
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAttribute('aria-labelledby', 'dialog-title')
    expect(dialog).toHaveAttribute('aria-describedby', 'dialog-desc')
  })
})
