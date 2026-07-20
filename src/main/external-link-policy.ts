/**
 * The product's only documented external destination is GitHub, so links use
 * a narrow allowlist rather than granting arbitrary HTTPS access.
 */
export const ALLOWED_EXTERNAL_HOSTS: ReadonlySet<string> = new Set<string>([
  'github.com',
  'www.github.com',
  'raw.githubusercontent.com'
])

export type ExternalLinkDecision =
  | { allowed: true }
  | { allowed: false; reason: 'parse-failed' | 'non-https' | 'untrusted-host' }

export function classifyExternalUrl(raw: string): ExternalLinkDecision {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { allowed: false, reason: 'parse-failed' }
  }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { allowed: false, reason: 'parse-failed' }
  }
  if (parsed.protocol !== 'https:') {
    return { allowed: false, reason: 'non-https' }
  }
  if (!ALLOWED_EXTERNAL_HOSTS.has(parsed.hostname)) {
    return { allowed: false, reason: 'untrusted-host' }
  }
  return { allowed: true }
}

// Kept as one exported policy so production wiring and security tests cannot drift.
export const SECURE_WEB_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  webSecurity: true
} as const

export function createSecureWebPreferences(preloadPath: string): {
  preload: string
  sandbox: true
  contextIsolation: true
  nodeIntegration: false
  webSecurity: true
} {
  return { preload: preloadPath, ...SECURE_WEB_PREFERENCES }
}

export function handleWindowOpenRequest(
  raw: string
): { action: 'deny'; openExternal: string | null } {
  const decision = classifyExternalUrl(raw)
  return {
    action: 'deny',
    openExternal: decision.allowed ? raw : null
  }
}
