// installer 服务:从 GitHub / ZIP / 本地目录安装 skill 到中央仓库
//
// 设计 = Option A:所有函数显式接收 centralSkillsDir / backupsDir,便于测试用
// temp fs 驱动,不触碰真实 ~/.skill-switch。git / unzip 操作抽成可注入参数
// (GitRunner / unzip),默认用 execFileSync 参数数组,测试传 mock 函数预置结果。
//
// 三种安装来源:
// - GitHub:clone 仓库到临时目录 → 拷到 centralSkillsDir/{name} → DB 记 central-repo source
// - ZIP:解压到临时目录 → 拷到 centralSkillsDir/{name} → DB 记 central-repo source
// - 本地目录:不搬文件(索引模式)→ DB 记 indexed source

import { execFileSync } from 'child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync
} from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import matter from 'gray-matter'
import AdmZip from 'adm-zip'
import type { DB } from '../db/database'
import { runInTransaction } from '../db/database'
import { upsertSkill } from '../db/dao/skills'
import { upsertSource } from '../db/dao/skill-sources'
import { hashDir } from './hash'
import { createBackup } from './backup'
import { resolveWithin, validateSkillName } from './path-safety'
import type {
  InstallOptions,
  InstallResult,
  ParsedGitHubUrl
} from '../types'

/**
 * Git 操作抽象:默认用 execFileSync 跑真实 git,测试可注入 mock。
 * clone 负责把仓库内容拉到 targetDir(有 subPath 时走 sparse-checkout);
 * getHeadSha 返回 targetDir 当前 HEAD 的 commit SHA。
 */
export interface GitRunner {
  clone(
    repoUrl: string,
    targetDir: string,
    subPath: string | null,
    ref: string
  ): void
  getHeadSha(dir: string): string
}

/** 默认 git runner:参数数组直调 git,不经过 shell。 */
const defaultGitRunner: GitRunner = {
  clone: (repoUrl, targetDir, subPath, ref) => {
    execFileSync(
      'git',
      ['clone', '--filter=blob:none', '--no-checkout', repoUrl, targetDir],
      { stdio: 'ignore' }
    )
    if (subPath) {
      execFileSync(
        'git',
        ['-C', targetDir, 'sparse-checkout', 'set', '--', subPath],
        { stdio: 'ignore' }
      )
    }
    execFileSync('git', ['-C', targetDir, 'fetch', '--depth', '1', 'origin', ref], {
      stdio: 'ignore'
    })
    execFileSync('git', ['-C', targetDir, 'checkout', '--detach', 'FETCH_HEAD'], {
      stdio: 'ignore'
    })
  },
  getHeadSha: (dir) => {
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'])
      .toString()
      .trim()
  }
}

/** 默认 ZIP 解压:应用内跨平台实现,不依赖系统 unzip。 */
function defaultUnzip(zipPath: string, targetDir: string): void {
  new AdmZip(zipPath).extractAllTo(targetDir, true)
}

/**
 * 解析 GitHub URL,支持:
 * - 单仓库:https://github.com/owner/repo[.git]
 * - 带 ref:https://github.com/owner/repo/tree/main
 * - 子路径:https://github.com/owner/repo/tree/main/skills/grilling
 * - blob 路径(同样取子路径,blob 用于文件但这里也接受)
 *
 * 非法 URL(非 github.com / 路径段不足)→ throw
 */
export function parseGitHubUrl(url: string): ParsedGitHubUrl {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Error(`invalid GitHub URL: ${url}`)
  }
  if (u.hostname !== 'github.com') {
    throw new Error(`invalid GitHub URL: ${url}`)
  }

  const segments = u.pathname.split('/').filter(Boolean)
  if (segments.length < 2) {
    throw new Error(`invalid GitHub URL: ${url}`)
  }

  const [owner, repoRaw, ...rest] = segments
  // 去掉 .git 后缀(repoUrl 重新拼)
  const repo = repoRaw.endsWith('.git') ? repoRaw.slice(0, -4) : repoRaw
  const repoUrl = `https://github.com/${owner}/${repo}.git`
  const repoWebUrl = `https://github.com/${owner}/${repo}`

  let ref = 'main'
  let subPath: string | null = null
  // rest 可能形态:
  //  []                         → 单仓库
  //  ['tree', 'main']           → 只有 ref
  //  ['tree', 'main', 'a', 'b'] → ref + subPath='a/b'
  //  ['blob', 'main', ...]      → 同上(blob 用于文件,这里也接受)
  if (rest.length >= 2 && (rest[0] === 'tree' || rest[0] === 'blob')) {
    ref = rest[1]
    if (rest.length > 2) {
      subPath = rest.slice(2).join('/')
    }
  }

  return { repoUrl, repoWebUrl, owner, repo, subPath, ref }
}

/** 从 SKILL.md frontmatter 读 name;无 frontmatter 或无 name → 回退目录名 */
function resolveSkillName(skillDir: string): string {
  const skillMdPath = join(skillDir, 'SKILL.md')
  if (existsSync(skillMdPath)) {
    const content = readFileSync(skillMdPath, 'utf-8')
    const parsed = matter(content)
    const name = parsed.data.name
    if (typeof name === 'string' && name.trim().length > 0) {
      return validateSkillName(name)
    }
  }
  return validateSkillName(basename(skillDir))
}

