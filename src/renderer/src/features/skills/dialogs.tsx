import { useState, useEffect } from 'react'
import { Button, Input, Dialog } from '../../shared'
import { completeMutation } from '../../async-state'
import { groupByHash, shortHash, findSourceGroup } from './sourceGrouping'

export type DeployMode = 'copy' | 'symlink'
export type SkillView = Awaited<ReturnType<typeof window.api.getSkills>>[number]
export type SkillSourceView = SkillView['sources'][number]
export type DeployResultView = Extract<
  Awaited<ReturnType<typeof window.api.deploymentDeploy>>,
  { status: 'completed' }
>['result']
export type DeployTargetOptionView = Awaited<ReturnType<typeof window.api.getDeployTargets>>[number]
export type InstallResultView = Awaited<ReturnType<typeof window.api.installFromGitHub>>
export type ConsolidationPreview = Awaited<ReturnType<typeof window.api.previewConsolidation>>
export type ConsolidationBatchPreview = Awaited<ReturnType<typeof window.api.previewConsolidationBatch>>
export type ConsolidationBatch = Awaited<ReturnType<typeof window.api.getSkillLibrary>>['consolidationBatches'][number]
export type ConsolidationPlanItem = Awaited<ReturnType<typeof window.api.getSkillLibrary>>['consolidationPlan'][number]
export type ConflictResolutionPreview = Awaited<ReturnType<typeof window.api.previewConflictResolution>>
export type ConflictResolutionDecision = NonNullable<Parameters<typeof window.api.previewConsolidationBatch>[0]['items'][number]['conflictResolution']>
export type ConflictVersionAction = { action: 'archive' | 'save-as'; newSkillName: string; canonicalRelativeParent: string }
export type ConsolidationDraft = ConsolidationPlanItem & {
  selected: boolean
  canonicalRelativeParent: string
  conflictResolution?: ConflictResolutionDecision
}
export type ConflictResolutionEditor = {
  draftSkillId: number
  preview: ConflictResolutionPreview
  authoritativeSourceId: number | null
  actions: Record<string, ConflictVersionAction>
}
export type UndoBatch = { batch: ConsolidationBatch; item: ConsolidationBatch['items'][number] }
export type SourceRelocationPreview = Awaited<ReturnType<typeof window.api.previewSourceRelocation>>
export type SourceRelocation = Awaited<ReturnType<typeof window.api.getSkillLibrary>>['sourceRelocations'][number]
type BulkMutationResultView = Awaited<ReturnType<typeof window.api.bulkDeploy>>

export function sourceOriginLabel(origin: SkillSourceView['source_origin']): string {
  const labels: Record<SkillSourceView['source_origin'], string> = {
    scan: '扫描发现',
    local: '添加本地',
    github: 'GitHub 安装',
    zip: 'ZIP 安装',
    legacy: '旧版来源',
  }
  return labels[origin]
}

export function sourceRoleLabel(role: SkillSourceView['source_role']): string {
  return role === 'canonical' ? '权威来源' : '候选来源'
}

type BulkAction = 'deploy' | 'undeploy' | 'remove'
type BulkDeployPair = {
  key: string
  skillName: string
  sourceId: number
  targetId: string
  targetName: string
  eligible: boolean
  reason: string | null
}
type BulkUndeployItem = {
  key: string
  skillName: string
  deploymentId: number
  targetTool: string
  targetPath: string | null
}

