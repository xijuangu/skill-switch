# 权威源码库生命周期收归一个深模块

> 注：“整理与 Deployment 分离”一条已由 [ADR 0005](0005-consolidation-redirects-managed-deployments.md) 精确化：整理仍不创建新部署，但会原子迁移已锁定的受管部署到新权威路径。

skill-switch 将 `~/.skill-switch/skills` 作为唯一 Canonical Repository：外部扫描目录只提供 Candidate Source，经用户选择、去重和冲突解决后才通过 Consolidation Batch 成为权威 Source。整理与 Deployment 分离：整理可替换稳定 Canonical Placement 上的内容，但不自动向工具创建新部署。

这些文件系统变更由独立的 Skill Library 生命周期深模块统一计划、确认、加锁、校验、补偿和恢复，而不分散在扫描、registry、backup 或 IPC 中。Consolidation Batch 选择整批成功或整批回滚，牺牲部分成功以换取可理解的单一事实来源；原 Candidate Source 按批次永久保留在 Source Archive，只有用户另行确认才能永久清理。若补偿失败，批次保留现场并进入待恢复状态，不自动猜测应保留哪一侧。

Source Relocation 和 Source Recovery 共享这一边界：移动会原子更新受管链接且被 Observed Subscription 阻塞；权威 Source 异常时，Copy Deployment 只能作为经用户显式选择的恢复候选，不允许自动反向提升或双向同步。
