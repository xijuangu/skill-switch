// issue #117:主进程外链与窗口安全策略。
//
// 这是主进程唯一的"哪些外链可以交给系统浏览器"决策点。渲染进程永远拿不到
// shell.openExternal;任何 window.open / target=_blank 产生的 url 都经过
// classifyExternalUrl,只有 HTTPS + 受信主机才转发给系统浏览器,其余
// (非 https、file:/javascript:/data:/自定义协议、解析失败、不可信主机)被安全拒绝。
//
// 本模块不 import 'electron',因此可在 Node 测试中直接验证允许/拒绝行为。

/**
 * 明确允许的外链 HTTPS 主机。skill-switch 唯一主动联网场景是从 GitHub 安装 Skill,
 * 因此受信主机仅限 GitHub 自有域。任何其它主机(即便走 HTTPS)都视为不可信并被拒绝。
 */
export const ALLOWED_EXTERNAL_HOSTS: ReadonlySet<string> = new Set<string>([
  'github.com',
  'www.github.com',
  'raw.githubusercontent.com'
])

export type ExternalLinkDecision =
  | { allowed: true }
  | { allowed: false; reason: 'parse-failed' | 'non-https' | 'untrusted-host' }

/**
 * 判定一个 url 是否可以交给系统浏览器打开。
 * - 解析失败 → parse-failed
 * - 非 https(含 http、file、javascript、data、自定义协议) → non-https
 * - HTTPS 但主机不在受信集合 → untrusted-host
 * - HTTPS 且受信主机 → allowed
 */
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
  // 仅允许 https:。这同时拒绝 http:、file:、javascript:、data:、mailto:、ftp: 与自定义协议。
  if (parsed.protocol !== 'https:') {
    return { allowed: false, reason: 'non-https' }
  }
  // URL.hostname 已小写,因此集合中的小写条目可正确匹配大小写混写的输入。
  if (!ALLOWED_EXTERNAL_HOSTS.has(parsed.hostname)) {
    return { allowed: false, reason: 'untrusted-host' }
  }
  return { allowed: true }
}

/**
 * 生产窗口 webPreferences:sandbox 启用、contextIsolation 启用、
 * Node 集成关闭、webSecurity 启用。导出为常量,便于测试断言窗口使用该策略,
 * 并防止后续改动无意回退其中任意一项。
 */
export const SECURE_WEB_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  webSecurity: true
} as const

/**
 * 构造生产窗口的 webPreferences:在 SECURE_WEB_PREFERENCES 基础上附加 preload 路径。
 * preload 是窄化接口(仅 contextBridge 暴露的 ipcRenderer.invoke),不暴露 fs/path/db。
 */
export function createSecureWebPreferences(preloadPath: string): {
  preload: string
  sandbox: true
  contextIsolation: true
  nodeIntegration: false
  webSecurity: true
} {
  return { preload: preloadPath, ...SECURE_WEB_PREFERENCES }
}

/**
 * 处理 renderer 发起新窗口请求(window.open / target=_blank)的可观察决策。
 * 始终拒绝新建 Electron 窗口;仅当 url 通过外链策略时,返回需交给系统浏览器的 url。
 * 调用方(主进程)据 openExternal 字段决定是否调用 shell.openExternal。
 */
export function handleWindowOpenRequest(
  raw: string
): { action: 'deny'; openExternal: string | null } {
  const decision = classifyExternalUrl(raw)
  return {
    action: 'deny',
    openExternal: decision.allowed ? raw : null
  }
}