export function BulkSkillActionsDialog({
  skills,
  onRefresh,
  onClose
}: {
  skills: SkillView[]
  onRefresh: () => Promise<void>
  onClose: () => void
}) {
  const [action, setAction] = useState<BulkAction>('deploy')
  const [mode, setMode] = useState<DeployMode>('symlink')
  const [deployPairs, setDeployPairs] = useState<BulkDeployPair[]>([])
  const [undeployItems, setUndeployItems] = useState<BulkUndeployItem[]>([])
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [toolFilter, setToolFilter] = useState('all')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<BulkMutationResultView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setResult(null)
    setLoadError(null)
    if (action === 'remove') {
      setSelectedKeys(new Set(skills.map((skill) => String(skill.id))))
      return () => { cancelled = true }
    }
    setBusy(true)
    if (action === 'deploy') {
      Promise.all(skills.map(async (skill) => {
        const canonical = skill.sources.find((source) => source.source_role === 'canonical')
        if (!canonical) return []
        const targets = await window.api.getDeployTargets(canonical.id)
        return targets.map((target) => ({
          key: `${skill.id}:${target.targetId}`,
          skillName: skill.name,
          sourceId: canonical.id,
          targetId: target.targetId,
          targetName: target.displayName,
          eligible: target.eligible,
          reason: target.reason
        }))
      })).then((groups) => {
        if (cancelled) return
        const pairs = groups.flat()
        setDeployPairs(pairs)
        setSelectedKeys(new Set(pairs.filter((pair) => pair.eligible).map((pair) => pair.key)))
      }).catch((error) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error))
      }).finally(() => {
        if (!cancelled) setBusy(false)
      })
    } else {
      Promise.all(skills.map(async (skill) => {
        const deployments = await window.api.getDeploymentsForSkill(skill.id)
        return deployments
          .filter((deployment) => deployment.management === 'managed')
          .map((deployment) => ({
            key: String(deployment.id),
            skillName: skill.name,
            deploymentId: deployment.id,
            targetTool: deployment.target_tool,
            targetPath: deployment.target_path
          }))
      })).then((groups) => {
        if (cancelled) return
        const items = groups.flat()
        setUndeployItems(items)
        setSelectedKeys(new Set(items.map((item) => item.key)))
      }).catch((error) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error))
      }).finally(() => {
        if (!cancelled) setBusy(false)
      })
    }
    return () => { cancelled = true }
  }, [action, skills])

  const toggle = (key: string) => {
    setSelectedKeys((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const visibleUndeployItems = toolFilter === 'all'
    ? undeployItems
    : undeployItems.filter((item) => item.targetTool === toolFilter)
  const selectedCount = action === 'undeploy'
    ? visibleUndeployItems.filter((item) => selectedKeys.has(item.key)).length
    : selectedKeys.size

  const run = async () => {
    setBusy(true)
    setResult(null)
    try {
      let outcome: BulkMutationResultView
      if (action === 'deploy') {
        outcome = await window.api.bulkDeploy(
          deployPairs
            .filter((pair) => pair.eligible && selectedKeys.has(pair.key))
            .map((pair) => ({
              key: pair.key,
              sourceId: pair.sourceId,
              targetId: pair.targetId,
              requestedMode: mode
            }))
        )
      } else if (action === 'undeploy') {
        outcome = await window.api.bulkUndeploy(
          visibleUndeployItems
            .filter((item) => selectedKeys.has(item.key))
            .map((item) => ({ key: item.key, deploymentId: item.deploymentId }))
        )
      } else {
        outcome = await window.api.bulkRemoveFromRegistry(
          skills
            .filter((skill) => selectedKeys.has(String(skill.id)))
            .map((skill) => ({ key: String(skill.id), skillId: skill.id }))
        )
      }
      setResult(outcome)
      setSelectedKeys(new Set(outcome.items.filter((item) => item.status !== 'completed').map((item) => item.key)))
      await onRefresh()
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const resultByKey = new Map(result?.items.map((item) => [item.key, item]) ?? [])
  const actionLabel = action === 'deploy' ? '批量部署' : action === 'undeploy' ? '批量取消部署' : '批量从注册表移除'

  return (
    <Dialog
      open
      onClose={onClose}
      title={`批量操作 · ${skills.length} 个 Skill`}
      description="成功项会从选择中移除；失败项保留，修正后可直接重试。"
      confirmLabel={actionLabel}
      busy={busy}
      onConfirm={() => { if (selectedCount > 0) run() }}
      closeOnOverlay={false}
    >
      <div className="space-y-4">
        <div className="flex gap-2">
          {([
            ['deploy', '部署'],
            ['undeploy', '取消部署'],
            ['remove', '从注册表移除']
          ] as const).map(([value, label]) => (
            <Button key={value} size="sm" variant={action === value ? 'primary' : 'secondary'} onClick={() => setAction(value)}>
              {label}
            </Button>
          ))}
        </div>

        {action === 'deploy' && (
          <div>
            <p className="text-xs font-medium text-foreground mb-2">模式</p>
            <div className="flex gap-3">
              {(['symlink', 'copy'] as const).map((value) => (
                <label key={value} className="flex items-center gap-1.5 text-xs">
                  <input type="radio" name="bulk-deploy-mode" checked={mode === value} onChange={() => setMode(value)} />
                  {value}
                </label>
              ))}
            </div>
          </div>
        )}

        {action === 'undeploy' && (
          <label className="block text-xs">
            目标工具
            <select className="ml-2 border border-border rounded bg-surface px-2 py-1" value={toolFilter} onChange={(event) => setToolFilter(event.target.value)}>
              <option value="all">全部工具</option>
              {[...new Set(undeployItems.map((item) => item.targetTool))].map((tool) => <option key={tool} value={tool}>{tool}</option>)}
            </select>
          </label>
        )}

        {loadError && <p className="text-xs text-danger">{loadError}</p>}
        {result && (
          <div className="rounded border border-border p-2 text-xs">
            <p className="font-medium">完成 {result.completed}，失败 {result.failed}</p>
            {result.items.filter((item) => item.status !== 'completed').map((item) => (
              <p key={item.key} className="text-danger mt-1">{item.key}: {item.message ?? item.status}</p>
            ))}
          </div>
        )}

        <div className="max-h-72 overflow-auto space-y-1">
          {action === 'deploy' && deployPairs.map((pair) => (
            <label key={pair.key} className={`flex items-start gap-2 rounded border border-border p-2 text-xs ${!pair.eligible ? 'opacity-50' : ''}`}>
              <input type="checkbox" aria-label={`${pair.skillName} → ${pair.targetName}`} checked={selectedKeys.has(pair.key)} disabled={!pair.eligible || busy} onChange={() => toggle(pair.key)} />
              <span><strong>{pair.skillName}</strong> → {pair.targetName}{pair.reason ? <span className="block text-foreground-muted">{pair.reason}</span> : null}</span>
            </label>
          ))}
          {action === 'undeploy' && visibleUndeployItems.map((item) => (
            <label key={item.key} className="flex items-start gap-2 rounded border border-border p-2 text-xs">
              <input type="checkbox" aria-label={`${item.skillName} → ${item.targetTool}`} checked={selectedKeys.has(item.key)} disabled={busy} onChange={() => toggle(item.key)} />
              <span><strong>{item.skillName}</strong> → {item.targetTool}<span className="block text-foreground-muted break-all">{item.targetPath}</span></span>
            </label>
          ))}
          {action === 'remove' && skills.map((skill) => (
            <label key={skill.id} className="flex items-center gap-2 rounded border border-border p-2 text-xs">
              <input type="checkbox" aria-label={`移除 ${skill.name}`} checked={selectedKeys.has(String(skill.id))} disabled={busy} onChange={() => toggle(String(skill.id))} />
              <span>{skill.name}</span>
              {resultByKey.get(String(skill.id))?.message && <span className="text-danger ml-auto">{resultByKey.get(String(skill.id))?.message}</span>}
            </label>
          ))}
        </div>
      </div>
    </Dialog>
  )
}

function conflictFileStatusLabel(status: 'added' | 'deleted' | 'modified'): string {
  return { added: '新增', deleted: '删除', modified: '修改' }[status]
}

export function ConflictDialog({
  skill,
  onCancel,
  onConfirm
}: {
  skill: SkillView
  onCancel: () => void
  onConfirm: (source: SkillSourceView) => void
}) {
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const hashGroups = groupByHash(skill.sources)
  const distinctVersions = hashGroups.size

  return (
    <Dialog
      open
      onClose={onCancel}
      title={`解决版本冲突 — ${skill.name}`}
      description={`检测到 ${distinctVersions} 个不同版本 (共 ${skill.sources.length} 个来源)，请选择要使用哪个版本。`}
      confirmLabel="使用此版本"
      onConfirm={() => {
        const picked = skill.sources.find((s) => s.id === selectedId)
        if (picked) onConfirm(picked)
      }}
      closeOnOverlay={false}
    >
      <div className="space-y-2">
        {skill.sources.map((src) => {
          const sameHashCount = hashGroups.get(src.hash)?.length ?? 1
          return (
            <label
              key={src.id}
              className={`block border rounded p-2.5 cursor-pointer transition-colors duration-fast ${
                selectedId === src.id
                  ? 'border-primary bg-primary-subtle'
                  : 'border-border hover:bg-surface-hover'
              }`}
            >
              <div className="flex items-start gap-2">
                <input
                  type="radio"
                  name="conflict-source"
                  checked={selectedId === src.id}
                  onChange={() => setSelectedId(src.id)}
                  className="mt-0.5"
                />
                <div className="flex-1 min-w-0 text-xs space-y-0.5">
                  <div className="font-mono text-foreground break-all">{src.path}</div>
                  <div className="font-mono text-foreground-secondary text-2xs">{src.hash}</div>
                  <div className="text-foreground-muted text-2xs">
                    {sourceRoleLabel(src.source_role)} · {sourceOriginLabel(src.source_origin)} · {src.source_type}
                    {sameHashCount > 1 && ` · 与另外 ${sameHashCount - 1} 个来源内容一致`}
                  </div>
                </div>
              </div>
            </label>
          )
        })}
      </div>
    </Dialog>
  )
}

export function DeployDialogContent({
  skill,
  sourceId,
  contextMessage,
  onDone
}: {
  skill: SkillView
  sourceId: number
  contextMessage?: string
  onDone: (result: DeployResultView | null) => Promise<void>
}) {
  const source = skill.sources.find((candidate) => candidate.id === sourceId)
  const [targetOptions, setTargetOptions] = useState<DeployTargetOptionView[]>([])
  const [selectedTargetId, setSelectedTargetId] = useState('')
  const [mode, setMode] = useState<DeployMode>('symlink')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmationPlan, setConfirmationPlan] = useState<{
    targetDisplayName: string
    confirmationId: string
    reasons: Array<'external-overwrite' | 'target-modified' | 'mode-degraded'>
    requestedMode: 'copy' | 'symlink' | 'junction'
    actualMode: 'copy' | 'symlink' | 'junction'
    backup: { required: boolean; directory: string | null }
  } | null>(null)

  useEffect(() => {
    window.api.getDeployTargets(sourceId)
      .then((options) => {
        setTargetOptions(options)
        const existing = options.find(
          (o) => o.eligible &&
            skill.deployments.some((d) => d.target_id === o.targetId)
        )
        const firstSafe = options.find((o) => o.eligible)
        if (existing) {
          setSelectedTargetId(existing.targetId)
        } else if (firstSafe) {
          setSelectedTargetId(firstSafe.targetId)
        }
      })
      .catch((loadError) => {
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      })
  }, [skill.id, skill.deployments, sourceId])

  const targetSelectionValid = targetOptions.some(
    (o) => o.targetId === selectedTargetId && o.eligible
  )
  const selectedDeployment = skill.deployments.find(
    (d) => d.target_id === selectedTargetId
  )

  const handleDeploy = async () => {
    if (!selectedTargetId || !targetSelectionValid) return
    setBusy(true)
    setError(null)
    try {
      if (!source) throw new Error('所选来源已失效，请刷新后重试')
      const outcome = await window.api.deploymentDeploy({
        sourceId: source.id,
        targetId: selectedTargetId,
        requestedMode: mode
      })
      if (outcome.status === 'confirmation-required') {
        setConfirmationPlan({
          targetDisplayName: outcome.facts.targetDisplayName,
          confirmationId: outcome.confirmationId,
          reasons: outcome.facts.reasons,
          requestedMode: outcome.facts.requestedMode,
          actualMode: outcome.facts.actualMode,
          backup: outcome.facts.backup
        })
        setBusy(false)
        return
      }
      if (outcome.status === 'rejected') throw new Error(outcome.message)
      if (outcome.status === 'recovery-required') throw new Error(`需要人工恢复：${outcome.message}\n${outcome.evidence.targetPath}`)
      await completeMutation(outcome.result, onDone)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleExternalOverwriteConfirm = async () => {
    if (!confirmationPlan) return
    setBusy(true)
    setError(null)
    try {
      const outcome = await window.api.deploymentConfirm(confirmationPlan.confirmationId)
      if (outcome.status !== 'completed') {
        throw new Error(outcome.status === 'confirmation-required' ? '部署计划已变化，请重新确认' : outcome.message)
      }
      setConfirmationPlan(null)
      await completeMutation(outcome.result, onDone)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={() => !busy && onDone(null)}
      title={`部署 ${skill.name}`}
      description={contextMessage}
      confirmLabel="部署"
      onConfirm={handleDeploy}
      busy={busy}
      closeOnOverlay={!busy}
    >
      <div className="space-y-4">
        <p className="text-xs text-foreground-secondary font-mono break-all">
          {source?.path ?? '来源已失效'}
        </p>

        {skill.conflict.hasConflict && (() => {
          // 一次 groupByHash 派生当前组与其他版本数,避免重复遍历(#62 review)
          const groups = groupByHash(skill.sources)
          const currentGroup = source == null ? null : findSourceGroup(skill.sources, source.path)
          const otherVersions = groups.size - (currentGroup ? 1 : 0)
          return (
            <div className="px-3 py-2 rounded border border-warning-subtle bg-warning-subtle space-y-0.5">
              {currentGroup ? (
                <div className="text-2xs text-warning font-medium">
                  当前来源属于版本组 · {currentGroup.count} 个来源 · hash: {shortHash(currentGroup.hash)}
                </div>
              ) : (
                <div className="text-2xs text-warning font-medium">
                  当前来源未匹配任何版本组
                </div>
              )}
              {otherVersions > 0 && (
                <div className="text-2xs text-warning">
                  另有 {otherVersions} 个不同版本
                </div>
              )}
            </div>
          )
        })()}

        {error && (
          <div className="px-3 py-2 rounded border border-danger-subtle bg-danger-subtle text-danger text-xs">{error}</div>
        )}

        <div>
          <label className="block text-xs font-medium text-foreground mb-1">目标工具</label>
          <select
            value={selectedTargetId}
            onChange={(e) => {
              setSelectedTargetId(e.target.value)
            }}
            disabled={busy}
            className="w-full h-8 border border-border rounded bg-surface px-2.5 text-xs text-foreground focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none disabled:opacity-50"
          >
            {targetOptions.length === 0 && (
              <option value="" disabled>无可用工具目标</option>
            )}
            {targetOptions.map((o) => (
              <option key={o.targetId} value={o.targetId} disabled={!o.eligible}>
                {o.displayName}
                {!o.eligible ? ` (不可用：${o.reason})` : ''}
              </option>
            ))}
          </select>
          {selectedDeployment && (
            <p className="text-2xs text-foreground-muted mt-1">
              此工具已有部署，只能更新原目标
            </p>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-foreground mb-1">模式</label>
          <div className="flex gap-3">
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input
                type="radio"
                name="deploy-mode"
                checked={mode === 'symlink'}
                onChange={() => setMode('symlink')}
                disabled={busy}
              />
              symlink
            </label>
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input
                type="radio"
                name="deploy-mode"
                checked={mode === 'copy'}
                onChange={() => setMode('copy')}
                disabled={busy}
              />
              copy
            </label>
          </div>
          <p className="text-2xs text-foreground-muted mt-1">
            {mode === 'symlink'
              ? '请求链接部署；如平台只能使用 copy，会先请求确认'
              : '快照副本 — 源更新需手动重新部署'}
          </p>
        </div>
      </div>

      <Dialog
        open={confirmationPlan !== null}
        onClose={() => !busy && setConfirmationPlan(null)}
        title={`确认部署风险「${skill.name}」?`}
        description={confirmationPlan == null ? '' : [
          ...confirmationPlan.reasons.map((reason) => ({
            'external-overwrite': '目标包含非本应用管理的内容，将覆盖现有内容。',
            'target-modified': '已部署目标被外部修改，将用当前来源覆盖。',
            'mode-degraded': `请求模式 ${confirmationPlan.requestedMode} 不可用，实际将使用 ${confirmationPlan.actualMode}。`
          })[reason]),
          `目标：${confirmationPlan.targetDisplayName}`,
          confirmationPlan.backup.required
            ? `覆盖前会备份到：${confirmationPlan.backup.directory ?? '应用备份目录'}`
            : '本次不会创建外部内容备份。'
        ].join('\n')}
        variant="danger"
        confirmLabel="确认并部署"
        onConfirm={handleExternalOverwriteConfirm}
        busy={busy}
        closeOnOverlay={false}
      />
    </Dialog>
  )
}

export function InstallDialogContent({
  initialTab,
  onInstalled,
  onRefresh,
  onClose
}: {
  initialTab: 'github' | 'zip' | 'local-dir'
  onInstalled: (result: InstallResultView) => Promise<void>
  onRefresh: () => Promise<void>
  onClose: () => void
}) {
  const [tab, setTab] = useState<'github' | 'zip' | 'local-dir'>(initialTab)
  const [githubUrl, setGithubUrl] = useState('')
  const [zipPath, setZipPath] = useState<string | null>(null)
  const [localPath, setLocalPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [installedSkill, setInstalledSkill] = useState<SkillView | null>(null)

  const handleSelectZip = async () => {
    const path = await window.api.selectZipFile()
    if (path) setZipPath(path)
  }

  const handleSelectDir = async () => {
    const path = await window.api.selectLocalDir()
    if (path) setLocalPath(path)
  }

  const handleInstall = async () => {
    setBusy(true)
    setError(null)
    try {
      let result: InstallResultView
      if (tab === 'github') {
        if (!githubUrl.trim()) {
          setError('请输入 GitHub URL')
          setBusy(false)
          return
        }
        result = await window.api.installFromGitHub(githubUrl.trim())
      } else if (tab === 'zip') {
        if (!zipPath) {
          setError('请选择 ZIP 文件')
          setBusy(false)
          return
        }
        result = await window.api.installFromZip(zipPath)
      } else {
        if (!localPath) {
          setError('请选择目录')
          setBusy(false)
          return
        }
        result = await window.api.installFromLocalDir(localPath)
      }
      await completeMutation(result, onInstalled)
      const skills = await window.api.getSkills()
      const installed = skills.find((skill) => skill.id === result.skillId)
      if (!installed) throw new Error('安装已完成，但刷新后未找到对应 Skill')
      setInstalledSkill(installed)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (installedSkill) {
    const canonical = installedSkill.sources.find((source) => source.source_role === 'canonical')
    if (!canonical) {
      return (
        <Dialog
          open
          onClose={onClose}
          title={`已安装 ${installedSkill.name}`}
          description="安装已完成，但未找到可部署的权威 Source。"
          hideCancel
          confirmLabel="关闭"
          onConfirm={onClose}
        />
      )
    }
    return (
      <DeployDialogContent
        skill={installedSkill}
        sourceId={canonical.id}
        contextMessage="安装完成，可继续部署到多个工具；每次成功后弹窗会保持打开。"
        onDone={async (result) => {
          if (!result) {
            onClose()
            return
          }
          await onRefresh()
          const refreshed = (await window.api.getSkills()).find((skill) => skill.id === installedSkill.id)
          if (refreshed) setInstalledSkill(refreshed)
        }}
      />
    )
  }

  return (
    <Dialog
      open
      onClose={() => !busy && onClose()}
      title="安装 Skill"
      confirmLabel="安装"
      onConfirm={handleInstall}
      busy={busy}
    >
      <div className="space-y-4">
        {error && (
          <div className="px-3 py-2 rounded border border-danger-subtle bg-danger-subtle text-danger text-xs">{error}</div>
        )}

        <div className="flex gap-1 border-b border-border">
          {(['github', 'zip', 'local-dir'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              disabled={busy}
              className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors -mb-px ${
                tab === t ? 'border-primary text-primary' : 'border-transparent text-foreground-secondary hover:text-foreground'
              }`}
            >
              {t === 'github' ? 'GitHub URL' : t === 'zip' ? 'ZIP 文件' : '本地目录'}
            </button>
          ))}
        </div>

        {tab === 'github' && (
          <div>
            <label className="block text-xs text-foreground-secondary mb-1">GitHub 仓库 URL</label>
            <Input
              value={githubUrl}
              onChange={(e) => setGithubUrl(e.target.value)}
              disabled={busy}
              placeholder="https://github.com/owner/repo[/tree/main/skills/grilling]"
              mono
              className="w-full"
            />
            <p className="text-2xs text-foreground-muted mt-1">
              单 skill 仓库或子路径（如 <code className="font-mono text-2xs">/tree/main/skills/grilling</code>）
            </p>
          </div>
        )}

        {tab === 'zip' && (
          <div>
            <label className="block text-xs text-foreground-secondary mb-1">ZIP 文件</label>
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={handleSelectZip} disabled={busy} size="sm">
                选择 ZIP…
              </Button>
              {zipPath && <code className="text-xs font-mono text-foreground-secondary truncate">{zipPath}</code>}
            </div>
          </div>
        )}

        {tab === 'local-dir' && (
          <div>
            <label className="block text-xs text-foreground-secondary mb-1">本地目录</label>
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={handleSelectDir} disabled={busy} size="sm">
                选择目录…
              </Button>
              {localPath && <code className="text-xs font-mono text-foreground-secondary truncate">{localPath}</code>}
            </div>
            <p className="text-2xs text-foreground-muted mt-1">
              将内容复制到权威源码库；原目录保持不变。
            </p>
          </div>
        )}
      </div>
    </Dialog>
  )
}

export function ViewMdDialog({
  skillName,
  content,
  path,
  onClose
}: {
  skillName: string
  content: string
  path: string
  onClose: () => void
}) {
  return (
    <Dialog open onClose={onClose} title={`${skillName} — SKILL.md`} hideCancel confirmLabel="关闭" onConfirm={onClose}>
      <p className="text-2xs text-foreground-muted mb-2 font-mono break-all">{path}</p>
      <pre className="text-xs text-foreground whitespace-pre-wrap break-words font-mono">{content}</pre>
    </Dialog>
  )
}

export function ViewMdSourcePicker({
  skill,
  onPick,
  onCancel
}: {
  skill: SkillView
  onPick: (source: SkillSourceView) => void
  onCancel: () => void
}) {
  const [selectedId, setSelectedId] = useState<number | null>(null)
  return (
    <Dialog
      open
      onClose={onCancel}
      title={`选择 Source — ${skill.name}`}
      description="存在多个 source，请选择要查看哪个 SKILL.md"
      confirmLabel="查看"
      onConfirm={() => {
        const picked = skill.sources.find((s) => s.id === selectedId)
        if (picked) onPick(picked)
      }}
    >
      <div className="space-y-2">
        {skill.sources.map((src) => (
          <label
            key={src.id}
            className={`block border rounded p-2 cursor-pointer transition-colors ${
              selectedId === src.id ? 'border-primary bg-primary-subtle' : 'border-border hover:bg-surface-hover'
            }`}
          >
            <div className="flex items-start gap-2">
              <input
                type="radio"
                name="viewmd-source"
                checked={selectedId === src.id}
                onChange={() => setSelectedId(src.id)}
                className="mt-0.5"
              />
              <div className="flex-1 min-w-0 text-xs space-y-0.5">
                <div className="font-mono text-foreground break-all">{src.path}</div>
                <div className="font-mono text-foreground-secondary text-2xs">{src.hash}</div>
                <div className="text-foreground-muted text-2xs">
                  {sourceRoleLabel(src.source_role)} · {sourceOriginLabel(src.source_origin)}
                </div>
              </div>
            </div>
          </label>
        ))}
      </div>
    </Dialog>
  )
}

export function UndeployDialog({
  skill,
  deployments,
  busy,
  onUndeploy,
  onClose
}: {
  skill: SkillView
  deployments: { id: number; target_tool: string; mode: string; target_path?: string | null }[]
  busy: boolean
  onUndeploy: (deploymentId: number) => void
  onClose: () => void
}) {
  return (
    <Dialog
      open
      onClose={() => !busy && onClose()}
      title={`从…取消部署 ${skill.name}`}
      description={`${deployments.length} 个部署。此操作只移除部署（链接/副本），不删源文件。`}
      hideCancel
      closeOnOverlay={!busy}
    >
      <div className="space-y-2 max-h-48 overflow-auto">
        {deployments.map((d) => (
          <div key={d.id} className="flex items-center justify-between border border-border rounded px-2.5 py-2">
            <div className="flex items-center gap-2 min-w-0">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium">{d.target_tool}</span>
                  <span className="text-2xs px-1 py-px rounded bg-surface-secondary text-foreground-secondary">{d.mode}</span>
                </div>
                {d.target_path && <div className="text-2xs text-foreground-muted truncate">{d.target_path}</div>}
              </div>
            </div>
            <Button variant="danger" size="sm" onClick={() => onUndeploy(d.id)} disabled={busy}>
              取消部署
            </Button>
          </div>
        ))}
      </div>
      <div className="mt-3 flex justify-end">
        <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
          关闭
        </Button>
      </div>
    </Dialog>
  )
}

export function RemoveRegistryDialog({
  skill,
  busy,
  onConfirm,
  onCancel
}: {
  skill: SkillView
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Dialog
      open
      onClose={onCancel}
      title={`从注册表移除「${skill.name}」?`}
      variant="danger"
      description="此操作将永久从注册表移除该 skill：将中央仓库实体备份（如有），从所有工具取消部署，并删除注册表记录。此操作不可撤销。"
      confirmLabel="从注册表移除"
      onConfirm={onConfirm}
      busy={busy}
      closeOnOverlay={false}
    />
  )
}

function ConsolidationOperations({ operations }: { operations: ConsolidationPreview['operations'] }) {
  const labels: Record<ConsolidationPreview['operations'][number]['kind'], string> = {
    'write-canonical': '写入权威源码库',
    'archive-candidate': '永久归档候选来源',
    'remove-observed-entry': '移除外部订阅入口'
  }
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {operations.map((operation, index) => (
          <div key={`${operation.kind}:${operation.path}:${index}`} className="rounded border border-border p-2">
            <p className="text-xs font-medium text-foreground-secondary">{labels[operation.kind]}</p>
            <code className="block mt-1 text-2xs text-foreground-muted break-all">{operation.path}</code>
          </div>
        ))}
      </div>
      <p className="text-xs text-warning">归档会永久保留，直到你手动清理归档批次。</p>
      <p className="text-xs text-foreground-secondary">整理只建立权威来源，不会自动部署到任何工具。</p>
    </div>
  )
}

export function ConsolidationDialog({
  skill,
  source,
  preview,
  busy,
  onPreview,
  onConfirm,
  onClose
}: {
  skill: SkillView
  source: SkillSourceView
  preview: ConsolidationPreview | null
  busy: boolean
  onPreview: (canonicalRelativeParent: string) => void
  onConfirm: () => void
  onClose: () => void
}) {
  const [canonicalRelativeParent, setCanonicalRelativeParent] = useState('')
  return (
    <Dialog
      open
      onClose={onClose}
      title={preview ? `确认整理「${skill.name}」` : `整理「${skill.name}」`}
      busy={busy}
      confirmLabel={preview ? '确认整理' : '预览整理'}
      onConfirm={preview ? onConfirm : () => onPreview(canonicalRelativeParent)}
      closeOnOverlay={false}
    >
      {preview ? (
        <ConsolidationOperations operations={preview.operations} />
      ) : (
        <div className="space-y-3">
          <div className="space-y-1">
            <label htmlFor="canonical-relative-parent" className="block text-xs font-medium text-foreground-secondary">
              权威库内父目录
            </label>
            <Input
              id="canonical-relative-parent"
              aria-label="权威库内父目录"
              value={canonicalRelativeParent}
              onChange={(event) => setCanonicalRelativeParent(event.target.value)}
              placeholder="留空表示权威库根目录"
              mono
              className="w-full"
            />
          </div>
          <p className="text-2xs text-foreground-muted">
            这里只填写权威库内的相对父目录；Skill 名称会自动保留。
          </p>
        </div>
      )}
    </Dialog>
  )
}

export function BatchConsolidationDialog({
  drafts,
  preview,
  busy,
  onApplyBatchParent,
  onToggleDraft,
  onDraftParentChange,
  onResolveConflict,
  onPreview,
  onConfirm,
  onClose
}: {
  drafts: ConsolidationDraft[]
  preview: ConsolidationBatchPreview | null
  busy: boolean
  onApplyBatchParent: (parent: string) => void
  onToggleDraft: (skillId: number, selected: boolean) => void
  onDraftParentChange: (skillId: number, parent: string) => void
  onResolveConflict: (draft: ConsolidationDraft) => void
  onPreview: () => void
  onConfirm: () => void
  onClose: () => void
}) {
  const [batchRelativeParent, setBatchRelativeParent] = useState('')
  return (
    <Dialog
      open
      onClose={onClose}
      title={preview ? '确认批量整理' : '选择要整理的 Skill'}
      description="无冲突项默认选中；冲突项需在冲突解决流程中明确版本后才能选择。"
      busy={busy}
      confirmLabel={preview ? '确认批量整理' : '预览批量整理'}
      onConfirm={preview ? onConfirm : onPreview}
      closeOnOverlay={false}
    >
      {preview ? (
        <ConsolidationOperations operations={preview.operations} />
      ) : (
        <div className="space-y-3">
          <div className="rounded border border-border p-3 space-y-2">
            <label htmlFor="batch-relative-parent" className="block text-xs font-medium text-foreground-secondary">
              批量设置权威库内父目录
            </label>
            <div className="flex gap-2">
              <Input
                id="batch-relative-parent"
                aria-label="批量设置权威库内父目录"
                value={batchRelativeParent}
                onChange={(event) => setBatchRelativeParent(event.target.value)}
                placeholder="留空表示权威库根目录"
                mono
                className="flex-1"
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onApplyBatchParent(batchRelativeParent)}
              >
                应用到已选
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            {drafts.map((draft) => (
              <div key={draft.skillId} className="rounded border border-border p-3 space-y-2">
                <label className="flex items-center gap-2 text-xs font-medium">
                  <input
                    type="checkbox"
                    aria-label={`选择 ${draft.skillName}`}
                    checked={draft.selected}
                    disabled={draft.hasConflict && !draft.conflictResolution}
                    onChange={(event) => onToggleDraft(draft.skillId, event.target.checked)}
                  />
                  <span>{draft.skillName}</span>
                  <span className="text-2xs text-foreground-muted">
                    {draft.hasConflict
                      ? draft.conflictResolution ? '冲突已解决' : `${draft.versions.length} 个冲突版本（未选择）`
                      : `${draft.versions[0].candidateSourceIds.length} 个同内容来源`}
                  </span>
                </label>
                {draft.hasConflict && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onResolveConflict(draft)}
                    aria-label={`解决 ${draft.skillName} 的版本冲突`}
                  >
                    {draft.conflictResolution ? '修改冲突决策' : '解决冲突'}
                  </Button>
                )}
                <Input
                  aria-label={`${draft.skillName} 权威库内父目录`}
                  value={draft.canonicalRelativeParent}
                  disabled={!draft.selected}
                  onChange={(event) => onDraftParentChange(draft.skillId, event.target.value)}
                  placeholder="权威库根目录"
                  mono
                  className="w-full"
                />
              </div>
            ))}
          </div>
          <p className="text-2xs text-foreground-muted">最终目录名固定使用 Skill 名称；未选 Candidate 不会被本批次修改。</p>
        </div>
      )}
    </Dialog>
  )
}

export function ConflictResolutionDialog({
  editor,
  busy,
  onEditorChange,
  onApply,
  onClose
}: {
  editor: ConflictResolutionEditor
  busy: boolean
  onEditorChange: (updater: (editor: ConflictResolutionEditor) => ConflictResolutionEditor) => void
  onApply: () => void
  onClose: () => void
}) {
  return (
    <Dialog
      open
      onClose={onClose}
      title={`解决「${editor.preview.skillName}」的版本冲突`}
      description="不会自动选版或合并；请明确原名权威版本，并处理每个其他版本。"
      busy={busy}
      confirmLabel="应用冲突决策"
      onConfirm={onApply}
      closeOnOverlay={false}
    >
      <div className="space-y-4">
        {editor.preview.versions.map((version, index) => {
          const label = 'ABCDEFGH'[index] ?? String(index + 1)
          const selectedVersion = version.sources.some((source) => source.id === editor.authoritativeSourceId)
          const action = editor.actions[version.hash]
          return (
            <section key={version.hash} className="rounded border border-border p-3 space-y-2">
              <label className="flex items-center gap-2 text-xs font-medium">
                <input
                  type="radio"
                  name="authoritative-conflict-version"
                  aria-label={`选择版本 ${label} 作为原名权威版本`}
                  checked={selectedVersion}
                  onChange={() => onEditorChange((prev) => ({ ...prev, authoritativeSourceId: version.sources[0].id }))}
                />
                <span>版本 {label}</span>
                <code className="text-2xs text-foreground-muted">{shortHash(version.hash)}</code>
              </label>
              <div className="space-y-1">
                {version.sources.map((source) => (
                  <div key={source.id} className="rounded bg-surface-secondary p-2">
                    <code className="block text-2xs break-all">{source.path}</code>
                    <span className="text-2xs text-foreground-muted">
                      来源：{source.sourceOrigin}{source.sourceTool ? ` · ${source.sourceTool}` : ''}
                    </span>
                    {source.sourceRootId !== null && (
                      <span className="block text-2xs text-foreground-muted">Source Root：{source.sourceRootId}</span>
                    )}
                    <span className="block text-2xs text-foreground-muted">发现时间：{source.discoveredAt}</span>
                    {source.repoUrl && (
                      <span className="block text-2xs text-foreground-muted break-all">
                        仓库：{source.repoUrl}{source.commitSha ? ` @ ${source.commitSha}` : ''}
                      </span>
                    )}
                  </div>
                ))}
              </div>
              <div>
                <p className="text-2xs font-medium text-foreground-secondary mb-1">SKILL.md</p>
                <pre className="max-h-32 overflow-auto rounded bg-surface-secondary p-2 text-2xs whitespace-pre-wrap">{version.skillMd || '（无 SKILL.md）'}</pre>
              </div>
              {editor.authoritativeSourceId !== null && !selectedVersion && action && (
                <div className="space-y-2 border-t border-border-subtle pt-2">
                  <label className="block text-2xs text-foreground-secondary">
                    处理方式
                    <select
                      aria-label={`版本 ${label} 的处理方式`}
                      value={action.action}
                      onChange={(event) => onEditorChange((prev) => ({
                        ...prev,
                        actions: { ...prev.actions, [version.hash]: { ...action, action: event.target.value as 'archive' | 'save-as' } }
                      }))}
                      className="mt-1 h-8 w-full rounded border border-border bg-surface px-2 text-xs"
                    >
                      <option value="archive">仅归档原版本</option>
                      <option value="save-as">另存为新 Skill</option>
                    </select>
                  </label>
                  {action.action === 'save-as' && (
                    <>
                      <Input
                        aria-label={`版本 ${label} 的新 Skill 名称`}
                        value={action.newSkillName}
                        onChange={(event) => onEditorChange((prev) => ({
                          ...prev,
                          actions: { ...prev.actions, [version.hash]: { ...action, newSkillName: event.target.value } }
                        }))}
                        placeholder="新名称也将成为目录名"
                        className="w-full"
                      />
                      <Input
                        aria-label={`版本 ${label} 的权威库内父目录`}
                        value={action.canonicalRelativeParent}
                        onChange={(event) => onEditorChange((prev) => ({
                          ...prev,
                          actions: { ...prev.actions, [version.hash]: { ...action, canonicalRelativeParent: event.target.value } }
                        }))}
                        placeholder="留空表示权威库根目录"
                        mono
                        className="w-full"
                      />
                    </>
                  )}
                </div>
              )}
            </section>
          )
        })}
        <section className="space-y-2">
          <h4 className="text-xs font-medium">文件差异</h4>
          {editor.preview.comparisons.map((comparison) => {
            const leftIndex = editor.preview.versions.findIndex((version) => version.hash === comparison.leftHash)
            const rightIndex = editor.preview.versions.findIndex((version) => version.hash === comparison.rightHash)
            const leftLabel = 'ABCDEFGH'[leftIndex] ?? String(leftIndex + 1)
            const rightLabel = 'ABCDEFGH'[rightIndex] ?? String(rightIndex + 1)
            return (
              <div key={`${comparison.leftHash}-${comparison.rightHash}`} className="rounded border border-border p-2 space-y-2">
                <p className="text-2xs font-medium">版本 {leftLabel} 与版本 {rightLabel}</p>
                <p className="text-2xs text-foreground-muted font-mono break-all">
                  {comparison.leftHash} ↔ {comparison.rightHash}
                </p>
                {comparison.files.map((file) => (
                  <div key={file.path} className="rounded border border-border-subtle p-2">
                    <div className="flex items-center gap-2 text-2xs">
                      <code>{file.path}</code>
                      <span className="text-foreground-muted">{conflictFileStatusLabel(file.status)}</span>
                    </div>
                    {file.textDiff && <pre className="mt-1 overflow-auto whitespace-pre-wrap text-2xs bg-surface-secondary p-2 rounded">{file.textDiff}</pre>}
                  </div>
                ))}
              </div>
            )
          })}
        </section>
      </div>
    </Dialog>
  )
}

export function UndoConsolidationDialog({
  undoBatch,
  busy,
  onConfirm,
  onClose
}: {
  undoBatch: UndoBatch
  busy: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Dialog
      open
      onClose={onClose}
      title={`撤销整理「${undoBatch.item.skillName}」`}
      description="将尝试恢复原候选来源并移除本次写入的权威来源；若恢复位置已被占用，操作会被拒绝。"
      busy={busy}
      confirmLabel="确认撤销"
      onConfirm={onConfirm}
      closeOnOverlay={false}
    />
  )
}

export function SourceRelocationDialog({
  skill,
  source,
  preview,
  busy,
  onPreview,
  onConfirm,
  onClose
}: {
  skill: SkillView
  source: SkillSourceView
  preview: SourceRelocationPreview | null
  busy: boolean
  onPreview: (canonicalRelativeParent: string) => void
  onConfirm: () => void
  onClose: () => void
}) {
  const [relocationRelativeParent, setRelocationRelativeParent] = useState('')
  return (
    <Dialog
      open
      onClose={onClose}
      title={preview ? `确认移动「${skill.name}」` : `移动权威 Source「${skill.name}」`}
      description="只改变权威库内的位置；Skill 名称和内容保持不变。"
      busy={busy}
      confirmLabel={preview ? '确认移动' : '预览移动'}
      onConfirm={preview ? onConfirm : () => onPreview(relocationRelativeParent)}
      closeOnOverlay={false}
    >
      {preview ? (
        <div className="space-y-3 text-xs">
          <div><p className="text-foreground-muted">旧位置</p><code className="break-all">{preview.oldCanonicalPath}</code></div>
          <div><p className="text-foreground-muted">新位置</p><code className="break-all">{preview.newCanonicalPath}</code></div>
          <div>
            <p className="font-medium">受影响部署（{preview.deployments.length}）</p>
            {preview.deployments.map((deployment) => (
              <div key={deployment.deploymentId} className="mt-1 rounded border border-border p-2">
                <span>{deployment.targetTool} · {deployment.mode}</span>
                <code className="block text-2xs break-all text-foreground-muted">{deployment.targetPath}</code>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <label htmlFor="relocation-relative-parent" className="block text-xs font-medium text-foreground-secondary">新的权威库内父目录</label>
          <Input id="relocation-relative-parent" aria-label="新的权威库内父目录" value={relocationRelativeParent}
            onChange={(event) => setRelocationRelativeParent(event.target.value)} placeholder="例如 team/backend" mono className="w-full" />
        </div>
      )}
    </Dialog>
  )
}

export function UndoRelocationDialog({
  relocation,
  busy,
  onConfirm,
  onClose
}: {
  relocation: SourceRelocation
  busy: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Dialog
      open
      onClose={onClose}
      title={`撤销 Source 移动「${relocation.skillName}」`}
      description="仅当旧位置空闲、权威内容未变化且没有新增外部订阅时才能撤销。"
      busy={busy}
      confirmLabel="确认撤销移动"
      onConfirm={onConfirm}
      closeOnOverlay={false}
    />
  )
}
