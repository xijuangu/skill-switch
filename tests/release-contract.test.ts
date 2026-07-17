// issue #119: v1.0.0 Draft Release 自动合同 — 版本一致性、资产校验、Draft Release 配置的结构性验证。
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

describe('issue #119: v1.0.0 Draft Release 自动合同', () => {
  test('package.json 版本为 1.0.0', () => {
    expect(pkg.version).toBe('1.0.0')
  })

  test('package-lock.json 顶层版本与 package.json 一致', () => {
    expect(lockfile.version).toBe('1.0.0')
  })

  test('package-lock.json 根包条目版本与 package.json 一致', () => {
    const root = lockfile.packages?.['']
    expect(root?.version, 'package-lock.json packages[""].version').toBe('1.0.0')
  })

  test('应用元数据 appId/productName 稳定（不依赖版本号，但需存在）', () => {
    expect(pkg.build?.appId, 'build.appId').toBeTruthy()
    expect(pkg.build?.productName, 'build.productName').toBeTruthy()
  })

  test('不创建公开 v1.0.0-rc.1 预发布标识', () => {
    // #114: 拟发布源码版本直接设为 1.0.0；不创建公开 v1.0.0-rc.1
    expect(pkg.version).not.toMatch(/-rc\./)
  })

  test('Release Notes 文件存在且包含中文正文与英文摘要', () => {
    const notesPath = resolve(repoRoot, 'docs/release-notes/v1.0.0.md')
    expect(existsSync(notesPath), 'docs/release-notes/v1.0.0.md should exist').toBe(true)
    const text = readFileSync(notesPath, 'utf8')
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
    const ciPath = resolve(repoRoot, '.github/workflows/ci.yml')
    const text = readFileSync(ciPath, 'utf8')
    expect(text).toContain('Validate version consistency')
    expect(text).toContain('PKG_VERSION')
    expect(text).toContain('Version mismatch')
  })

  test('CI workflow 包含要求内资产校验步骤', () => {
    const ciPath = resolve(repoRoot, '.github/workflows/ci.yml')
    const text = readFileSync(ciPath, 'utf8')
    expect(text).toContain('Collect and validate required assets')
    expect(text).toContain('Missing required macOS DMG')
    expect(text).toContain('Missing required Windows x64 NSIS installer')
    expect(text).toContain('Missing required Linux x64 installer')
    expect(text).toContain('Required asset contract not satisfied')
  })

  test('CI workflow 创建 Draft Release 而非自动 publish', () => {
    const ciPath = resolve(repoRoot, '.github/workflows/ci.yml')
    const text = readFileSync(ciPath, 'utf8')
    expect(text).toContain('draft: true')
    expect(text).toContain('prerelease: false')
    expect(text).toContain('body_path: docs/release-notes/v1.0.0.md')
    expect(text).toContain('generate_release_notes: false')
  })

  test('CI workflow verify job 在三平台原生 runner 上运行', () => {
    const ciPath = resolve(repoRoot, '.github/workflows/ci.yml')
    const text = readFileSync(ciPath, 'utf8')
    expect(text).toContain('ubuntu-latest')
    expect(text).toContain('macos-latest')
    expect(text).toContain('windows-latest')
  })

  test('CI workflow package job 为三平台分别配置 mac/win/linux 打包', () => {
    const ciPath = resolve(repoRoot, '.github/workflows/ci.yml')
    const text = readFileSync(ciPath, 'utf8')
    expect(text).toContain('package:mac')
    expect(text).toContain('package:win')
    expect(text).toContain('package:linux')
  })
})
