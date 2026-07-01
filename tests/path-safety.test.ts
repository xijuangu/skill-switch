import { describe, expect, test } from 'vitest'
import {
  assertAbsolutePath,
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
