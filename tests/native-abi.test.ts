// issue #64: 稳定 macOS verify 的 native ABI 准备流程
//
// better-sqlite3 是原生依赖，Node/Vitest 与 Electron 使用不同 ABI。本测试只做
// 结构性合约验证（package.json 脚本编排），确保：
//   1. Node 测试前明确准备 Node ABI（test 依赖 native:node）
//   2. Electron 构建/打包前明确准备 Electron ABI（build:electron、package:* 依赖 native:electron）
//   3. install 阶段不再为 Electron 重建原生模块，避免污染 Node 测试所需 ABI
//   4. native:node 清除残留二进制后强制重建，使任何 stale Electron-ABI 产物都不会存活到测试
//
// 这是 issue #64 exit 139 回归的最低成本防护：脚本结构一旦被改回互相污染的形态，本测试立即失败。
// 不锁定具体命令文本，只锁定可观察的编排合约（依赖关系与关键标志）。
import { test, expect, describe } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url)) // tests/
const repoRoot = resolve(here, '..')

interface PackageScripts {
  [name: string]: string | undefined
}
interface PackageJson {
  scripts?: PackageScripts
  engines?: { node?: string }
}
const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as PackageJson
const scripts = pkg.scripts ?? {}
const workflow = readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8')

describe('issue #64: native ABI 准备流程互不污染', () => {
  test('开发与 CI 使用 Electron 41 支持且有 better-sqlite3 预编译包的 Node 22', () => {
    expect(pkg.engines?.node).toBe('>=22.12.0')
    expect(workflow.match(/node-version:\s*22/g)).toHaveLength(2)
    expect(workflow).not.toMatch(/node-version:\s*20/)
  })

  test('native:node 为当前 Node 运行时强制重建 better-sqlite3', () => {
    const node = scripts['native:node']
    expect(node, 'scripts.native:node must exist').toBeTruthy()
    // 重建必须针对 better-sqlite3，并以 Node 运行时为目标
    expect(node!).toContain('better-sqlite3')
    expect(node!).toMatch(/\brebuild\b/)
    // 清除残留二进制，确保 stale Electron-ABI 产物不会存活到 Node 测试
    // （exit 139 的直接诱因是加载了错误 ABI 的 .node）
    expect(node!).toContain('rmSync')
    expect(node!).toContain('node_modules/better-sqlite3/build')
  })

  test('native:electron 强制为 Electron 重建 better-sqlite3', () => {
    const electron = scripts['native:electron']
    expect(electron, 'scripts.native:electron must exist').toBeTruthy()
    expect(electron!).toContain('electron-rebuild')
    expect(electron!).toContain('-f')
    expect(electron!).toContain('better-sqlite3')
  })

  test('test 与 test:watch 在 vitest 前明确准备 Node ABI', () => {
    for (const name of ['test', 'test:watch']) {
      const s = scripts[name]
      expect(s, `scripts.${name} must exist`).toBeTruthy()
      expect(s!).toContain('native:node')
      expect(s!).toContain('vitest')
      // Node 测试脚本不得直接为 Electron 重建原生模块
      expect(s!).not.toMatch(/native:electron|electron-rebuild|install-app-deps/)
    }
  })

  test('dev、start、build:electron 在 Electron 阶段前明确准备 Electron ABI', () => {
    for (const name of ['dev', 'start', 'build:electron']) {
      const s = scripts[name]
      expect(s, `scripts.${name} must exist`).toBeTruthy()
      expect(s!).toContain('native:electron')
    }
  })

  test('package 与平台 package:* 通过 build:electron 准备 Electron ABI', () => {
    for (const name of ['package', 'package:mac', 'package:win', 'package:linux']) {
      const s = scripts[name]
      expect(s, `scripts.${name} must exist`).toBeTruthy()
      expect(s!).toContain('build:electron')
    }
  })

  test('install 阶段不为 Electron 重建原生模块（避免污染 Node 测试 ABI）', () => {
    const postinstall = scripts['postinstall']
    // postinstall 允许缺省；若存在则不得触发 Electron 原生重建
    if (postinstall !== undefined) {
      expect(postinstall).not.toMatch(/install-app-deps|electron-rebuild|native:electron/)
    }
    // verify 不应直接为 Electron 重建——它只跑 typecheck + Node 测试 + vite 构建，
    // 不加载原生模块，因此不需要 Electron ABI
    const verify = scripts['verify']
    expect(verify, 'scripts.verify must exist').toBeTruthy()
    expect(verify!).toContain('typecheck')
    expect(verify!).toContain('test')
    expect(verify!).toContain('build')
    expect(verify!).not.toMatch(/native:electron|electron-rebuild|install-app-deps/)
  })
})
