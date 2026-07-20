// issue #117:主进程外链与窗口安全策略的可观察行为测试。
// 只验证通过公共边界可观察的允许/拒绝决策与生产窗口 webPreferences,
// 不启动 Electron,不锁定内部实现细节。
import { describe, expect, test } from 'vitest'
import {
  ALLOWED_EXTERNAL_HOSTS,
  SECURE_WEB_PREFERENCES,
  classifyExternalUrl,
  createSecureWebPreferences,
  handleWindowOpenRequest
} from '../src/main/external-link-policy'

describe('external link policy — classifyExternalUrl', () => {
  test('allows explicitly trusted HTTPS GitHub hosts', () => {
    const allowed = [
      'https://github.com/xijuangu/skill-switch',
      'https://github.com/owner/repo/tree/main/skills/grilling',
      'https://www.github.com/owner/repo',
      'https://raw.githubusercontent.com/owner/repo/main/SKILL.md'
    ]
    for (const url of allowed) {
      expect(classifyExternalUrl(url), `expected allowed: ${url}`).toEqual({ allowed: true })
    }
  })

  test('hostname matching is case-insensitive (URL.hostname lowercases)', () => {
    expect(classifyExternalUrl('HTTPS://GitHub.COM/owner/repo')).toEqual({ allowed: true })
  })

  test('rejects non-https protocols: http, file, javascript, data, custom', () => {
    const nonHttps = [
      'http://github.com/owner/repo',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'customproto://github.com/x',
      'mailto:nobody@example.com',
      'ftp://github.com/owner/repo'
    ]
    for (const url of nonHttps) {
      const decision = classifyExternalUrl(url)
      expect(decision.allowed, `expected denied: ${url}`).toBe(false)
      expect(decision, `expected non-https reason for: ${url}`).toMatchObject({
        allowed: false,
        reason: 'non-https'
      })
    }
  })

  test('rejects unparseable / empty targets as parse-failed', () => {
    const parseFailed = ['', '   ', 'not a url', 'https://', '://no-host', 'github.com/owner/repo']
    for (const url of parseFailed) {
      const decision = classifyExternalUrl(url)
      expect(decision.allowed, `expected denied: ${url}`).toBe(false)
      expect(decision, `expected parse-failed reason for: ${url}`).toMatchObject({
        allowed: false,
        reason: 'parse-failed'
      })
    }
  })

  test('rejects untrusted HTTPS hosts (lookalikes and unrelated domains)', () => {
    const untrusted = [
      'https://evil.com/path',
      'https://github.com.evil.com/owner/repo',
      'https://githubcom.com/owner/repo',
      'https://github.com.evil.com',
      'https://raw-githubusercontent.com/x',
      'https://example.com'
    ]
    for (const url of untrusted) {
      const decision = classifyExternalUrl(url)
      expect(decision.allowed, `expected denied: ${url}`).toBe(false)
      expect(decision, `expected untrusted-host reason for: ${url}`).toMatchObject({
        allowed: false,
        reason: 'untrusted-host'
      })
    }
  })

  test('allowlist only contains GitHub-owned hosts', () => {
    // 防御性断言:受信主机集合不应意外包含非 GitHub 域。
    const hosts = [...ALLOWED_EXTERNAL_HOSTS]
    expect(hosts.length).toBeGreaterThan(0)
    for (const host of hosts) {
      expect(host, `unexpected non-github host: ${host}`).toMatch(/(^|\.)githubusercontent\.com$|(^|\.)github\.com$/)
    }
  })
})

describe('external link policy — handleWindowOpenRequest', () => {
  test('always denies a new Electron window, even for allowed links', () => {
    const result = handleWindowOpenRequest('https://github.com/xijuangu/skill-switch')
    expect(result.action).toBe('deny')
  })

  test('returns the url to open externally only when the policy allows it', () => {
    expect(handleWindowOpenRequest('https://github.com/xijuangu/skill-switch').openExternal).toBe(
      'https://github.com/xijuangu/skill-switch'
    )
    expect(
      handleWindowOpenRequest('https://raw.githubusercontent.com/owner/repo/main/SKILL.md').openExternal
    ).toBe('https://raw.githubusercontent.com/owner/repo/main/SKILL.md')
  })

  test('returns null openExternal for denied targets (no system-browser handoff)', () => {
    const denied = [
      'http://github.com/x',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'https://evil.com/x',
      'not a url',
      ''
    ]
    for (const url of denied) {
      expect(handleWindowOpenRequest(url).openExternal, `expected null for: ${url}`).toBeNull()
      expect(handleWindowOpenRequest(url).action, `expected deny for: ${url}`).toBe('deny')
    }
  })
})

describe('external link policy — secure web preferences', () => {
  test('SECURE_WEB_PREFERENCES enables renderer sandbox', () => {
    expect(SECURE_WEB_PREFERENCES.sandbox).toBe(true)
  })

  test('SECURE_WEB_PREFERENCES keeps context isolation on and Node integration off', () => {
    expect(SECURE_WEB_PREFERENCES.contextIsolation).toBe(true)
    expect(SECURE_WEB_PREFERENCES.nodeIntegration).toBe(false)
  })

  test('SECURE_WEB_PREFERENCES keeps web security on', () => {
    expect(SECURE_WEB_PREFERENCES.webSecurity).toBe(true)
  })

  test('createSecureWebPreferences attaches the preload path without relaxing the policy', () => {
    const prefs = createSecureWebPreferences('/path/to/preload.js')
    expect(prefs.preload).toBe('/path/to/preload.js')
    expect(prefs.sandbox).toBe(true)
    expect(prefs.contextIsolation).toBe(true)
    expect(prefs.nodeIntegration).toBe(false)
    expect(prefs.webSecurity).toBe(true)
  })
})
