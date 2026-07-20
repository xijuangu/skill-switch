// issue #119: Draft Release 自动合同 — 版本一致性、资产校验、版本化说明与 Draft Release 配置的结构性验证。
// 只做结构性验证，不对文案做脆弱快照。
import { test, expect, describe } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url)) // tests/
const repoRoot = resolve(here, '..')

interface PackageJson {
  version: string
  name: string
  build?: {
    appId?: string
    productName?: string
  }
}

const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as PackageJson
const lockfile = JSON.parse(readFileSync(resolve(repoRoot, 'package-lock.json'), 'utf8')) as {
  version: string
  packages?: Record<string, { version?: string }>
}
const releaseNotesRelativePath = `docs/release-notes/v${pkg.version}.md`
const releaseNotesPath = resolve(repoRoot, releaseNotesRelativePath)
const ciPath = resolve(repoRoot, '.github/workflows/ci.yml')
const ciText = readFileSync(ciPath, 'utf8')

describe('issue #119: Draft Release 自动合同', () => {
  test('package.json 使用可发布的稳定语义版本', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/)
  })

  test('package-lock.json 顶层版本与 package.json 一致', () => {
    expect(lockfile.version).toBe(pkg.version)
  })

  test('package-lock.json 根包条目版本与 package.json 一致', () => {
    const root = lockfile.packages?.['']
    expect(root?.version, 'package-lock.json packages[""].version').toBe(pkg.version)
  })

  test('应用元数据 appId/productName 稳定（不依赖版本号，但需存在）', () => {
    expect(pkg.build?.appId, 'build.appId').toBeTruthy()
    expect(pkg.build?.productName, 'build.productName').toBeTruthy()
  })

  test('与 package.json version 对应的 Release Notes 存在且包含中文正文与英文摘要', () => {
    expect(existsSync(releaseNotesPath), `${releaseNotesRelativePath} should exist`).toBe(true)
    const text = readFileSync(releaseNotesPath, 'utf8')
    // 中文正文标记
    expect(text).toContain('中文发布说明')
    // 英文摘要标记
    expect(text).toContain('English Summary')
    // 必须说明支持平台
    expect(text).toContain('macOS')
    expect(text).toContain('Windows')
    expect(text).toContain('Linux')
    // 必须说明未签名/未公证状态
    expect(text).toContain('未签名')
    // 必须说明联网边界
    expect(text).toMatch(/联网|网络边界|HTTPS/)
    // 必须说明已知限制
    expect(text).toContain('已知限制')
    // 英文摘要至少 3 条（以 - 开头的列表项）
    const englishBullets = (text.match(/^- .+$/gm) || []).length
    expect(englishBullets, 'expected at least 3 English summary bullets').toBeGreaterThanOrEqual(3)
  })

  test('CI workflow 包含版本一致性校验步骤', () => {
    expect(ciText).toContain('Validate version consistency')
    expect(ciText).toContain('PKG_VERSION')
    expect(ciText).toContain('Version mismatch')
  })

  test('CI workflow 包含要求内资产校验步骤', () => {
    expect(ciText).toContain('Collect and validate required assets')
    expect(ciText).toContain('Missing required macOS DMG')
    expect(ciText).toContain('Missing required Windows x64 NSIS installer')
    expect(ciText).toContain('Missing required Linux x64 installer')
    expect(ciText).toContain('Required asset contract not satisfied')
  })

  test('CI workflow 创建 Draft Release 而非自动 publish', () => {
    expect(ciText).toContain('draft: true')
    expect(ciText).toContain('prerelease: false')
    expect(ciText).toContain('body_path: ${{ env.RELEASE_NOTES_PATH }}')
    expect(ciText).toContain('generate_release_notes: false')
  })

  test('CI workflow 从 package.json version 解析 Release Notes 路径', () => {
    expect(ciText).toContain('RELEASE_NOTES_PATH="docs/release-notes/v${PKG_VERSION}.md"')
    expect(ciText).toContain('body_path: ${{ env.RELEASE_NOTES_PATH }}')
  })

  test('Draft Release 同时依赖三平台 verify 与 package', () => {
    expect(ciText).toMatch(/release:[\s\S]*?needs:\s*\[verify,\s*package\]/)
  })

  test('要求内资产校验版本、架构与非空文件', () => {
    expect(ciText).toContain('Asset version mismatch')
    expect(ciText).toContain('Missing required Windows x64 NSIS installer')
    expect(ciText).toContain('Missing required Linux x64 installer')
    expect(ciText).toContain('-x86_64.AppImage')
    expect(ciText).toContain('-amd64.deb')
    expect(ciText).toContain('find release-assets -type f -size 0')
  })

  test('CI workflow verify job 在三平台原生 runner 上运行', () => {
    expect(ciText).toContain('ubuntu-latest')
    expect(ciText).toContain('macos-latest')
    expect(ciText).toContain('windows-latest')
  })

  test('CI workflow package job 为三平台分别配置 mac/win/linux 打包', () => {
    expect(ciText).toContain('package:mac')
    expect(ciText).toContain('package:win')
    expect(ciText).toContain('package:linux')
  })
})
