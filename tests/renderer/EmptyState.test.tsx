import React from 'react'
import { render, screen } from '@testing-library/react'
import { EmptyState } from '../../src/renderer/src/shared/components/EmptyState'

describe('EmptyState', () => {
  it('renders title and description', () => {
    render(
      <EmptyState
        title="暂无数据"
        description="尚未添加任何内容"
      />
    )
    expect(screen.getByText('暂无数据')).toBeInTheDocument()
    expect(screen.getByText('尚未添加任何内容')).toBeInTheDocument()
  })

  it('renders action button when provided', () => {
    const handleAction = vi.fn()
    render(
      <EmptyState
        title="暂无数据"
        action={{ label: '添加', onClick: handleAction, variant: 'primary' }}
      />
    )
    expect(screen.getByRole('button', { name: '添加' })).toBeInTheDocument()
  })

  it('does not render button when no action', () => {
    render(<EmptyState title="暂无数据" />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
