import { describe, expect, test, vi } from 'vitest'
import { checkForUpdate } from '../src/main/services/update-checker'

describe('checkForUpdate', () => {
  test('reports a newer stable GitHub release', async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: 'v1.2.0',
        html_url: 'https://github.com/xijuangu/skill-switch/releases/tag/v1.2.0'
      })
    })

    await expect(checkForUpdate('1.0.0', request)).resolves.toEqual({
      status: 'update-available',
      currentVersion: '1.0.0',
      latestVersion: '1.2.0',
      releaseUrl: 'https://github.com/xijuangu/skill-switch/releases/tag/v1.2.0'
    })
  })

  test('does not treat the current or an older release as an update', async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: 'v1.0.0',
        html_url: 'https://github.com/xijuangu/skill-switch/releases/tag/v1.0.0'
      })
    })

    await expect(checkForUpdate('1.0.0', request)).resolves.toMatchObject({
      status: 'up-to-date',
      currentVersion: '1.0.0',
      latestVersion: '1.0.0'
    })
  })
})
