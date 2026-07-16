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
  onDone
}: {
  skill: SkillView
  sourceId: number
  onDone: (result: DeployResultView | null) => Promise<void>
}) {
  const source = skill.sources.find((candidate) => candidate.id === sourceId)
  const [targetOptions, setTargetOptions] = useState<DeployTargetOptionView[]>([])
  const [selectedTargetId, setSelectedTargetId] = useState('')
  const [mode, setMode] = useState<DeployMode>('copy')
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
  onDone
}: {
  initialTab: 'github' | 'zip' | 'local-dir'
  onDone: (result: InstallResultView | null) => Promise<void>
}) {
  const [tab, setTab] = useState<'github' | 'zip' | 'local-dir'>(initialTab)
  const [githubUrl, setGithubUrl] = useState('')
  const [zipPath, setZipPath] = useState<string | null>(null)
  const [localPath, setLocalPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
      await completeMutation(result, onDone)
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
      title="安装 Skill"
      confirmLabel={tab === 'local-dir' ? '添加' : '安装'}
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
            <label className="block text-xs text-foreground-secondary mb-1">本地目录（索引模式，不搬文件）</label>
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={handleSelectDir} disabled={busy} size="sm">
                选择目录…
              </Button>
              {localPath && <code className="text-xs font-mono text-foreground-secondary truncate">{localPath}</code>}
            </div>
            <p className="text-2xs text-foreground-muted mt-1">
              将目录登记为索引 source，文件保留在原位。
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
