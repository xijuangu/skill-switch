const LATEST_RELEASE_API =
  'https://api.github.com/repos/xijuangu/skill-switch/releases/latest'

interface LatestReleaseResponse {
  tag_name?: unknown
  html_url?: unknown
}

export type UpdateCheckResult =
  | {
      status: 'update-available'
      currentVersion: string
      latestVersion: string
      releaseUrl: string
    }
  | {
      status: 'up-to-date'
      currentVersion: string
      latestVersion: string
    }
  | {
      status: 'unavailable'
      currentVersion: string
      message: string
    }

type ReleaseRequest = (url: string, init: RequestInit) => Promise<{
  ok: boolean
  status?: number
  json: () => Promise<unknown>
}>

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '')
}

function compareVersions(left: string, right: string): number {
  const leftParts = normalizeVersion(left).split('.').map((part) => Number.parseInt(part, 10))
  const rightParts = normalizeVersion(right).split('.').map((part) => Number.parseInt(part, 10))
  if (
    leftParts.length < 1 ||
    rightParts.length < 1 ||
    [...leftParts, ...rightParts].some(Number.isNaN)
  ) {
    throw new Error('GitHub 返回了无法识别的版本号。')
  }
  const width = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < width; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

export async function checkForUpdate(
  currentVersion: string,
  request: ReleaseRequest = fetch
): Promise<UpdateCheckResult> {
  try {
    const response = await request(LATEST_RELEASE_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `skill-switch/${currentVersion}`
      }
    })
    if (!response.ok) {
      throw new Error(`GitHub 请求失败（${response.status ?? '未知状态'}）`)
    }
    const payload = (await response.json()) as LatestReleaseResponse
    if (typeof payload.tag_name !== 'string') {
      throw new Error('GitHub Release 缺少版本号。')
    }
    const latestVersion = normalizeVersion(payload.tag_name)
    if (compareVersions(latestVersion, currentVersion) <= 0) {
      return { status: 'up-to-date', currentVersion, latestVersion }
    }
    if (
      typeof payload.html_url !== 'string' ||
      !payload.html_url.startsWith('https://github.com/xijuangu/skill-switch/releases/')
    ) {
      throw new Error('GitHub Release 地址无效。')
    }
    return {
      status: 'update-available',
      currentVersion,
      latestVersion,
      releaseUrl: payload.html_url
    }
  } catch (error) {
    return {
      status: 'unavailable',
      currentVersion,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}
