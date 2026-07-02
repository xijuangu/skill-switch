import { describe, expect, test } from 'vitest'
import { mkdirSync, rmSync, symlinkSync } from 'fs'
import { join } from 'path'
import { createTempDir } from './helpers/temp'
import {
  assessSafeDeployTarget,
  assertAbsolutePath,
  assertSafeDeployTarget,
  isPathWithin,
  resolveWithin,
  validateBackupId,
  validateSkillName,
  validateToolKey
} from '../src/main/services/path-safety'

describe('path safety', () => {
  test('accepts normal skill names and rejects path/control segments', () => {
    expect(validateSkillName('grilling')).toBe('grilling')
    expect(validateSkillName('中文 skill')).toBe('中文 skill')

    for (const value of ['', ' ', '.', '..', '../escape', 'a/b', 'a\\b', 'bad\u0000name']) {
      expect(() => validateSkillName(value)).toThrow()
    }
  })

  test('resolves a child path only when it remains under the root', () => {
    expect(resolveWithin('/tmp/root', 'child')).toBe('/tmp/root/child')
    expect(() => resolveWithin('/tmp/root', '..', 'escape')).toThrow()
    expect(() => resolveWithin('/tmp/root', '/tmp/other')).toThrow()
  })

  test('checks directory containment for POSIX and Windows paths', () => {
    expect(isPathWithin('/tmp/root', '/tmp/root/skill')).toBe(true)
    expect(isPathWithin('/tmp/root', '/tmp/root-other/skill')).toBe(false)
    expect(isPathWithin('C:\\Users\\me\\.codex\\skills', 'C:\\Users\\me\\.codex\\skills\\demo')).toBe(true)
    expect(isPathWithin('C:\\Users\\me\\.codex\\skills', 'C:\\Users\\me\\.agents\\skills\\demo')).toBe(false)
    expect(
      isPathWithin(
        '\\\\server\\share\\skills',
        '\\\\server\\share\\skills\\demo'
      )
    ).toBe(true)
  })

  test('validates tool keys, backup ids, and absolute paths', () => {
    expect(validateToolKey('claude-code')).toBe('claude-code')
    expect(validateBackupId('demo_codex_20260701-120000-000')).toBe(
      'demo_codex_20260701-120000-000'
    )
    expect(assertAbsolutePath('/tmp/skill', 'sourcePath')).toBe('/tmp/skill')

    expect(() => validateToolKey('../codex')).toThrow()
    expect(() => validateBackupId('../../outside')).toThrow()
    expect(() => assertAbsolutePath('relative/path', 'sourcePath')).toThrow()
  })
})

// issue #24: 禁止把 skill 部署到自身 source 路径(或在父子目录重叠处)
describe('assertSafeDeployTarget (issue #24 self-deploy guard)', () => {
  test('reports Windows self-deploy and nested targets as ineligible', () => {
    expect(
      assessSafeDeployTarget(
        'C:\\Users\\me\\.codex\\skills\\demo',
        'C:\\Users\\me\\.codex\\skills\\demo'
      ).eligible
    ).toBe(false)
    expect(
      assessSafeDeployTarget(
        'C:\\Users\\me\\.codex\\skills',
        'C:\\Users\\me\\.codex\\skills\\demo'
      ).eligible
    ).toBe(false)
  })
  test('rejects identical path (normalized + realpath)', () => {
    const { dir, cleanup } = createTempDir('ss-self-')
    expect(() => assertSafeDeployTarget(dir, dir)).toThrow(/own source path/)
    cleanup()
  })

  test('rejects target inside source (recursive copy / cleanup risk)', () => {
    const { dir, cleanup } = createTempDir('ss-parent-src-')
    const target = join(dir, 'child')
    expect(() => assertSafeDeployTarget(dir, target)).toThrow(/inside source/)
    cleanup()
  })

  test('rejects source inside target (cleanup would delete source)', () => {
    const { dir, cleanup } = createTempDir('ss-parent-tgt-')
    const src = join(dir, 'inner')
    mkdirSync(src)
    expect(() => assertSafeDeployTarget(src, dir)).toThrow(/inside target/)
    cleanup()
  })

  test('rejects symlink alias pointing back to source (same realpath)', () => {
    const src = createTempDir('ss-symlink-src-')
    const alias = createTempDir('ss-symlink-alias-')
    // remove the alias dir and replace with a symlink to src.dir
    rmSync(alias.dir, { recursive: true, force: true })
    symlinkSync(src.dir, alias.dir)
    expect(() => assertSafeDeployTarget(src.dir, alias.dir)).toThrow(/own source path/)
    src.cleanup()
    alias.cleanup()
  })

  test('accepts two distinct sibling directories', () => {
    const src = createTempDir('ss-distinct-src-')
    const target = createTempDir('ss-distinct-tgt-')
    expect(() => assertSafeDeployTarget(src.dir, target.dir)).not.toThrow()
    src.cleanup()
    target.cleanup()
  })

  test('accepts non-existent target (fresh deploy) distinct from source', () => {
    const src = createTempDir('ss-fresh-src-')
    const target = join(src.dir, '..', 'fresh-target-' + Date.now())
    expect(() => assertSafeDeployTarget(src.dir, target)).not.toThrow()
    src.cleanup()
  })

  test('rejects `..` traversal that lands on source after resolve', () => {
    const { dir, cleanup } = createTempDir('ss-traversal-')
    const sub = join(dir, 'sub')
    mkdirSync(sub)
    // path.join normalizes `..`, so sub/.. /sub collapses back to sub itself.
    // This verifies the guard compares normalized paths, not raw strings.
    const traversalTarget = join(sub, '..', 'sub')
    expect(traversalTarget).toBe(sub)
    expect(() => assertSafeDeployTarget(sub, traversalTarget)).toThrow(/own source path/)
    cleanup()
  })

  test('exempts realpath-identical target when allowExistingSymlinkToSource is set (managed mode-switch)', () => {
    // 模拟 managed symlink 部署:target 是指向 source 的符号链接。
    // mode-switch / 更新时 cleanup 先 unlink 旧链接,不会删源 → 合法,应放行。
    const src = createTempDir('ss-exempt-src-')
    const alias = createTempDir('ss-exempt-alias-')
    rmSync(alias.dir, { recursive: true, force: true })
    symlinkSync(src.dir, alias.dir)
    expect(() =>
      assertSafeDeployTarget(src.dir, alias.dir, {
        allowExistingSymlinkToSource: true
      })
    ).not.toThrow()
    src.cleanup()
    alias.cleanup()
  })

  test('lexical containment is enforced even with allowExistingSymlinkToSource', () => {
    // 即便是 managed 部署,target 嵌在 source 里仍是递归清理隐患,必须拒绝。
    const { dir, cleanup } = createTempDir('ss-lex-')
    const target = join(dir, 'child')
    expect(() =>
      assertSafeDeployTarget(dir, target, {
        allowExistingSymlinkToSource: true
      })
    ).toThrow(/inside source/)
    cleanup()
  })
})
