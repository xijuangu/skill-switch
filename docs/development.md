# 开发文档

本文档面向开发者和贡献者，记录 skill-switch 的架构、领域模型、技术栈与历史 issue 索引。面向用户的安装、整理、部署与恢复说明见 [user-guide.md](./user-guide.md)；领域语言定义见 [CONTEXT.md](../CONTEXT.md)。

## 技术栈

- Electron + electron-vite
- React 18 + TypeScript 5 + Tailwind CSS
- better-sqlite3（主进程，原生依赖）
- electron-builder（打包）

## 核心流程

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

## 范围（MVP）

- 扫描多个工具目录的 Skill，包括未受管理的有效目录软链接；链接别名会发现权威真实 Source 并登记为只读 Observed Subscription，只有在显式接管后才成为受管 Deployment；受管目标不重复导入（不为已存在 Skill 移动文件）。
- 使用 `~/.skill-switch/skills` 作为固定 Canonical Repository；外部注册根与工具扫描产生 Candidate Source。
- 注册外部 Candidate Source 目录，递归发现多个 Skill，重新扫描或分离元数据而不删除源文件。
- 从 GitHub 仓库（含 subpath）、ZIP 或本地目录安装新 Skill 到 Canonical Repository；本地安装复制内容，原目录保持不变。
- 单项或批量部署，默认 `symlink`，可选 `copy` 或 Windows `junction`；任何 link→copy 降级都需确认。
- 按目标工具批量取消部署和批量从注册表移除，逐项结果可重试。
- 稳定的 Source / Discovery Target / Deployment 身份；renderer mutation 调用绝不提交路径。
- Deployment manifest + 每 Deployment 权威检查，包括待恢复的崩溃证据。
- 外部内容覆盖、已修改目标和模式降级的聚合确认。
- 每 Target mutation lock + staging / rollback / manifest-last 补偿。
- 备份系统含轮转。
- 跨平台：macOS + Windows + Linux。

## 不在范围内（MVP）

- Provider/API 配置管理（cc-switch 的核心功能，不在本仓库）。
- MCP / Prompts / Sessions 管理。
- Smithery registry 原生集成。
- Skill 更新检查。
- GitHub 仓库浏览器 UI。
- Deep Link 导入。
- 云同步 / WebDAV / 系统托盘。
- CLI / TUI 形态。

## 设计原则

- SSOT：内容以权威目录为准，身份与部署关系以中央 SQLite 为准。
- 双层存储：可同步数据在 SQLite，设备设置在 JSON。
- 原子写入：临时文件 + rename。
- Path-free renderer mutation：只提交语义 ID。
- Manifest-last 文件系统事务，含显式恢复证据。
- Mutex 保护的 DB 连接。
- 分层架构：Commands → Services → DAO → Database。
- 最小侵入：卸载 skill-switch 不破坏工具 Skill 目录。

## 原生依赖与平台打包

`better-sqlite3` 是原生依赖，Node/Vitest 与 Electron 使用不同 ABI。二者共享同一个
`build/Release/better_sqlite3.node` 产物，因此必须显式区分准备时机，避免互相污染。

### issue #64：macOS verify exit 139 根因与修复边界

**根因**：原先 `postinstall: electron-builder install-app-deps` 在 `npm ci` 阶段为
Electron 重建 better-sqlite3，把原生二进制切到 Electron ABI。随后 `npm test` 中的
`native:node` 再切回 Node ABI，但两步共享同一产物路径，残留的 Electron-ABI 二进制被
Node 运行时加载时触发段错误（exit 139），表现为 macOS verify 间歇性失败。

**修复边界**：

- 移除 `postinstall`，install 阶段不再为 Electron 重建原生模块。`npm ci` 后二进制保持
  better-sqlite3 自带 install 脚本下载的 Node ABI，verify 不再被 Electron ABI 污染。
- `native:node` 在 `npm rebuild better-sqlite3` 前清除 `node_modules/better-sqlite3/build`，
  确保任何 stale Electron-ABI 产物都不会存活到 Node 测试，使准备流程从干净状态可复现。
- `native:electron` 继续使用 `electron-rebuild -f` 强制为 Electron 重建。
- 每条工作流显式准备自身所需 ABI，互不污染：

