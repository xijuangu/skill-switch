import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RecoveryPage } from '../../src/renderer/src/features/recovery/RecoveryPage'
import { ToastProvider } from '../../src/renderer/src/app/Toast'
import { mockWindowApi } from './api-mock'

// 恢复页第三个 tab「忽略目录」:展示忽略名单,支持逐条解除。
// 解除后该来源目录在下次扫描时可重新登记。

const ignoredRows = [
  { path: '/external/alpha', skill_name: 'alpha', created_at: '2026-08-01T10:00:00.000Z' },
  { path: '/external/beta', skill_name: 'beta', created_at: '2026-08-02T10:00:00.000Z' }
]

function renderPage() {
  return render(
    <ToastProvider>
      <RecoveryPage />
    </ToastProvider>
  )
}

describe('RecoveryPage 忽略目录 tab', () => {
  it('列出忽略名单条目(路径 + 关联 Skill 名)', async () => {
    mockWindowApi({ getIgnoredSourcePaths: vi.fn().mockResolvedValue(ignoredRows) })
    renderPage()

    await userEvent.click(screen.getByRole('tab', { name: '忽略目录' }))
    expect(await screen.findByText('/external/alpha')).toBeInTheDocument()
    expect(screen.getByText('/external/beta')).toBeInTheDocument()
    expect(screen.getByText(/alpha · 忽略于/)).toBeInTheDocument()
    expect(screen.getByText(/beta · 忽略于/)).toBeInTheDocument()
  })

  it('解除忽略:调用 unignoreSourcePath 并刷新列表', async () => {
    const getIgnored = vi.fn()
      .mockResolvedValueOnce(ignoredRows)
      .mockResolvedValueOnce([ignoredRows[1]])
    const api = mockWindowApi({
      getIgnoredSourcePaths: getIgnored,
      unignoreSourcePath: vi.fn().mockResolvedValue(true)
    })
    renderPage()

    await userEvent.click(screen.getByRole('tab', { name: '忽略目录' }))
    await userEvent.click(await screen.findByRole('button', { name: '解除忽略 /external/alpha' }))

    await waitFor(() => expect(api.unignoreSourcePath).toHaveBeenCalledWith('/external/alpha'))
    await waitFor(() => expect(screen.queryByText('/external/alpha')).not.toBeInTheDocument())
    expect(screen.getByText('/external/beta')).toBeInTheDocument()
  })

  it('名单为空时展示空态', async () => {
    mockWindowApi({ getIgnoredSourcePaths: vi.fn().mockResolvedValue([]) })
    renderPage()

    await userEvent.click(screen.getByRole('tab', { name: '忽略目录' }))
    expect(await screen.findByText(/暂无忽略的来源目录/)).toBeInTheDocument()
  })
})
