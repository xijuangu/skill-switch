# registered-candidate drift kind 与 ToolsPage 入口简化

## 背景

issue #127 在工具页为外部 skill 分组加了"纳入管理 (触发全量扫描)"按钮和多选 checkbox，意图是让用户在部署关系视图就地登记外部 skill。但 `handleBulkManage` 复用了 `window.api.scan()`（全量 `scanAllTools`），与 SkillsPage 顶部的"扫描"按钮走同一后端，且 Dialog 文案声明"此操作是全量扫描，不限于所选条目"——选中条目仅作为参考列在下方，不影响实际扫描范围。

同时 `readToolDrifts` 只读 `deployments` 表，不检查 `skill_sources` 表。即使用户通过 SkillsPage 扫描成功把外部 skill 登记为 candidate source，工具页该 skill 仍显示 `kind: 'external'`（标签"未管理"），让用户误以为登记没生效。这违背 ADR 0002 的读模型一致性：同一 skill 在 Skills 页能看到候选来源、在 Tools 页却显示"未管理"，两页对"外部 skill 是否已被系统感知"给出矛盾答案。

## 决策

1. **DriftKind 联合类型扩展**：新增 `registered-candidate`，区分"清单无记录且未登记 candidate source 的外部 skill"（`external`）与"清单无记录但已被 scan 登记为 candidate source 的外部 skill"（`registered-candidate`）。两者都不在 `deployments` 清单中，区别只在于系统是否已知它。

2. **`readToolDrifts` 读模型行为变化**：从只查 `deployments` 表扩展为跨表查询 `deployments` + `skill_sources`。对清单无记录的目标目录，用 `getSourceByPath(db, targetPath)`（symlink 再用 `realpathSync(targetPath)` 兜底）查 `skill_sources` 表，若 `source_role === 'candidate'` 则返回 `kind: 'registered-candidate'`，否则保持 `external`。这让 scan 登记的 candidate source 在工具页可见，消除两页读模型不一致。

3. **移除 ToolsPage 冗余入口**：移除"登记候选 (触发全量扫描)"按钮、`handleBulkManage`、Dialog、`bulkManageConfirm` state、`onBulkManage` prop 链，以及 external 分组的多选 checkbox（按钮移除后多选无操作可触发，保留只会留下空白操作栏）。外部 skill 分组仍保留展示，扫描统一走 SkillsPage 的"扫描"按钮或 app 启动时的 `runStartupSequence`。

## Consequences

- `DriftKind` / `DriftKindView` 联合类型新增 `registered-candidate` 成员，所有 drift kind 的消费者（读模型、UI 标签、类型声明）须同步。
- `readToolDrifts` 不再是纯 `deployments` 表读模型；它跨表查询 `skill_sources`，但仍是只读操作，不改 DB 状态，ADR 0003 的 Deployment Facade 写入边界不受影响。
- external 分组在工具页仍展示，但失去多选能力；managed / observed 分组的多选批量操作不受影响。
- SkillsPage 的"扫描"按钮成为 app 运行期间手动触发 `scanAllTools` 的唯一入口；启动时 `runStartupSequence` 自动扫描一次（ADR 0004 的 Discovery Target 概念不变）。
- 用户若在 app 运行期间往工具目录塞新外部 skill 并希望就地登记，需切到 Skills 页点"扫描"再回 Tools 页刷新——这是显式两步操作，换取消除"选中 N 条但不影响扫描范围"的语义矛盾。
- ADR 0002 的"读模型一致性"原则得到加强：同一事实（candidate source 已登记）在 Skills 页和 Tools 页的读模型中一致可见。

## 测试

- `tests/scan-drift-feedback.test.ts`：验证 scan 登记候选来源后，`readToolDrifts` 返回 `kind: 'registered-candidate'`，且 `skill_sources.source_role === 'candidate'`。
- `tests/renderer/App.test.tsx`：移除"登记候选 (触发全量扫描)"按钮的相关断言和测试用例；保留 managed / observed 多选批量的测试。
