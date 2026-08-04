import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BulkSkillActionsDialog, RemoveRegistryDialog } from '../../src/renderer/src/features/skills/dialogs'
import type { SkillWithConflictView } from '../../src/preload'
import { mockWindowApi } from './api-mock'

// 移除时忽略来源目录:两个入口(单个 RemoveRegistryDialog / 批量 remove tab)
// 都提供「忽略这些来源目录，扫描不再登记」勾选,默认勾选;
// 路径清单只含中央仓库外的来源(source_type 非 central-repo)。

function buildSkill(id: number, name: string, withExternalSource = true): SkillWithConflictView {
  const base = {
    skill_id: id,
    hash: `hash-${id}`,
    mtime: Date.now(),
    source_role: 'candidate' as const,
    source_origin: 'scan' as const,
    source_tool: null,
    discovered_at: new Date().toISOString(),
    repo_url: null,
    commit_sha: null
  }
  return {
    id,
    name,
    primary_source_path: `/canonical/${name}`,
    created_at: new Date(2025, 0, 1).toISOString(),
    sources: [
      { ...base, id: id * 10, path: `/canonical/${name}`, source_type: 'central-repo', source_role: 'canonical' },
      ...(withExternalSource
        ? [{ ...base, id: id * 10 + 1, path: `/external/${name}`, source_type: 'indexed' }]
        : [])
    ],
    conflict: { skillId: id, sourceCount: withExternalSource ? 2 : 1, distinctHashCount: 1, hasConflict: false, primarySource: null },
    deployments: []
  }
}

describe('RemoveRegistryDialog 忽略来源目录', () => {
  it('默认勾选并展示中央仓库外的来源路径,确认时传出 ignoreSourcePaths', async () => {
    const onConfirm = vi.fn()
    render(
      <RemoveRegistryDialog
        skill={buildSkill(1, 'alpha')}
        busy={false}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />
    )

    const checkbox = screen.getByRole('checkbox', { name: /忽略这些来源目录/ })
    expect(checkbox).toBeChecked()
    // 只展示中央仓库外的来源路径
    expect(screen.getByText('/external/alpha')).toBeInTheDocument()
    expect(screen.queryByText('/canonical/alpha')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '从注册表移除' }))
    expect(onConfirm).toHaveBeenCalledWith(true)
  })

  it('取消勾选后确认传出 false', async () => {
    const onConfirm = vi.fn()
    render(
      <RemoveRegistryDialog
        skill={buildSkill(1, 'alpha')}
        busy={false}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />
    )

    await userEvent.click(screen.getByRole('checkbox', { name: /忽略这些来源目录/ }))
    await userEvent.click(screen.getByRole('button', { name: '从注册表移除' }))
    expect(onConfirm).toHaveBeenCalledWith(false)
  })

  it('没有中央仓库外的来源时不展示忽略勾选', () => {
    render(
      <RemoveRegistryDialog
        skill={buildSkill(1, 'alpha', false)}
        busy={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(screen.queryByRole('checkbox', { name: /忽略这些来源目录/ })).not.toBeInTheDocument()
  })
})

describe('BulkSkillActionsDialog remove tab 忽略来源目录', () => {
  it('整批一个勾选,默认勾选,提交传给 bulkRemoveFromRegistry', async () => {
    const api = mockWindowApi({
      bulkRemoveFromRegistry: vi.fn().mockResolvedValue({ total: 2, completed: 2, failed: 0, items: [] })
    })
    render(
      <BulkSkillActionsDialog
        skills={[buildSkill(1, 'alpha'), buildSkill(2, 'beta')]}
        allFilteredSkills={[buildSkill(1, 'alpha'), buildSkill(2, 'beta')]}
        consolidationPlan={[]}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
        onConsolidate={vi.fn()}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: '从注册表移除' }))
    const ignore = screen.getByRole('checkbox', { name: /忽略这些来源目录/ })
    expect(ignore).toBeChecked()
    // remove tab 默认全选本批 Skill
    expect(screen.getByRole('checkbox', { name: '移除 alpha' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: '移除 beta' })).toBeChecked()

    await userEvent.click(screen.getByRole('button', { name: '批量从注册表移除' }))
    await waitFor(() => expect(api.bulkRemoveFromRegistry).toHaveBeenCalledWith(
      [
        { key: '1', skillId: 1 },
        { key: '2', skillId: 2 }
      ],
      true
    ))
  })

  it('取消勾选后提交传 false', async () => {
    const api = mockWindowApi({
      bulkRemoveFromRegistry: vi.fn().mockResolvedValue({ total: 1, completed: 1, failed: 0, items: [] })
    })
    render(
      <BulkSkillActionsDialog
        skills={[buildSkill(1, 'alpha')]}
        allFilteredSkills={[buildSkill(1, 'alpha')]}
        consolidationPlan={[]}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
        onConsolidate={vi.fn()}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: '从注册表移除' }))
    await userEvent.click(screen.getByRole('checkbox', { name: /忽略这些来源目录/ }))
    await userEvent.click(screen.getByRole('button', { name: '批量从注册表移除' }))
    await waitFor(() => expect(api.bulkRemoveFromRegistry).toHaveBeenCalledWith(
      [{ key: '1', skillId: 1 }],
      false
    ))
  })
})
