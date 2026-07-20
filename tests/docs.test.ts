// issue #118: 最小开源仓库信任面 — 必需文件与内部链接通过最小自动检查。
// 只做结构性验证（必需文件存在、相对链接可解析、许可证文本在场），不对营销文案做脆弱快照。
import { test, expect, describe } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url)) // tests/
const repoRoot = resolve(here, '..')
const packageVersion = (
  JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as { version: string }
).version

const requiredFiles = [
  'README.md',
  'LICENSE',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'RELEASING.md',
  'CONTEXT.md',
  'docs/user-guide.md',
  'docs/development.md',
  'docs/manual-qa.md',
  'docs/THIRD_PARTY_LICENSES.md',
  'src/renderer/src/assets/fonts/Inter-Variable.woff2',
  'src/renderer/src/assets/fonts/OFL.txt'
]

const docsToScan = [
  'README.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'RELEASING.md',
  'docs/user-guide.md',
  'docs/development.md',
  'docs/THIRD_PARTY_LICENSES.md'
]

describe('issue #118: 最小开源仓库信任面', () => {
  test('所有必需公开文件存在', () => {
    const missing = requiredFiles.filter((rel) => !existsSync(resolve(repoRoot, rel)))
    expect(missing, `missing files: ${missing.join(', ')}`).toEqual([])
  })

  test('LICENSE 为 MIT', () => {
    const text = readFileSync(resolve(repoRoot, 'LICENSE'), 'utf8')
    expect(text).toContain('MIT License')
    expect(text).toContain('xijuangu')
  })

  test('Inter 字体附带 SIL Open Font License 文本', () => {
    const ofl = readFileSync(resolve(repoRoot, 'src/renderer/src/assets/fonts/OFL.txt'), 'utf8')
    expect(ofl).toContain('SIL OPEN FONT LICENSE')
    expect(ofl).toContain('Version 1.1')
  })

  test('第三方许可证通知覆盖运行时依赖与 Inter', () => {
    const text = readFileSync(resolve(repoRoot, 'docs/THIRD_PARTY_LICENSES.md'), 'utf8')
    for (const name of ['better-sqlite3', 'adm-zip', 'gray-matter', 'react', 'lucide-react', 'Inter', 'Open Font License']) {
      expect(text, `expected ${name} in third-party notice`).toContain(name)
    }
  })

  test('README 首屏包含定位、支持工具、下载与本地承诺', () => {
    const text = readFileSync(resolve(repoRoot, 'README.md'), 'utf8')
    expect(text).toContain('在一个地方安装、整理并部署你的 AI 编程 Skills。')
    expect(text).toContain('Manage one canonical Skill library')
    for (const tool of ['TRAE', 'Codex', 'Claude Code', 'Agents', 'Gemini CLI']) {
      expect(text).toContain(tool)
    }
    // 未签名 / Gatekeeper / SmartScreen 必须在 README 中说明
    expect(text).toContain('未签名')
    expect(text).toContain('Gatekeeper')
    expect(text).toContain('SmartScreen')
    expect(text).toContain('在「工具」中启用 / 禁用或自定义路径')
    expect(text).not.toContain('在「设置」中启用 / 禁用或自定义路径')
  })

  test('用户指南使用 v1 信息架构与正确的未签名说明', () => {
    const guide = readFileSync(resolve(repoRoot, 'docs/user-guide.md'), 'utf8')
    const notes = readFileSync(
      resolve(repoRoot, `docs/release-notes/v${packageVersion}.md`),
      'utf8'
    )
    expect(guide).toContain('在“工具”中启用需要管理的工具')
    expect(guide).toContain('“恢复”页的“来源归档”')
    expect(guide).toContain('“恢复”页的“备份”')
    expect(guide).not.toContain('在“设置”中启用需要管理的工具')
    expect(notes).toContain('unsigned and unnotarized')
    expect(notes).not.toContain('unsigned and notarized')
    expect(notes).not.toContain('Intel Mac 可运行')
  })

  test('内部架构与历史 issue 清单已移出 README', () => {
    const text = readFileSync(resolve(repoRoot, 'README.md'), 'utf8')
    // 这些标题属于开发文档，不应出现在用户主路径
    expect(text).not.toContain('## Core Flow')
    expect(text).not.toContain('## Design Principles')
    // 历史(issue #1/#29 等)的完整索引应在 development.md，不在 README
    expect(text).not.toMatch(/issues\/1\)/)
    // 但应指向开发文档
    expect(text).toContain('docs/development.md')
  })

  test('中文用户指南覆盖安装、整理、接管、部署、取消部署、批量操作与恢复', () => {
    const text = readFileSync(resolve(repoRoot, 'docs/user-guide.md'), 'utf8')
    for (const section of ['安装 Skill', '整理', '部署模式', '批量操作', '外部订阅、接管与旧目标', '检查更新', '取消部署与从注册表移除', '漂移与恢复']) {
      expect(text, `expected section header: ${section}`).toContain(section)
    }
  })

  test('维护者文档持久化最小发版清单并从贡献指南链接', () => {
    const releasing = readFileSync(resolve(repoRoot, 'RELEASING.md'), 'utf8')
    const contributing = readFileSync(resolve(repoRoot, 'CONTRIBUTING.md'), 'utf8')
    expect(releasing).toContain('npm version <version> --no-git-tag-version')
    expect(releasing).toContain('docs/release-notes/v<version>.md')
    expect(releasing).toContain('git tag v<version>')
    expect(releasing).toContain('Draft Release')
    expect(releasing).toContain('不得直接公开发布')
    expect(contributing).toContain('[RELEASING.md](RELEASING.md)')
  })

  test('文档中的相对链接可解析到已存在文件', () => {
    const failures: string[] = []
    for (const rel of docsToScan) {
      const abs = resolve(repoRoot, rel)
      if (!existsSync(abs)) {
        failures.push(`${rel}: file itself missing`)
        continue
      }
      const content = readFileSync(abs, 'utf8')
      const baseDir = dirname(abs)
      const links = extractRelativeLinks(content)
      for (const url of links) {
        const target = resolve(baseDir, decodeURIComponent(url))
        if (!existsSync(target)) {
          failures.push(`${rel}: broken link -> ${url}`)
        }
      }
    }
    expect(failures, `broken links:\n  ${failures.join('\n  ')}`).toEqual([])
  })
})

/** 从 markdown 中提取需要解析的相对文件链接：跳过 http/mailto/anchor 与代码块。 */
function extractRelativeLinks(content: string): string[] {
  const out: string[] = []
  const linkRe = /\[([^\]]*)\]\(([^)]+)\)/g
  let inFence = false
  for (const line of content.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    for (const m of line.matchAll(linkRe)) {
      let url = m[2].trim()
      if (url.includes(' ')) url = url.split(/\s+/)[0] // 去掉 "title" 后缀
      if (!url) continue
      if (/^(https?:|mailto:|tel:|data:)/i.test(url)) continue
      if (url.startsWith('#')) continue
      // 去掉片段
      const pathPart = url.split('#')[0]
      if (!pathPart) continue
      out.push(pathPart)
    }
  }
  return out
}
