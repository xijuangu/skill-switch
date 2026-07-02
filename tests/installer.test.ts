import { test, expect, describe } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createTempDir, createTempDb } from './helpers/temp'
import {
  parseGitHubUrl,
  installFromGitHub,
  installFromZip,
  installFromLocalDir,
  type GitRunner
} from '../src/main/services/installer'
import { getSkillByName } from '../src/main/db/dao/skills'
import { getSourcesBySkillId } from '../src/main/db/dao/skill-sources'
import { listBackups } from '../src/main/services/backup'
import AdmZip from 'adm-zip'

// helper:在 parent 下创建一个含 SKILL.md 的 skill 目录,返回其路径
function writeSkillDir(parent: string, name: string, content: string): string {
  const skillDir = join(parent, name)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), content)
  return skillDir
}

describe('parseGitHubUrl', () => {
  test('单仓库 URL:subPath=null, ref=main, repoUrl 带 .git', () => {
    const parsed = parseGitHubUrl('https://github.com/owner/repo')
    expect(parsed.owner).toBe('owner')
    expect(parsed.repo).toBe('repo')
    expect(parsed.subPath).toBeNull()
    expect(parsed.ref).toBe('main')
    expect(parsed.repoUrl).toBe('https://github.com/owner/repo.git')
    expect(parsed.repoWebUrl).toBe('https://github.com/owner/repo')
  })

  test('带 .git 后缀的单仓库 URL:正常解析', () => {
    const parsed = parseGitHubUrl('https://github.com/owner/repo.git')
    expect(parsed.repo).toBe('repo')
    expect(parsed.repoUrl).toBe('https://github.com/owner/repo.git')
    expect(parsed.repoWebUrl).toBe('https://github.com/owner/repo')
    expect(parsed.subPath).toBeNull()
  })

  test('子路径 URL (tree/main/skills/grilling):subPath=skills/grilling, ref=main', () => {
    const parsed = parseGitHubUrl(
      'https://github.com/owner/repo/tree/main/skills/grilling'
    )
    expect(parsed.owner).toBe('owner')
    expect(parsed.repo).toBe('repo')
    expect(parsed.subPath).toBe('skills/grilling')
    expect(parsed.ref).toBe('main')
    expect(parsed.repoUrl).toBe('https://github.com/owner/repo.git')
  })

  test('blob URL 同样取子路径', () => {
    const parsed = parseGitHubUrl(
      'https://github.com/owner/repo/blob/main/skills/grilling/SKILL.md'
    )
    expect(parsed.subPath).toBe('skills/grilling/SKILL.md')
    expect(parsed.ref).toBe('main')
  })

  test('只有 tree/{ref} 无子路径:subPath=null', () => {
    const parsed = parseGitHubUrl('https://github.com/owner/repo/tree/dev')
    expect(parsed.ref).toBe('dev')
    expect(parsed.subPath).toBeNull()
  })

  test('非 GitHub URL → throw', () => {
    expect(() => parseGitHubUrl('https://gitlab.com/owner/repo')).toThrow(
      'invalid GitHub URL'
    )
  })

  test('路径段不足 → throw', () => {
    expect(() => parseGitHubUrl('https://github.com/onlyone')).toThrow(
      'invalid GitHub URL'
    )
  })
})

