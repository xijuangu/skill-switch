import { describe, expect, test } from 'vitest'
import {
  completeMutation,
  createLatestRequestGate
} from '../src/renderer/src/async-state'

describe('renderer async state coordination', () => {
  test('completeMutation waits for the completion callback', async () => {
    let completed = false
    const pending = completeMutation('result', async () => {
      await Promise.resolve()
      completed = true
    })

    expect(completed).toBe(false)
    await pending
    expect(completed).toBe(true)
  })

  test('only the newest refresh generation may apply state', () => {
    const gate = createLatestRequestGate()
    const older = gate.start()
    const newer = gate.start()

    expect(gate.isLatest(older)).toBe(false)
    expect(gate.isLatest(newer)).toBe(true)
  })
})
