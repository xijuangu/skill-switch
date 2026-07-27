# 发布指南 / Releasing

本文档是 skill-switch 维护者的正式发版清单。普通代码提交不需要更新版本；只有准备一个新的 GitHub Release 时才执行以下流程。

## 每个版本只手动维护三项

1. **版本号**：使用 npm 同时更新 `package.json` 和 `package-lock.json`。

   ```bash
   npm version <version> --no-git-tag-version
   ```

   版本号必须为纯数字语义版本（如 `1.2.0`），不支持 pre-release 后缀（如 `-rc.1`），由 `tests/release-contract.test.ts` 强制。

2. **版本说明**：新增 `docs/release-notes/v<version>.md`。保留旧版本文件，不要覆盖。内容至少包括中文发布说明、3–5 条英文摘要、支持平台、未签名/未公证状态、联网边界和已知限制。
3. **Git tag**：合并后的最终提交通过三平台 CI 后创建与 package version 完全一致的 tag。

   ```bash
   git tag v<version>
   git push origin v<version>
   ```

不需要为每个版本修改 `.github/workflows/ci.yml` 或 `tests/release-contract.test.ts`：工作流和发布合同会从 `package.json.version` 自动解析对应的 Release Notes。

## 发布步骤

1. 确认工作树干净，并从拟发布提交执行：

   ```bash
   npm run verify
   ```

2. 完成上述版本号与 Release Notes 变更，提交并通过 Pull Request 合并到 `main`。
3. 等待同一 `main` 提交在 macOS、Windows、Linux 的 verify 全部通过。
4. 在该提交创建并推送 `v<version>` tag。tag 与 `package.json.version` 不一致时，CI 会拒绝发布。
5. tag 工作流在三个原生 runner 上生成安装包，并创建 **Draft Release**。它不会自动公开发布。
6. 核对 Draft Release：

   - macOS arm64 DMG、Windows x64 NSIS、Linux x64 AppImage 或 DEB 均存在且文件非空；
   - 文件名包含正确版本；
   - Release Notes、支持平台、联网边界和未签名提示正确；
   - 按维护者自己的方式检查实际安装包与界面。

7. **停在 Draft Release，等待维护者明确确认。不得直接公开发布。**确认后再在 GitHub 上手动选择 **Publish release**。

## 版本与更新检查

应用当前版本来自 `package.json`，检查更新会读取 GitHub Latest Release，不需要在代码中写入“最新版本”。只有仓库迁移或 GitHub 所有者/仓库名变化时，才需要同步修改更新检查地址、README 链接和相关安全校验；这不属于每次发版操作。

## English summary

For each release, maintain only three things: the package version, `docs/release-notes/v<version>.md`, and the matching `v<version>` tag. CI derives the notes path from `package.json.version`, validates all three platforms, and creates a Draft Release. Never publish that draft without explicit maintainer approval.