describe('installFromGitHub', () => {
  test('passes the URL ref to the git runner for non-default branches', () => {
    const central = createTempDir('ss-central-')
    const backups = createTempDir('ss-backups-')
    const { db, cleanup: cleanupDb } = createTempDb()
    let receivedRef: string | null = null

    const mockRunner: GitRunner = {
      clone: (_repoUrl, targetDir, subPath, ref) => {
        receivedRef = ref
        mkdirSync(join(targetDir, subPath!), { recursive: true })
        writeFileSync(
          join(targetDir, subPath!, 'SKILL.md'),
          '---\nname: branch-skill\n---\n'
        )
      },
      getHeadSha: () => 'branch-sha'
    }

    installFromGitHub(
      db,
      'https://github.com/owner/repo/tree/dev/skills/branch-skill',
      { centralSkillsDir: central.dir, backupsDir: backups.dir },
      mockRunner
    )

    expect(receivedRef).toBe('dev')

    central.cleanup()
    backups.cleanup()
    cleanupDb()
  })

  test('单仓库安装:mock clone 预置 SKILL.md → 安装到 centralSkillsDir,source_type=central-repo', () => {
    const central = createTempDir('ss-central-')
    const backups = createTempDir('ss-backups-')
    const { db, cleanup: cleanupDb } = createTempDb()

    const mockRunner: GitRunner = {
      clone: (_repoUrl, targetDir, _subPath) => {
        writeFileSync(
          join(targetDir, 'SKILL.md'),
          '---\nname: my-skill\n---\nbody\n'
        )
      },
      getHeadSha: () => 'abc123def456'
    }

    const result = installFromGitHub(
      db,
      'https://github.com/owner/repo',
      { centralSkillsDir: central.dir, backupsDir: backups.dir },
      mockRunner
    )

    expect(result.skillName).toBe('my-skill')
    expect(result.sourceType).toBe('central-repo')
    expect(result.repoUrl).toBe('https://github.com/owner/repo')
    expect(result.commitSha).toBe('abc123def456')
    expect(result.overwritten).toBe(false)
    expect(result.sourcePath).toBe(join(central.dir, 'my-skill'))

    // 目标目录存在,含 SKILL.md
    expect(existsSync(join(central.dir, 'my-skill', 'SKILL.md'))).toBe(true)

    // DB 记录
    const skill = getSkillByName(db, 'my-skill')
    expect(skill).toBeDefined()
    const sources = getSourcesBySkillId(db, skill!.id)
    expect(sources).toHaveLength(1)
    expect(sources[0].source_type).toBe('central-repo')
    expect(sources[0].source_origin).toBe('github')
    expect(sources[0].repo_url).toBe('https://github.com/owner/repo')
    expect(sources[0].commit_sha).toBe('abc123def456')
    expect(sources[0].path).toBe(join(central.dir, 'my-skill'))

    central.cleanup()
    backups.cleanup()
    cleanupDb()
  })

  test('子路径安装:mock clone 预置 skills/grilling/SKILL.md → 只安装 grilling 子目录', () => {
    const central = createTempDir('ss-central-')
    const backups = createTempDir('ss-backups-')
    const { db, cleanup: cleanupDb } = createTempDb()

    const mockRunner: GitRunner = {
      clone: (_repoUrl, targetDir, subPath) => {
        // subPath = 'skills/grilling'
        mkdirSync(join(targetDir, subPath!), { recursive: true })
        writeFileSync(
          join(targetDir, subPath!, 'SKILL.md'),
          '---\nname: grilling\n---\ngrilling body\n'
        )
      },
      getHeadSha: () => 'sha789'
    }

    const result = installFromGitHub(
      db,
      'https://github.com/owner/repo/tree/main/skills/grilling',
      { centralSkillsDir: central.dir, backupsDir: backups.dir },
      mockRunner
    )

    expect(result.skillName).toBe('grilling')
    expect(result.sourcePath).toBe(join(central.dir, 'grilling'))
    expect(result.commitSha).toBe('sha789')
    expect(existsSync(join(central.dir, 'grilling', 'SKILL.md'))).toBe(true)
    // 只拷了 grilling 子目录内容,不是整个仓库结构(skills/ 嵌套不存在)
    expect(existsSync(join(central.dir, 'grilling', 'skills'))).toBe(false)

    central.cleanup()
    backups.cleanup()
    cleanupDb()
  })

  test('同名覆盖:centralSkillsDir 已有同名 skill → 备份目录多一份,overwritten=true', () => {
    const central = createTempDir('ss-central-')
    const backups = createTempDir('ss-backups-')
    const { db, cleanup: cleanupDb } = createTempDb()

    // 预置已有同名 skill(旧内容)
    mkdirSync(join(central.dir, 'grilling'), { recursive: true })
    writeFileSync(
      join(central.dir, 'grilling', 'SKILL.md'),
      '---\nname: grilling\n---\nOLD\n'
    )

    const mockRunner: GitRunner = {
      clone: (_repoUrl, targetDir, _subPath) => {
        writeFileSync(
          join(targetDir, 'SKILL.md'),
          '---\nname: grilling\n---\nNEW\n'
        )
      },
      getHeadSha: () => 'sha000'
    }

    const result = installFromGitHub(
      db,
      'https://github.com/owner/repo',
      { centralSkillsDir: central.dir, backupsDir: backups.dir },
      mockRunner
    )

    expect(result.overwritten).toBe(true)
    // 目标内容是新内容
    expect(readFileSync(join(central.dir, 'grilling', 'SKILL.md'), 'utf-8')).toContain('NEW')
    // 备份目录多了一份
    const backupList = listBackups(backups.dir)
    expect(backupList.length).toBe(1)
    expect(backupList[0].skillName).toBe('grilling')
    expect(backupList[0].targetTool).toBe('central-repo')

    central.cleanup()
    backups.cleanup()
    cleanupDb()
  })

  test('无 SKILL.md → 回退目录名作为 skill name', () => {
    const central = createTempDir('ss-central-')
    const backups = createTempDir('ss-backups-')
    const { db, cleanup: cleanupDb } = createTempDb()

    // 用子路径 URL,sourceDir = tmpDir/skills/grilling,basename = 'grilling'
    const mockRunner: GitRunner = {
      clone: (_repoUrl, targetDir, subPath) => {
        mkdirSync(join(targetDir, subPath!), { recursive: true })
        writeFileSync(join(targetDir, subPath!, 'prompt.txt'), 'hello\n')
      },
      getHeadSha: () => 'sha111'
    }

    const result = installFromGitHub(
      db,
      'https://github.com/owner/repo/tree/main/skills/grilling',
      { centralSkillsDir: central.dir, backupsDir: backups.dir },
      mockRunner
    )

    // subPath = 'skills/grilling',basename = 'grilling'
    expect(result.skillName).toBe('grilling')
    expect(result.sourcePath).toBe(join(central.dir, 'grilling'))
    expect(existsSync(join(central.dir, 'grilling', 'prompt.txt'))).toBe(true)

    central.cleanup()
    backups.cleanup()
    cleanupDb()
  })
})

