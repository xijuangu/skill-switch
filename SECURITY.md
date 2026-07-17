# 安全策略 / Security Policy

## 报告漏洞（中文）

感谢你帮助提升 skill-switch 的安全性。请在公开披露前通过以下私密渠道报告漏洞：

- 在 GitHub 仓库使用 **Security Advisories**（`Security` 标签页 → `Report a vulnerability`）提交报告；或
- 发送邮件至 `xijuangu@users.noreply.github.com`，标题以 `[security] skill-switch` 开头。

请在报告中说明：

- 受影响的 skill-switch 版本与操作系统；
- 复现步骤与最小示例；
- 你评估的影响范围与建议修复方向。

我们会在合理时间内确认接收并评估。在你我商定的修复发布前，请勿公开披露漏洞细节。我们不提供漏洞赏金，但会在修复公告中致谢（除非你要求匿名）。

**范围**：skill-switch 桌面应用本身的缺陷。请勿报告以下内容：对未签名安装包的系统警告本身（这是已知的未签名状态，见 README）；通过已具备本机权限的恶意程序进行的本地提权；对第三方依赖的上游漏洞（请直接报告给上游项目，我们会跟进升级）。

## Reporting a vulnerability (English)

Please report security issues **privately before public disclosure**:

- Open a GitHub **Security Advisory** on the repository (`Security` tab → `Report a vulnerability`); or
- Email `xijuangu@users.noreply.github.com` with a `[security] skill-switch` subject.

Include the affected skill-switch version, OS, reproduction steps, a minimal example, and your assessment of impact. We will acknowledge receipt in a reasonable timeframe and coordinate a fix before any public disclosure. No bug bounty is offered; contributors are credited in the fix advisory unless they request anonymity.

**In scope**: vulnerabilities in the skill-switch desktop application itself. **Out of scope**: system prompts caused by the unsigned/un-notarized release artifacts (a known state, see README); local privilege escalation via malware that already has user-level access; upstream bugs in third-party dependencies (report those upstream; we will track and upgrade).

## 已知安全状态

- skill-switch 的发布安装包**未签名、未公证**。首次启动时 macOS Gatekeeper 或 Windows SmartScreen 会拦截，需要用户手动放行（见 README 的「下载与指南」）。这不是漏洞，而是发布成本决定的已知状态。
- 应用不内置自动更新、不进行后台联网检查；版本升级由用户从 GitHub Releases 手动下载。
