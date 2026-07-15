type StatusVariant = 'success' | 'warning' | 'danger' | 'neutral'

interface DriftStatusMeta {
  variant: StatusVariant
  label: string
}

// 唯一的 drift 状态映射表,供 Skills / Tools 页共同消费。
// 之前 SkillsPage 的 DRIFT_LABEL 与 ToolsPage 的 DRIFT_STATUS 是两套并行表,见 #58。
// key 用 string 而非 DriftKindView,避免 shared 层反向依赖 preload 类型(保持进程隔离)。
export const DRIFT_STATUS_MAP: Record<string, DriftStatusMeta> = {
  normal: { variant: 'success', label: '正常' },
  'source-updated': { variant: 'warning', label: '源已更新' },
  'target-modified': { variant: 'warning', label: '目标已修改' },
  'link-mismatch': { variant: 'danger', label: '链接异常' },
  'source-missing': { variant: 'danger', label: '源缺失' },
  unresolved: { variant: 'danger', label: '待确认' },
  drift: { variant: 'danger', label: '漂移' },
  external: { variant: 'neutral', label: '外部' },
  'recovery-required': { variant: 'danger', label: '需要人工恢复' },
}

const FALLBACK_VARIANT: StatusVariant = 'neutral'

// 未知 kind 兜底:label 回退为原始 kind 字符串,避免前后端类型不同步时白屏。
export function getDriftStatus(kind: string): DriftStatusMeta {
  const meta = DRIFT_STATUS_MAP[kind]
  return meta ?? { variant: FALLBACK_VARIANT, label: kind }
}