describe('installFromZip', () => {
  test('default ZIP extractor installs without a system unzip command', () => {
    const central = createTempDir('ss-central-')
    const backups = createTempDir('ss-backups-')
    const archive = createTempDir('ss-archive-')
    const { db, cleanup: cleanupDb } = createTempDb()
    const zipPath = join(archive.dir, 'portable.zip')
    const zip = new AdmZip()
    zip.addFile(
      'portable/SKILL.md',
      Buffer.from('---\nname: portable\n---\nbody')
    )
    zip.writeZip(zipPath)

    const result = installFromZip(db, zipPath, {
      centralSkillsDir: central.dir,
      backupsDir: backups.dir
    })

    expect(result.skillName).toBe('portable')
    expect(readFileSync(join(result.sourcePath, 'SKILL.md'), 'utf-8')).toContain(
      'body'
    )

    central.cleanup()
    backups.cleanup()
    archive.cleanup()
    cleanupDb()
  })

  test('mock unzip 预置扁平结构 → 安装到 centralSkillsDir,source_type=central-repo', () => {
    const central = createTempDir('ss-central-')
    const backups = createTempDir('ss-backups-')
    const { db, cleanup: cleanupDb } = createTempDb()

    // mock unzip:直接在 tmpDir 创建 SKILL.md(扁平结构)
    const mockUnzip = (_zipPath: string, targetDir: string) => {
      writeFileSync(
        join(targetDir, 'SKILL.md'),
        '---\nname: zipped-skill\n---\nbody\n'
      )
    }

    const result = installFromZip(
      db,
      '/fake/path/to/skill.zip',
      { centralSkillsDir: central.dir, backupsDir: backups.dir },
      mockUnzip
    )

    expect(result.skillName).toBe('zipped-skill')
    expect(result.sourceType).toBe('central-repo')
    expect(result.repoUrl).toBeNull()
    expect(result.commitSha).toBeNull()
    expect(result.overwritten).toBe(false)
    expect(existsSync(join(central.dir, 'zipped-skill', 'SKILL.md'))).toBe(true)

    const skill = getSkillByName(db, 'zipped-skill')
    expect(skill).toBeDefined()
    const sources = getSourcesBySkillId(db, skill!.id)
    expect(sources).toHaveLength(1)
    expect(sources[0].source_type).toBe('central-repo')
    expect(sources[0].source_origin).toBe('zip')
    expect(sources[0].repo_url).toBeNull()
    expect(sources[0].commit_sha).toBeNull()

    central.cleanup()
    backups.cleanup()
    cleanupDb()
  })

  test('解压后单层子目录 → 取子目录作为 skill 源', () => {
    const central = createTempDir('ss-central-')
    const backups = createTempDir('ss-backups-')
    const { db, cleanup: cleanupDb } = createTempDb()

    // mock unzip:解压出单层子目录 grilling/SKILL.md
    const mockUnzip = (_zipPath: string, targetDir: string) => {
      mkdirSync(join(targetDir, 'grilling'), { recursive: true })
      writeFileSync(
        join(targetDir, 'grilling', 'SKILL.md'),
        '---\nname: grilling\n---\nfrom zip\n'
      )
    }

    const result = installFromZip(
      db,
      '/fake/path/to/skill.zip',
      { centralSkillsDir: central.dir, backupsDir: backups.dir },
      mockUnzip
    )

    expect(result.skillName).toBe('grilling')
    expect(result.sourcePath).toBe(join(central.dir, 'grilling'))
    expect(
      readFileSync(join(central.dir, 'grilling', 'SKILL.md'), 'utf-8')
    ).toContain('from zip')

    central.cleanup()
    backups.cleanup()
    cleanupDb()
  })
})

