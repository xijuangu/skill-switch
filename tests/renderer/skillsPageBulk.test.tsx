import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SkillsPage } from '../../src/renderer/src/features/skills/SkillsPage'
import { ToastProvider } from '../../src/renderer/src/app/Toast'
import type { SkillWithConflictView } from '../../src/preload'
import { mockWindowApi } from './api-mock'

// Skills 页批量模式列表交互：
// - 点击行既要勾选，也要让右侧详情跳转到该 Skill（回归：旧实现只勾选不跳转）
// - 提供「清空」与「全选当前」配对（回归：旧实现只有全选，只能逐个取消或退出批量模式）

function buildSkill(id: number): SkillWithConflictView {
  const name = `skill-${String(id).padStart(4, '0')}`
  return {
    id,
    name,
    primary_source_path: `/path/to/${name}`,
    created_at: new Date(2025, 0, 1).toISOString(),
    sources: [{
      id,
      skill_id: id,
      path: `/repo/${name}`,
      hash: `hash${id}`,
      mtime: Date.now(),
      source_type: 'indexed',
      source_role: 'candidate',
      source_origin: 'scan',
      source_tool: 'trae',
      discovered_at: new Date().toISOString(),
      repo_url: null,
      commit_sha: null
    }],
    conflict: { skillId: id, sourceCount: 1, distinctHashCount: 1, hasConflict: false, primarySource: null },
    deployments: []
  }
}

function renderPage(skills: SkillWithConflictView[]) {
  mockWindowApi()
  return render(
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
}

describe('SkillsPage 批量模式列表交互', () => {
  it('批量模式下点击行：勾选该 Skill 且右侧详情同步跳转', async () => {
    renderPage([buildSkill(1), buildSkill(2)])

    // 默认选中第一个
    expect(screen.getByRole('heading', { name: 'skill-0001' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '批量' }))
    await userEvent.click(screen.getByRole('option', { name: /skill-0002/ }))

    expect(screen.getByRole('checkbox', { name: '选择 skill-0002' })).toBeChecked()
    expect(screen.getByRole('heading', { name: 'skill-0002' })).toBeInTheDocument()
  })

  it('批量模式下点击复选框只切换勾选，不跳转详情', async () => {
    renderPage([buildSkill(1), buildSkill(2)])

    await userEvent.click(screen.getByRole('button', { name: '批量' }))
    await userEvent.click(screen.getByRole('checkbox', { name: '选择 skill-0002' }))

    expect(screen.getByRole('checkbox', { name: '选择 skill-0002' })).toBeChecked()
    expect(screen.getByRole('heading', { name: 'skill-0001' })).toBeInTheDocument()
  })

  it('「清空」一键取消全部勾选，与「全选当前」配对', async () => {
    renderPage([buildSkill(1), buildSkill(2)])

    await userEvent.click(screen.getByRole('button', { name: '批量' }))
    await userEvent.click(screen.getByRole('button', { name: '全选当前' }))
    expect(screen.getByText('已选 2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '操作' })).toBeEnabled()

    await userEvent.click(screen.getByRole('button', { name: '清空' }))
    expect(screen.getByText('已选 0')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: '选择 skill-0001' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: '选择 skill-0002' })).not.toBeChecked()
    expect(screen.getByRole('button', { name: '操作' })).toBeDisabled()
  })
})