/**
 * 把 sourceDir 拷到 destPath,处理同名覆盖(备份+删除)。
 * 返回是否走了覆盖。centralSkillsDir 不存在时先创建。
 */
function copyWithBackup(
  sourceDir: string,
  destPath: string,
  skillName: string,
  opts: InstallOptions
): boolean {
  mkdirSync(opts.centralSkillsDir, { recursive: true })
  let overwritten = false
  if (existsSync(destPath)) {
    createBackup({
      skillName,
      targetTool: 'central-repo',
      sourcePath: destPath,
      backupsDir: opts.backupsDir
    })
    rmSync(destPath, { recursive: true, force: true })
    overwritten = true
  }
  cpSync(sourceDir, destPath, { recursive: true, force: true })
  return overwritten
}

/**
 * 从 GitHub 安装 skill 到中央仓库。
 * gitRunner 可注入(测试用),默认用 execFileSync 跑真实 git。
 */
export function installFromGitHub(
  db: DB,
  rawUrl: string,
  opts: InstallOptions,
  gitRunner: GitRunner = defaultGitRunner
): InstallResult {
  const parsed = parseGitHubUrl(rawUrl)
  const tmpDir = mkdtempSync(join(tmpdir(), 'ss-gh-'))
  try {
    gitRunner.clone(parsed.repoUrl, tmpDir, parsed.subPath, parsed.ref)
    const commitSha = gitRunner.getHeadSha(tmpDir)

    // 有 subPath → 源 = tmpDir/subPath;无 → 源 = tmpDir(整个仓库就是 skill)
    const sourceDir = parsed.subPath
      ? resolveWithin(tmpDir, ...parsed.subPath.split('/'))
      : tmpDir
    const skillName = resolveSkillName(sourceDir)
    const destPath = resolveWithin(opts.centralSkillsDir, skillName)

    const overwritten = copyWithBackup(sourceDir, destPath, skillName, opts)
    const hash = hashDir(destPath)
    const mtime = Math.floor(statSync(destPath).mtimeMs)

    const skillId = runInTransaction(db, () => {
      const id = upsertSkill(db, skillName, destPath)
      upsertSource(
        db,
        id,
        destPath,
        hash,
        mtime,
        'central-repo',
        parsed.repoWebUrl,
        commitSha
      )
      return id
    })

    return {
      skillName,
      skillId,
      sourcePath: destPath,
      sourceType: 'central-repo',
      repoUrl: parsed.repoWebUrl,
      commitSha,
      overwritten
    }
  } finally {
    // 无论成功失败都清理临时目录
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

/**
 * 从本地 ZIP 安装 skill 到中央仓库。
 * unzip 函数可注入(测试用),默认用系统 unzip 命令。
 * ZIP 解压后若有一层顶层目录则取该子目录作为 skill 源,否则取 tmpDir。
 */
export function installFromZip(
  db: DB,
  zipPath: string,
  opts: InstallOptions,
  unzip: (zipPath: string, targetDir: string) => void = defaultUnzip
): InstallResult {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ss-zip-'))
  try {
    unzip(zipPath, tmpDir)

    // 判断是否有一层顶层目录(如 grilling/SKILL.md vs 直接 SKILL.md)
    const entries = readdirSync(tmpDir, { withFileTypes: true })
    const sourceDir =
      entries.length === 1 && entries[0].isDirectory()
        ? join(tmpDir, entries[0].name)
        : tmpDir

    const skillName = resolveSkillName(sourceDir)
    const destPath = resolveWithin(opts.centralSkillsDir, skillName)

    const overwritten = copyWithBackup(sourceDir, destPath, skillName, opts)
    const hash = hashDir(destPath)
    const mtime = Math.floor(statSync(destPath).mtimeMs)

    const skillId = runInTransaction(db, () => {
      const id = upsertSkill(db, skillName, destPath)
      upsertSource(db, id, destPath, hash, mtime, 'central-repo')
      return id
    })

    return {
      skillName,
      skillId,
      sourcePath: destPath,
      sourceType: 'central-repo',
      repoUrl: null,
      commitSha: null,
      overwritten
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

/**
 * 从本地目录安装 skill(索引模式,不搬文件)。
 * 幂等:同路径重复 upsert 不重复创建(ON CONFLICT 更新)。
 * opts 接收以保持三个 install 函数签名一致(索引模式无备份需求)。
 */
export function installFromLocalDir(
  db: DB,
  localPath: string,
  opts: InstallOptions
): InstallResult {
  void opts // 索引模式:不搬文件、不需要 centralSkillsDir / backupsDir
  const skillName = resolveSkillName(localPath)
  const hash = hashDir(localPath)
  const mtime = Math.floor(statSync(localPath).mtimeMs)

  const skillId = runInTransaction(db, () => {
    const id = upsertSkill(db, skillName, localPath)
    upsertSource(db, id, localPath, hash, mtime, 'indexed')
    return id
  })

  return {
    skillName,
    skillId,
    sourcePath: localPath,
    sourceType: 'indexed',
    repoUrl: null,
    commitSha: null,
    overwritten: false
  }
}
