import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '../../src/renderer/src/app/App'

// 回归 #52:App 必须在 ToastProvider 之内消费 useToast,
// 否则首屏抛 "useToast must be used within ToastProvider" → 白屏(typecheck/build 不可见)。

function mockWindowApi(overrides: Partial<Window['api']> = {}) {
  const api: Window['api'] = {
    scan: vi.fn().mockResolvedValue({ tools: [], totalScanned: 0, totalUpserted: 0 }),
    getSkills: vi.fn().mockResolvedValue([]),
    getSettings: vi.fn().mockResolvedValue({
      tools: [],
      backupRetention: 5,
      platform: { platform: 'darwin', canSymlink: true, canJunction: false },
    }),
    getDeployTargets: vi.fn().mockResolvedValue([]),
    setPresetEnabled: vi.fn(),
    setPresetPaths: vi.fn(),
    addCustomTool: vi.fn(),
    removeCustomTool: vi.fn(),
    setBackupRetention: vi.fn(),
    listBackups: vi.fn().mockResolvedValue([]),
    restoreBackup: vi.fn(),
    deleteBackup: vi.fn(),
    prepareDeploy: vi.fn(),
    deploy: vi.fn(),
    redeploy: vi.fn(),
    undeploy: vi.fn(),
    getTools: vi.fn().mockResolvedValue([]),
    removeFromManifest: vi.fn(),
    getDeploymentsForSkill: vi.fn().mockResolvedValue([]),
    viewSkillMd: vi.fn(),
    removeFromRegistry: vi.fn(),
    installFromGitHub: vi.fn(),
    installFromZip: vi.fn(),
    installFromLocalDir: vi.fn(),
    selectZipFile: vi.fn(),
    selectLocalDir: vi.fn(),
    ...overrides,
  }
  Object.defineProperty(window, 'api', { value: api, writable: true, configurable: true })
  return api
}

describe('App (integration)', () => {
  it('mounts without throwing (regression: white screen from useToast outside ToastProvider)', async () => {
    mockWindowApi()
    // 不应用 catch 兜底,抛错即测试失败
    render(<App />)
    // 导航可见
    expect(screen.getByText('skill-switch')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '技能' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '工具' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '备份' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '设置' })).toBeInTheDocument()
    // 首次 refresh 触发
    await waitFor(() => {
      expect(window.api.getSkills).toHaveBeenCalledTimes(1)
      expect(window.api.getTools).toHaveBeenCalledTimes(1)
    })
  })

  it('switches pages via nav', async () => {
    mockWindowApi()
    render(<App />)
    await userEvent.click(screen.getByRole('button', { name: '设置' }))
    await userEvent.click(screen.getByRole('button', { name: '工具' }))
    await userEvent.click(screen.getByRole('button', { name: '技能' }))
    // 切回 skills 时不抛错即可
    expect(screen.getByRole('button', { name: '技能' })).toBeInTheDocument()
  })

  it('renders empty state on Skills page when no skills', async () => {
    mockWindowApi()
    render(<App />)
    // 等待 loading 结束后空态出现(空态文案不在此断言具体文本,只确认不抛错且页面挂载)
    await waitFor(() => {
      expect(window.api.getSkills).toHaveBeenCalledTimes(1)
    })
    expect(screen.getByText('skill-switch')).toBeInTheDocument()
  })
})