describe('installFromLocalDir', () => {
  test('本地目录索引安装:source_type=indexed,不搬文件', () => {
    const central = createTempDir('ss-central-')
    const backups = createTempDir('ss-backups-')
    const { db, cleanup: cleanupDb } = createTempDb()

    const localDir = createTempDir('ss-local-')
    const skillDir = writeSkillDir(
      localDir.dir,
      'grilling',
      '---\nname: grilling\n---\nlocal\n'
    )
    // 加一个额外文件,验证不搬文件
    writeFileSync(join(skillDir, 'extra.txt'), 'extra\n')
    const originalContent = readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')

    const result = installFromLocalDir(db, skillDir, {
      centralSkillsDir: central.dir,
      backupsDir: backups.dir
    })

    expect(result.skillName).toBe('grilling')
    expect(result.sourceType).toBe('indexed')
    expect(result.sourcePath).toBe(skillDir)
    expect(result.repoUrl).toBeNull()
    expect(result.commitSha).toBeNull()
    expect(result.overwritten).toBe(false)

    // 不搬文件:原目录内容不变
    expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')).toBe(originalContent)
    expect(existsSync(join(skillDir, 'extra.txt'))).toBe(true)
    // 中央仓库不创建副本
    expect(existsSync(join(central.dir, 'grilling'))).toBe(false)

    // DB 有记录
    const skill = getSkillByName(db, 'grilling')
    expect(skill).toBeDefined()
    const sources = getSourcesBySkillId(db, skill!.id)
    expect(sources).toHaveLength(1)
    expect(sources[0].source_type).toBe('indexed')
    expect(sources[0].source_origin).toBe('local')
    expect(sources[0].source_tool).toBeNull()
    expect(sources[0].path).toBe(skillDir)
    expect(sources[0].repo_url).toBeNull()
    expect(sources[0].commit_sha).toBeNull()

    central.cleanup()
    backups.cleanup()
    localDir.cleanup()
    cleanupDb()
  })

  test('重复安装幂等:同路径 upsert 不重复', () => {
    const central = createTempDir('ss-central-')
    const backups = createTempDir('ss-backups-')
    const { db, cleanup: cleanupDb } = createTempDb()

    const localDir = createTempDir('ss-local-')
    const skillDir = writeSkillDir(
      localDir.dir,
      'stable',
      '---\nname: stable\n---\n'
    )

    const r1 = installFromLocalDir(db, skillDir, {
      centralSkillsDir: central.dir,
      backupsDir: backups.dir
    })
    const r2 = installFromLocalDir(db, skillDir, {
      centralSkillsDir: central.dir,
      backupsDir: backups.dir
    })

    // 同一 skill id
    expect(r2.skillId).toBe(r1.skillId)
    // 只有一条 source 记录
    const sources = getSourcesBySkillId(db, r1.skillId)
    expect(sources).toHaveLength(1)

    central.cleanup()
    backups.cleanup()
    localDir.cleanup()
    cleanupDb()
  })
})
