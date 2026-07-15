import {
  existsSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import { createTempDb, createTempDir } from './helpers/temp'
import { runMigrations } from '../src/main/db/schema'
import {
  listSourceRoots,
  registerAndScanSourceRoot,
  registerSourceRoot,
  rescanSourceRoot,
  detachSourceRoot
} from '../src/main/services/source-roots'
import { getSourceByPath, upsertSource } from '../src/main/db/dao/skill-sources'
import { upsertDeployment } from '../src/main/db/dao/deployments'

describe('Source Roots', () => {
  test('migrates an existing registry with Source Root storage', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE skill_sources (
        id INTEGER PRIMARY KEY,
        source_type TEXT NOT NULL,
        repo_url TEXT,
        commit_sha TEXT
      );
      CREATE TABLE deployments (id INTEGER PRIMARY KEY);
    `)

    runMigrations(db)

    const columns = db.prepare('PRAGMA table_info(skill_sources)').all() as Array<{ name: string }>
    expect(columns.map((column) => column.name)).toContain('source_root_id')
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'source_roots'").get()
    ).toEqual({ name: 'source_roots' })
    const rootId = Number(db.prepare(
      "INSERT INTO source_roots (path, created_at) VALUES ('/root', 'now')"
    ).run().lastInsertRowid)
    db.prepare("INSERT INTO skill_sources (id, source_type, source_root_id) VALUES (1, 'indexed', ?)").run(rootId)
    db.prepare('DELETE FROM source_roots WHERE id = ?').run(rootId)
    expect(db.prepare('SELECT id FROM skill_sources WHERE id = 1').get()).toBeUndefined()
    expect(() => db.prepare(
      "INSERT INTO skill_sources (id, source_type, source_root_id) VALUES (2, 'indexed', 999)"
    ).run()).toThrow('source root not found')
    db.close()
  })

  test('registers and lists a canonical content root', () => {
    const root = createTempDir('source-root-')
    const { db, cleanup } = createTempDb()

    const registered = registerSourceRoot(db, root.dir)

    expect(registered).toMatchObject({ path: realpathSync(root.dir) })
    expect(registered.id).toEqual(expect.any(Number))
    expect(listSourceRoots(db)).toEqual([registered])

    cleanup()
    root.cleanup()
  })

  test('rejects parent-child Source Root overlaps in either registration order', () => {
    const parent = createTempDir('source-root-overlap-')
    const child = join(parent.dir, 'nested')
    mkdirSync(child)
    const firstDb = createTempDb()
    const secondDb = createTempDb()

    registerSourceRoot(firstDb.db, parent.dir)
    expect(() => registerSourceRoot(firstDb.db, child)).toThrow(/overlap/i)

    registerSourceRoot(secondDb.db, child)
    expect(() => registerSourceRoot(secondDb.db, parent.dir)).toThrow(/overlap/i)

    firstDb.cleanup()
    secondDb.cleanup()
    parent.cleanup()
  })

  test('does not leave a newly registered Root behind when its first scan fails', () => {
    const root = createTempDir('source-root-register-failure-')
    const { db, cleanup } = createTempDb()
    const skillDir = join(root.dir, 'invalid-skill')
    mkdirSync(skillDir)
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: ../invalid\n---\n')

    expect(() => registerAndScanSourceRoot(db, root.dir)).toThrow()
    expect(listSourceRoots(db)).toEqual([])

    cleanup()
    root.cleanup()
  })

  test('recursively discovers authoritative Skill directories beneath a root', () => {
    const root = createTempDir('source-root-scan-')
    const { db, cleanup } = createTempDb()
    const skillDir = join(root.dir, 'team', 'tickets', 'to-tickets')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: to-tickets\n---\n')
    const registered = registerSourceRoot(db, root.dir)

    const result = rescanSourceRoot(db, registered.id)

    expect(result).toMatchObject({ discovered: 1, upserted: 1, removed: 0 })
    expect(result.sources).toMatchObject([
      {
        path: realpathSync(skillDir),
        source_origin: 'local',
        source_root_id: registered.id
      }
    ])
    expect(listSourceRoots(db)[0].last_scanned_at).toEqual(expect.any(String))

    cleanup()
    root.cleanup()
  })

  test('keeps the first discovered_at timestamp when a Source Root is rescanned', () => {
    const root = createTempDir('source-root-time-')
    const { db, cleanup } = createTempDb()
    const skillDir = join(root.dir, 'to-tickets')
    mkdirSync(skillDir)
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: to-tickets\n---\n')
    const registered = registerSourceRoot(db, root.dir)
    const first = rescanSourceRoot(db, registered.id).sources[0]
    const original = '2020-01-02T03:04:05.000Z'
    db.prepare('UPDATE skill_sources SET discovered_at = ? WHERE id = ?').run(original, first.id)

    rescanSourceRoot(db, registered.id)

    expect(rescanSourceRoot(db, registered.id).sources[0].discovered_at).toBe(original)
    cleanup()
    root.cleanup()
  })

  test('keeps Source Root ownership when the same canonical path is found through a tool alias', () => {
    const root = createTempDir('source-root-alias-')
    const { db, cleanup } = createTempDb()
    const skillDir = join(root.dir, 'to-tickets')
    mkdirSync(skillDir)
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: to-tickets\n---\n')
    const registered = registerSourceRoot(db, root.dir)
    const source = rescanSourceRoot(db, registered.id).sources[0]

    upsertSource(db, source.skill_id, source.path, source.hash, source.mtime, 'indexed', {
      origin: 'scan',
      tool: null
    })

    expect(getSourceByPath(db, source.path)).toMatchObject({
      source_origin: 'local',
      source_root_id: registered.id
    })
    cleanup()
    root.cleanup()
  })

  test('moves a canonical Source instead of duplicating it when its frontmatter name changes', () => {
    const root = createTempDir('source-root-rename-')
    const { db, cleanup } = createTempDb()
    const skillDir = join(root.dir, 'ticket-skill')
    mkdirSync(skillDir)
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: old-name\n---\n')
    const registered = registerSourceRoot(db, root.dir)
    const originalSource = rescanSourceRoot(db, registered.id).sources[0]
    const firstDiscoveredAt = '2020-01-02T03:04:05.000Z'
    db.prepare('UPDATE skill_sources SET discovered_at = ? WHERE id = ?').run(
      firstDiscoveredAt,
      originalSource.id
    )

    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: new-name\n---\n')
    const result = rescanSourceRoot(db, registered.id)

    expect(result.sources).toHaveLength(1)
    expect(result.sources[0].path).toBe(realpathSync(skillDir))
    expect(result.sources[0].id).toBe(originalSource.id)
    expect(result.sources[0].discovered_at).toBe(firstDiscoveredAt)
    expect(
      db.prepare('SELECT name FROM skills ORDER BY name').all()
    ).toEqual([{ name: 'new-name' }])
    cleanup()
    root.cleanup()
  })

  test('refuses a frontmatter rename while the Source has a Deployment', () => {
    const root = createTempDir('source-root-deployed-rename-')
    const { db, cleanup } = createTempDb()
    const skillDir = join(root.dir, 'ticket-skill')
    mkdirSync(skillDir)
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: old-name\n---\n')
    const registered = registerSourceRoot(db, root.dir)
    const source = rescanSourceRoot(db, registered.id).sources[0]
    upsertDeployment(
      db,
      source.skill_id,
      'codex',
      join(root.dir, 'target'),
      'symlink',
      source.path,
      source.hash,
      { sourceId: source.id, targetId: 'codex-target' }
    )
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: new-name\n---\n')

    expect(() => rescanSourceRoot(db, registered.id)).toThrow(/Deployment/)
    expect(getSourceByPath(db, source.path)).toMatchObject({
      id: source.id,
      skill_id: source.skill_id
    })
    expect(db.prepare('SELECT name FROM skills ORDER BY name').all()).toEqual([
      { name: 'old-name' }
    ])

    cleanup()
    root.cleanup()
  })

  test('detaches root-owned metadata without deleting external Skill files', () => {
    const root = createTempDir('source-root-detach-')
    const { db, cleanup } = createTempDb()
    const skillDir = join(root.dir, 'to-tickets')
    const skillFile = join(skillDir, 'SKILL.md')
    mkdirSync(skillDir)
    writeFileSync(skillFile, '---\nname: to-tickets\n---\n')
    const registered = registerSourceRoot(db, root.dir)
    rescanSourceRoot(db, registered.id)

    const result = detachSourceRoot(db, registered.id)

    expect(result).toEqual({ detachedSources: 1 })
    expect(listSourceRoots(db)).toEqual([])
    expect(existsSync(skillFile)).toBe(true)

    cleanup()
    root.cleanup()
  })

  test('refuses to detach a Root while one of its Sources has a Deployment', () => {
    const root = createTempDir('source-root-deployed-detach-')
    const { db, cleanup } = createTempDb()
    const skillDir = join(root.dir, 'deployed-skill')
    mkdirSync(skillDir)
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: deployed-skill\n---\n')
    const registered = registerSourceRoot(db, root.dir)
    const source = rescanSourceRoot(db, registered.id).sources[0]
    upsertDeployment(
      db,
      source.skill_id,
      'codex',
      join(root.dir, 'target'),
      'symlink',
      source.path,
      source.hash,
      { sourceId: source.id, targetId: 'codex-target' }
    )

    expect(() => detachSourceRoot(db, registered.id)).toThrow(/Deployment/)
    expect(listSourceRoots(db)).toHaveLength(1)
    expect(getSourceByPath(db, source.path)?.id).toBe(source.id)

    cleanup()
    root.cleanup()
  })

  test.runIf(process.platform !== 'win32')('does not follow directory symlinks while walking a root', () => {
    const root = createTempDir('source-root-links-')
    const outside = createTempDir('source-root-outside-')
    const { db, cleanup } = createTempDb()
    const outsideSkill = join(outside.dir, 'external-skill')
    mkdirSync(outsideSkill)
    writeFileSync(join(outsideSkill, 'SKILL.md'), '---\nname: external-skill\n---\n')
    symlinkSync(outsideSkill, join(root.dir, 'linked-skill'))
    const registered = registerSourceRoot(db, root.dir)

    expect(rescanSourceRoot(db, registered.id)).toMatchObject({
      discovered: 0,
      sources: []
    })

    cleanup()
    root.cleanup()
    outside.cleanup()
  })

  test('removes stale metadata on rescan without deleting the former source directory', () => {
    const root = createTempDir('source-root-stale-')
    const { db, cleanup } = createTempDb()
    const skillDir = join(root.dir, 'stale-skill')
    const skillFile = join(skillDir, 'SKILL.md')
    mkdirSync(skillDir)
    writeFileSync(skillFile, '---\nname: stale-skill\n---\n')
    const registered = registerSourceRoot(db, root.dir)
    rescanSourceRoot(db, registered.id)
    unlinkSync(skillFile)

    expect(rescanSourceRoot(db, registered.id)).toMatchObject({
      discovered: 0,
      removed: 1,
      sources: []
    })
    expect(existsSync(skillDir)).toBe(true)

    cleanup()
    root.cleanup()
  })

  test('keeps missing Source metadata on rescan while a Deployment still references it', () => {
    const root = createTempDir('source-root-missing-deployed-')
    const { db, cleanup } = createTempDb()
    const skillDir = join(root.dir, 'deployed-skill')
    const skillFile = join(skillDir, 'SKILL.md')
    mkdirSync(skillDir)
    writeFileSync(skillFile, '---\nname: deployed-skill\n---\n')
    const registered = registerSourceRoot(db, root.dir)
    const source = rescanSourceRoot(db, registered.id).sources[0]
    upsertDeployment(
      db,
      source.skill_id,
      'codex',
      join(root.dir, 'target'),
      'symlink',
      source.path,
      source.hash,
      { sourceId: source.id, targetId: 'codex-target' }
    )
    unlinkSync(skillFile)

    expect(rescanSourceRoot(db, registered.id)).toMatchObject({
      discovered: 0,
      removed: 0,
      sources: [{ id: source.id, path: source.path }]
    })

    cleanup()
    root.cleanup()
  })
})