| 命令 | 准备的 ABI | 说明 |
| --- | --- | --- |
| `npm test` / `npm run test:watch` | Node | 先 `native:node`，再跑 vitest |
| `npm run dev` / `npm start` | Electron | 先 `native:electron`，再启动 Electron |
| `npm run build:electron` / `npm run package:*` | Electron | 先 `native:electron`，再构建/打包 |
| `npm run build` / `npm run verify` | 无 | 只做 vite 打包，不加载原生模块 |
| `npm ci` | Node | better-sqlite3 自带 install 脚本下载 Node 预编译 |

若 `better_sqlite3.node` 报 `NODE_MODULE_VERSION` 不匹配，运行对应的原生准备命令
（`native:node` 或 `native:electron`），而不是重装仓库。`native:node` 会先清除残留
二进制再重建，因此本地切换 dev/test 顺序也不会留下错误 ABI 的产物。

平台特定打包命令：

- `npm run package:mac` → DMG
- `npm run package:win` → NSIS 安装包
- `npm run package:linux` → AppImage 和 DEB

正式版本的版本号、Release Notes、tag、三平台 CI、Draft Release 与人工发布顺序统一记录在根目录 [RELEASING.md](../RELEASING.md)。发布流程不得从历史 issue 或旧版本说明中推断。

## 测试与手工验收

- 测试接缝与策略见仓库根的 `vitest.workspace.ts`：`node` 环境（主进程领域）与 `jsdom` 环境（renderer 行为）。
- 手工验收清单见 [manual-qa.md](./manual-qa.md)，覆盖技能、部署与工具、权威库整理生命周期、备份与构建。
- 最终 macOS 人工查看没有固定步骤或通过规则；自动测试不替代用户的发布判断。

## 历史 issue 索引

skill-switch 的产品化历史以 issue 为单位推进；以下是主要里程碑，便于贡献者理解当前能力来源而不必回溯全部提交：

- MVP PRD：[issue #1](https://github.com/xijuangu/skill-switch/issues/1)
- MVP Slices：[issues #2–#10](https://github.com/xijuangu/skill-switch/issues)
- UI 可用性与浅色视觉系统升级 PRD：[issue #29](https://github.com/xijuangu/skill-switch/issues/29)
- UI 升级 Slices：[issues #30–#34](https://github.com/xijuangu/skill-switch/issues)
- Review 后修复与增强：[issues #52–#62](https://github.com/xijuangu/skill-switch/issues)（白屏、滚动条、Skeleton 静态化、ADR 0002 分层落实、来源按 hash 分组展示等）
- Deployment 生命周期深模块：[issues #69–#78](https://github.com/xijuangu/skill-switch/issues)（稳定语义 ID、Facade、聚合确认、目标锁、可补偿文件系统事务与 contract 收口）
- 权威源码库整理生命周期 PRD：[issue #81](https://github.com/xijuangu/skill-switch/issues/81)
- 整理生命周期 Slices：[issues #82–#92](https://github.com/xijuangu/skill-switch/issues)（候选/权威身份与 SkillLibraryFacade、全局一键接管、可撤销整理与原子批次、批量选择与去重、版本冲突与另存、权威版本替换与 copy 漂移、Source Archive 历史与永久清理、可撤销 Source Relocation、Source Recovery、仅权威 Source 可部署）
- 安装、批量部署与安全移除工作流：[issue #97](https://github.com/xijuangu/skill-switch/issues/97)
- 公开 v1.0 产品化与发布规格：[issue #114](https://github.com/xijuangu/skill-switch/issues/114)
- 建立最小开源仓库信任面：[issue #118](https://github.com/xijuangu/skill-switch/issues/118)

## ADR

架构决策记录位于 `docs/adr/`：

- [ADR 0001 技能 master-detail 布局](./adr/0001-skills-master-detail-layout.md)
- [ADR 0002 renderer 功能边界](./adr/0002-renderer-feature-boundaries.md)
- [ADR 0003 Deployment 生命周期深模块](./adr/0003-deployment-lifecycle-module.md)
- [ADR 0004 权威库整理生命周期](./adr/0004-canonical-library-lifecycle.md)
