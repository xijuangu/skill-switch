# skill-switch

A standalone GUI tool to manage AI coding tool skills (TRAE / Codex / Claude Code / Agents / Gemini CLI) — scan, index, install, and deploy via copy or symlink.

## Why

Modern AI coding tools each maintain their own local skill directory (`~/.trae-cn/skills`, `~/.codex/skills`, `~/.claude/skills`, etc.). As a user of multiple tools, keeping skills in sync across them is manual, error-prone, and opaque. **skill-switch** is the central panel for all of them.

## Core Flow

```
Scan each tool's skill dir (discover existing skills)
         ↓
Index into central registry (~/.skill-switch/ccswitch.db — hybrid: index-only for existing, central-repo for newly installed)
         ↓
User picks a skill → "Deploy to..."
         ↓
Pick target tool + mode (copy / symlink / Windows junction)
         ↓
skill-switch copies or symlinks the skill into the target tool dir, writes deployment manifest
         ↓
On next launch, manifest vs actual scan → drift status (✅ / ⚠️ / 🆕)
```

## Scope (MVP)

- Scan & index skills from multiple tool directories (no file moving for existing skills)
- Install new skills from GitHub repo (single + subpath), ZIP, or local directory
- Deploy via copy / symlink / Windows junction (with auto-degrade on Windows)
- Deployment manifest + drift detection (normal / drifted / external)
- Conflict handling: self-managed overwrite / external backup-then-overwrite / mode-switch cleanup
- Backup system with rotation
- Cross-platform: macOS + Windows

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
- PRD: [issue #1](https://github.com/xijuangu/skill-switch/issues/1)
- Slices: [issues #2–#10](https://github.com/xijuangu/skill-switch/issues)

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
- SSOT (central SQLite)
- Dual-layer storage (SQLite for syncable, JSON for device settings)
- Atomic writes (temp file + rename)
- Mutex-protected DB connection
- Layered architecture (Commands → Services → DAO → Database)
- Minimal intrusion (uninstalling skill-switch doesn't break tool skill dirs)
