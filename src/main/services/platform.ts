// platform 服务:检测平台能力(platform / canSymlink / canJunction)
//
// canSymlink 通过在给定 testDir 下尝试创建临时符号链接来探测,失败则 false。
// canJunction 仅 win32 为 true(junction 是 Windows 专有特性)。
// 真正的探测逻辑抽取成纯函数,接受 testDir 参数,便于测试用临时目录替换 os.tmpdir()。

import { writeFileSync, symlinkSync, unlinkSync } from 'fs'
import { join } from 'path'
import type { PlatformInfo } from '../types'

const PROBE_SRC = 'platform-probe-src.txt'
const PROBE_LINK = 'platform-probe-link.txt'

/**
 * 检测平台能力。在 testDir 下尝试创建符号链接来判断 canSymlink。
 * @param testDir 可写目录(生产环境用 os.tmpdir(),测试用临时目录)
 */
export function detectPlatform(testDir: string): PlatformInfo {
  const platform = process.platform
  const canSymlink = probeSymlink(testDir)
  const canJunction = platform === 'win32'
  return { platform, canSymlink, canJunction }
}

/** 在 testDir 下尝试创建符号链接;成功返回 true 并清理临时文件,失败返回 false */
function probeSymlink(testDir: string): boolean {
  const src = join(testDir, PROBE_SRC)
  const link = join(testDir, PROBE_LINK)
  try {
    writeFileSync(src, '')
    symlinkSync(src, link)
    return true
  } catch {
    return false
  } finally {
    try {
      unlinkSync(link)
    } catch {
      // 链接未创建或已清理
    }
    try {
      unlinkSync(src)
    } catch {
      // 源文件未创建或已清理
    }
  }
}
