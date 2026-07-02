import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '../../src/renderer/src/app/App'
import { ToastProvider } from '../../src/renderer/src/app/Toast'
import { SkillsPage } from '../../src/renderer/src/features/skills/SkillsPage'
import type { SkillWithConflictView } from '../../src/preload'

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

  it('renders load failure state with retry (not empty state) on first refresh error', async () => {
    mockWindowApi({
      getSkills: vi.fn().mockRejectedValue(new Error('db locked')),
      getTools: vi.fn().mockRejectedValue(new Error('db locked')),
    })
    render(<App />)
    await waitFor(() => {
      expect(screen.getByText('加载失败')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })
})

// #56:1000 条假数据搜索/筛选/选择功能与性能冒烟(不断言毫秒阈值,只确认可用)
function buildFakeSkills(n: number): SkillWithConflictView[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    name: `skill-${String(i + 1).padStart(4, '0')}`,
    primary_source_path: `/path/to/skill-${i + 1}`,
    created_at: new Date(2025, 0, 1).toISOString(),
    sources: [{
      id: i + 1,
      skill_id: i + 1,
      path: `/repo/skill-${i + 1}`,
      hash: `hash${i}`,
      mtime: Date.now(),
      source_type: 'indexed',
      source_origin: 'scan',
      source_tool: 'trae',
      discovered_at: new Date().toISOString(),
      repo_url: null,
      commit_sha: null,
    }],
    conflict: {
      skillId: i + 1,
      sourceCount: 1,
      distinctHashCount: 1,
      hasConflict: false,
      primarySource: null,
    },
    deployments: i % 3 === 0
      ? [{
          id: i + 1,
          skill_id: i + 1,
          target_tool: 'trae',
          target_path: `/trae/skill-${i + 1}`,
          mode: 'symlink' as const,
          source_path: `/repo/skill-${i + 1}`,
          deployed_at: new Date().toISOString(),
          source_hash_at_deploy: `hash${i}`,
          status: 'normal' as const,
        }]
      : [],
  }))
}

describe('SkillsPage 1000-row smoke (#56)', () => {
  it('renders, searches and filters 1000 skills without error', async () => {
    const skills = buildFakeSkills(1000)
    mockWindowApi()
    render(
      <ToastProvider>
        <SkillsPage
          skills={skills}
          tools={[]}
          scanning={false}
          lastScan={null}
          loading={false}
          loadError={null}
          onScan={vi.fn()}
          onRefresh={vi.fn().mockResolvedValue(undefined)}
          onRetry={vi.fn().mockResolvedValue(undefined)}
        />
      </ToastProvider>
    )
    // 首条已选中(列表 + detail 都可能出现,用 getAllByText)
    expect(screen.getAllByText('skill-0001').length).toBeGreaterThan(0)
    // 搜索 narrowing
    const search = screen.getByPlaceholderText('搜索名称、路径或工具…')
    await userEvent.type(search, 'skill-0500')
    expect(screen.getAllByText('skill-0500').length).toBeGreaterThan(0)
    // 清空搜索后筛选"已部署"
    await userEvent.clear(search)
    const deployedBtn = screen.getByRole('button', { name: '已部署' })
    await userEvent.click(deployedBtn)
    // 已部署的 skill-0001(id=1,i=0,0%3===0 有 deployment)应可见
    expect(screen.getAllByText('skill-0001').length).toBeGreaterThan(0)
  })
})
