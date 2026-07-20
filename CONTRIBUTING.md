# 贡献指南 / Contributing

感谢你有兴趣为 skill-switch 贡献。下面是启动开发与提交变更的最小流程。

## 搭建开发环境（中文）

需要本地安装 Node.js 20 和 npm。`better-sqlite3` 是原生依赖，不同工作流需要不同的 ABI，仓库已通过 npm 脚本自动准备对应二进制。

```bash
# 安装依赖（better-sqlite3 自带 install 脚本下载 Node ABI；install 阶段不为 Electron 重建）
npm ci

# 启动 Electron 开发应用（会先重建 better-sqlite3 的 Electron ABI）
npm run dev
```

常用命令：

```bash
npm run typecheck   # TypeScript 类型检查（main + renderer）
npm test            # 重建 Node ABI 后运行 Vitest 全套测试
npm run verify      # typecheck + test + 构建 main/renderer 产物
npm run package     # 为当前平台构建安装包
```

> 若 `better_sqlite3.node` 报 `NODE_MODULE_VERSION` 不匹配，运行对应的 `npm run native:node`（Node 工具）或 `npm run native:electron`（Electron），而不是重装仓库。平台特定的打包命令见 [docs/development.md](docs/development.md)。

## 提交变更

1. 从最新基线创建分支：`git checkout -b <your-name>/<short-description>`。
2. 保持每个变更聚焦于单一目的；通过现有公共行为边界验证，不锁定组件拆分、CSS 实现细节或内部 SQL。
3. 提交信息用中文或英文均可，但请说明「为什么」而不仅是「做了什么」。
4. 推送分支并开启 Pull Request。在 PR 描述中关联相关 issue（如 `Closes #118`）。

我们不要求签署 CLA 或 DCO。提交即表示你同意以 MIT 协议发布你的贡献。

## 代码与测试约定

- 领域语言见 [CONTEXT.md](CONTEXT.md)；新增概念前请先确认是否已有等价术语。
- 测试只验证通过公共边界可观察到的行为；不要为内部实现细节写脆弱快照。
- 主进程领域测试通过真实临时 SQLite 与临时文件系统运行；renderer 测试渲染真实页面或对话框，只 mock preload 暴露的 `window.api`。
- 不引入 Contributor Covenant、Issue Forms、PR 模板、CLA、DCO 或复杂治理流程。

更多架构、流程与历史 issue 索引见 [docs/development.md](docs/development.md)。维护者准备正式版本时，请严格遵循根目录的 [RELEASING.md](RELEASING.md)。

## Getting started (English)

You need Node.js 20 and npm. `better-sqlite3` is a native dependency whose ABI differs between Node and Electron; the npm scripts rebuild the correct binary for each workflow.

```bash
npm ci            # install deps (better-sqlite3 ships a Node-ABI binary via its own install script; no Electron rebuild at install time)
npm run dev       # launch the Electron dev app (rebuilds Electron ABI first)
npm run verify    # typecheck + tests + build main/renderer bundles
```

Open a Pull Request against the baseline branch, reference the related issue, and explain the *why* in your commit message. No CLA or DCO is required; contributions are licensed under MIT. See [docs/development.md](docs/development.md) for architecture and the historical issue index, and [RELEASING.md](RELEASING.md) for the maintainer release checklist.
