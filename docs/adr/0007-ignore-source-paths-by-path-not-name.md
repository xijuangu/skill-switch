# 忽略名单按路径而非按名称

## 背景

从注册表移除的 Skill 会在下次扫描（启动扫描或手动扫描）时确定性复活：`removeFromRegistry` 无痕硬删 `skills` / `skill_sources` / `deployments` 行，但不删除工具目录与 Source Root 里的来源文件，而扫描发现环节按名称 upsert，唯一的跳过机制（`buildSkipPaths`）只覆盖受管部署目标。

修复方向有两个候选：

1. **按名称忽略**：移除时记录 Skill 名，扫描跳过同名 Skill。问题是名称维度会误伤——不同目录下同名 Skill 语义上未必是同一个（扫描本就按名称 upsert 合并来源），且用户无法分辨"哪个同名 Skill 被忽略了"，排查困难。
2. **按路径忽略**：移除时把该 Skill 中央仓库外的来源路径逐条登记进忽略名单，扫描发现环节按路径跳过。条目由系统在移除时批量登记，用户无逐条维护负担。

## 决策

采用**按路径忽略**，新增 `ignored_source_paths` 表（path 主键，realpath 归一；skill_name、created_at 为辅）：

1. **登记时机唯一**：仅在 `removeFromRegistry`（含批量链路汇入的同一函数）且用户勾选「忽略这些来源目录」时登记，只覆盖 Canonical Repository 外的来源路径。中央仓库实体随移除删除，无需忽略。
2. **消费点在发现环节**：`scanToolDir`（经 `scanAllTools`）与 `rescanSourceRoot` 在发现阶段按 realpath 匹配跳过；忽略路径不进入 upsert，也不进入扫描结果。
3. **显式登记优先，维持不共存不变量**：`upsertSource` 对任何登记路径删除同路径忽略行——「已登记」与「被忽略」永不共存。这条不变量使 `reconcileIndexedSources` 无需特判：被忽略的路径在注册表中没有行，reconcile 的自然清理逻辑不会触碰它。
4. **解除入口**：恢复页「忽略目录」标签逐条解除；解除后下次扫描正常登记。

## Consequences

- 忽略是路径级的：同一 Skill 名的其他来源目录不受影响，消除了名称维度的误伤。
- realpath 归一（存在时取 `realpathSync.native`，已删除路径退化为 `resolve`）保证符号链接变体（如 macOS `/var` → `/private/var`、目录链接部署）匹配一致。
- 忽略条目只在显式登记（任何走 `upsertSource` 的链路：扫描解除后、Source Root 登记、安装等）或用户手动解除时消失，扫描本身不消费忽略条目。
- 移除对话框（单个与批量）默认勾选忽略，用户需主动取消才能回到旧的"移除后可复活"行为。

## 测试

- `tests/ignored-source-paths.test.ts`：DAO 归一/幂等/解除、`removeFromRegistry` 只登记仓库外路径、`upsertSource` 自动解除、`scanAllTools` 与 `rescanSourceRoot` 跳过。
- `tests/renderer/removeRegistryIgnore.test.tsx`：两个移除入口的勾选默认态与传参。
- `tests/renderer/recoveryIgnoredPaths.test.tsx`：恢复页「忽略目录」标签的列表与解除。
