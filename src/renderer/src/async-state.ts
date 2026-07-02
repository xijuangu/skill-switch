export async function completeMutation<T>(
  result: T,
  onDone: (result: T) => Promise<void>
): Promise<void> {
  await onDone(result)
}

export interface LatestRequestGate {
  start(): number
  isLatest(generation: number): boolean
}

export function createLatestRequestGate(): LatestRequestGate {
  let current = 0
  return {
    start: () => ++current,
    isLatest: (generation) => generation === current
  }
}
