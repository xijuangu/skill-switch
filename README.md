# skill-switch

A standalone GUI tool to manage AI coding tool skills (TRAE / Codex / Claude Code / Agents / Gemini CLI) — scan, index, install, and deploy via copy or symlink.

## Why

Modern AI coding tools each maintain their own local skill directory (`~/.trae-cn/skills`, `~/.codex/skills`, `~/.claude/skills`, etc.). As a user of multiple tools, keeping skills in sync across them is manual, error-prone, and opaque. **skill-switch** is the central panel for all of them.

## Core Flow

```
Establish the fixed Canonical Repository (~/.skill-switch/skills)
         ↓
Register Candidate Source directories and scan tool dirs for legacy content and observed link subscriptions
         ↓
Index into the registry with an explicit canonical / candidate Source role
         ↓
User picks a skill → "Deploy to..."
         ↓
Pick a semantic Discovery Target + requested mode (copy / symlink / Windows junction)
         ↓
The Deployment Facade validates IDs, confirms all risks, stages and atomically switches files, then writes the manifest
         ↓
On next launch, manifest vs actual scan → drift status (✅ / ⚠️ / 🆕)
```

## Scope (MVP)

- Scan skills from multiple tool directories, including unmanaged valid directory symlinks; linked aliases discover the authoritative real Source and are recorded as read-only Observed Subscriptions. They become managed Deployments only after explicit adoption; managed targets are excluded from re-import (no file moving for existing skills)
- Use `~/.skill-switch/skills` as the fixed Canonical Repository; external registered roots and tool scans produce Candidate Sources
- Register external Candidate Source directories, recursively discover multiple Skills, rescan or detach metadata without deleting source files
- Install new skills from GitHub repo (single + subpath) or ZIP into the Canonical Repository; adding a local directory records a Candidate Source
- Deploy via copy / symlink / Windows junction; every linked-to-copy degradation requires confirmation
- Stable Source / Discovery Target / Deployment identities; renderer mutation calls never submit paths
- Deployment manifest + authoritative per-Deployment inspection, including recovery-required crash evidence
- Aggregated confirmation for external overwrite, modified targets, and mode degradation
- Per-target mutation lock plus staging / rollback / manifest-last compensation
- Backup system with rotation
- Cross-platform: macOS + Windows + Linux

## Tech Stack

- Electron + electron-vite
- React 18 + TypeScript 5 + Tailwind CSS
- better-sqlite3 (main process)
- electron-builder (packaging)

## Development

`better-sqlite3` is a native dependency. Node/Vitest and Electron use different
ABIs, so the npm scripts prepare the correct binary before each workflow:

```bash
# Test with the current Node runtime
npm test

# Typecheck, test, and build renderer/main bundles
npm run verify

# Run the Electron development app
npm run dev

# Build installers for the current operating system
npm run package
```

Use `npm run native:node` when running Node-based tools directly, and
`npm run native:electron` before invoking Electron outside the npm scripts.
If `better_sqlite3.node` reports `NODE_MODULE_VERSION` mismatch, run the
matching native preparation command instead of reinstalling the repository.

Platform-specific package commands:

- `npm run package:mac` → DMG
- `npm run package:win` → NSIS installer
- `npm run package:linux` → AppImage and DEB

## Status

Spec'd via `/grill-me` → `/to-prd` → `/to-issues`. See:
- MVP PRD: [issue #1](https://github.com/xijuangu/skill-switch/issues/1)
- MVP Slices: [issues #2–#10](https://github.com/xijuangu/skill-switch/issues)
- UI 可用性与浅色视觉系统升级 PRD: [issue #29](https://github.com/xijuangu/skill-switch/issues/29)
- UI 升级 Slices: [issues #30–#34](https://github.com/xijuangu/skill-switch/issues)
- Review 后修复与增强: [issues #52–#62](https://github.com/xijuangu/skill-switch/issues)（白屏、滚动条、Skeleton 静态化、ADR 0002 分层落实、来源按 hash 分组展示等）
- Deployment 生命周期深模块: [issues #69–#78](https://github.com/xijuangu/skill-switch/issues)（稳定语义 ID、Facade、聚合确认、目标锁、可补偿文件系统事务与 contract 收口）
- 权威源码库整理生命周期 PRD: [issue #81](https://github.com/xijuangu/skill-switch/issues/81)
- 整理生命周期 Slices: [issues #82–#92](https://github.com/xijuangu/skill-switch/issues)（候选/权威身份与 SkillLibraryFacade、全局一键接管、可撤销整理与原子批次、批量选择与去重、版本冲突与另存、权威版本替换与 copy 漂移、Source Archive 历史与永久清理、可撤销 Source Relocation、Source Recovery、仅权威 Source 可部署）。验收步骤见 [docs/manual-qa.md](docs/manual-qa.md)。

## Out of Scope (MVP)

- Provider/API config management (cc-switch's core feature — not here)
- MCP / Prompts / Sessions management
- Smithery registry native integration
- Skill update checking
- GitHub repo browser UI
- Deep Link import
- Batch deploy/undeploy
- Cloud sync / WebDAV / system tray
- CLI / TUI form

## Design Principles

Aligned with cc-switch's validated patterns:
- SSOT (authoritative content roots for files; central SQLite for identities and deployment relations)
- Dual-layer storage (SQLite for syncable, JSON for device settings)
- Atomic writes (temp file + rename)
- Path-free renderer mutations (semantic IDs only)
- Manifest-last filesystem transactions with explicit recovery evidence
- Mutex-protected DB connection
- Layered architecture (Commands → Services → DAO → Database)
- Minimal intrusion (uninstalling skill-switch doesn't break tool skill dirs)
