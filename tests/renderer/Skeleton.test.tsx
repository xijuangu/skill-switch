import React from 'react'
import { render, screen } from '@testing-library/react'
import { Skeleton } from '../../src/renderer/src/shared/components/Skeleton'

describe('Skeleton', () => {
  it('renders with default lines', () => {
    render(<Skeleton />)
    const status = screen.getByRole('status')
    expect(status).toBeInTheDocument()
    expect(status).toHaveAttribute('aria-label', '加载中')
  })

  it('renders custom number of lines', () => {
    render(<Skeleton lines={5} />)
    const status = screen.getByRole('status')
    expect(status).toBeInTheDocument()
  })

  it('has sr-only loading text', () => {
    render(<Skeleton />)
    expect(screen.getByText('加载中…')).toBeInTheDocument()
  })
})
