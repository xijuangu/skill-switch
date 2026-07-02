// Tools 页 drift 操作的标识键。
// 之前用 `${skillId}:${targetTool}` 字符串拼接,缺乏类型安全,见 #58。
export interface DriftKey {
  skillId: number
  targetTool: string
}

export function driftKeyEquals(a: DriftKey | null, b: DriftKey | null): boolean {
  if (a === null || b === null) return a === b
  return a.skillId === b.skillId && a.targetTool === b.targetTool
}
