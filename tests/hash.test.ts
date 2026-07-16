import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, test } from 'vitest'
import { hashDir } from '../src/main/services/hash'
import { createTempDir } from './helpers/temp'

const cleanups: Array<() => void> = []

function tempDir(prefix: string): string {
  const temp = createTempDir(prefix)
  cleanups.push(temp.cleanup)
  return temp.dir
}

afterEach(() => cleanups.splice(0).reverse().forEach((cleanup) => cleanup()))

describe('hashDir', () => {
  test.runIf(process.platform !== 'win32')('includes a symlink relative path and link target without following it', () => {
    const root = tempDir('hash-symlink-')
    const skill = join(root, 'skill')
    const external = join(root, 'external')
    mkdirSync(skill)
    mkdirSync(external)
    writeFileSync(join(skill, 'SKILL.md'), '# demo')
    writeFileSync(join(external, 'content.txt'), 'version one')

    const withoutLink = hashDir(skill)
    const link = join(skill, 'shared')
    symlinkSync(external, link)
    const firstTarget = hashDir(skill)

    expect(firstTarget).not.toBe(withoutLink)

    // The target contents are outside the skill and must not affect its hash.
    writeFileSync(join(external, 'content.txt'), 'version two')
    expect(hashDir(skill)).toBe(firstTarget)

    // Changing only readlink(2)'s payload must change the hash.
    unlinkSync(link)
    symlinkSync(join(root, 'missing'), link)
    const secondTarget = hashDir(skill)
    expect(secondTarget).not.toBe(firstTarget)

    unlinkSync(link)
    expect(hashDir(skill)).toBe(withoutLink)
  })

  test.runIf(process.platform !== 'win32')('distinguishes symlinks with the same target at different relative paths', () => {
    const root = tempDir('hash-symlink-path-')
    const first = join(root, 'first')
    const second = join(root, 'second')
    mkdirSync(first)
    mkdirSync(second)
    writeFileSync(join(first, 'SKILL.md'), '# demo')
    writeFileSync(join(second, 'SKILL.md'), '# demo')
    symlinkSync('../target', join(first, 'one'))
    symlinkSync('../target', join(second, 'two'))

    expect(hashDir(first)).not.toBe(hashDir(second))
  })

  test.runIf(process.platform !== 'win32')('hashes cyclic directory symlinks as links instead of traversing them', () => {
    const root = tempDir('hash-symlink-cycle-')
    writeFileSync(join(root, 'SKILL.md'), '# demo')
    symlinkSync('.', join(root, 'cycle'))

    expect(hashDir(root)).toMatch(/^[a-f0-9]{64}$/)
  })

  test('keeps the existing single-file byte hash semantics', () => {
    const root = tempDir('hash-file-')
    const file = join(root, 'plain.txt')
    writeFileSync(file, 'hello')

    expect(hashDir(file)).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  })
})
