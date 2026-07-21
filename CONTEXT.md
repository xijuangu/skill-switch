# Skill Management

skill-switch 管理 skill 的内容来源，以及这些内容被派生到各 AI 编码工具后的部署关系。

## Language

**Skill**:
以名称识别的可管理内容单元，可以有一个或多个 Source，以及零个或多个 Deployment。

**Source**:
Skill 在 Canonical Repository 中的唯一权威内容位置，Deployment 只能从 Source 派生。Source 的 Canonical Placement 是稳定地址，其权威内容可经显式的 Consolidation 被新版本替换。
_Avoid_: Deployment target, deployed copy

**Candidate Source（候选来源）**:
从权威源码库之外发现的可整理 Skill 内容位置。它可以被查看、比较、去重和选择，但在整理成为 Source 前不能用于新建 Deployment。
_Avoid_: Source, Deployment target, automatically trusted content

**Canonical Repository（权威源码库）**:
skill-switch 管理的唯一整理目的地。每个已整理 Skill 在其中只有一个权威 Source，其他目录只能作为待整理内容的发现入口或 Deployment 目标。
_Avoid_: Discovery Target, Source Archive, multiple canonical roots

**Canonical Placement（权威存放位置）**:
用户为待整理 Skill 选择的 Canonical Repository 内相对父目录，最终目录名仍由 Skill 名称决定。位置必须保持在 Canonical Repository 边界内；存放层级不改变 Skill 身份或其部署名称。已建立的 Canonical Placement 在版本替换时保持不变，因此现有链接无需重写即可使用新内容。
_Avoid_: Skill rename, Deployment target, absolute destination path

**Source Relocation（移动权威 Source）**:
在不改变 Skill 身份和内容的前提下，将 Source 移到 Canonical Repository 内的新 Canonical Placement，并原子更新所有受管链接。它是独立于 Consolidation 和版本替换的显式用户操作。任一 Observed Subscription 仍引用该 Source 时禁止移动，必须先接管或由用户移除；移动不得留下已知断链。操作记录永久保留，旧位置、内容和订阅仍满足安全条件时可整体撤销；移动不为未变内容创建 Source Archive 副本。
_Avoid_: version replacement, Skill rename, consolidation

**Consolidation（整理）**:
用户选择 Candidate Source 并解决去重或版本冲突后，将其归并到 Canonical Repository 中指定位置，使每个已整理 Skill 只保留权威 Source。原 Candidate Source 从原位置移除必须可恢复。整理不创建 Deployment；批次已通过 Durable Lock 独占的 Managed Deployment 会被原子迁移到新权威 Source（只 UPDATE 现有记录的指向，不创建或删除 Deployment 记录），避免清单与文件系统漂移。用户之后另行将权威 Source 手动部署到选定的 Discovery Target。完整性承诺仅覆盖已登记关系和已配置 Discovery Target；系统不全盘搜索未知引用，也不在原位置留下兼容链接。
_Avoid_: scan, adoption, deployment, irreversible deletion

**Source Archive（来源归档区）**:
由 skill-switch 管理的可恢复保留区。整理移除的原 Candidate Source 按 Consolidation Batch 默认永久保留，并记录原始位置；只有用户对指定批次另行确认永久清理后才失去恢复能力，不存在自动过期或扫描清理。恢复时若原位置已被占用，必须停止并报告冲突。
_Avoid_: backup copy, system trash, permanent deletion

**Consolidation Batch（整理批次）**:
一次整理中经用户确认的完整变更集合，包含权威 Source 的建立、原 Candidate Source 的归档，以及指向这些旧来源的已知工具条目移除。它不创建后续 Deployment，相关工具可以暂时缺少这些 Skill，直到用户另行手动部署。批次必须整体成功；任一步骤失败时停止并整批回滚。若自动回滚未能完成，批次进入待恢复状态并保留现场，不将部分成功当作正常结果。恢复以整个批次为边界。
_Avoid_: scan result, deployment request, partial cleanup

**Conflict Resolution（冲突解决）**:
整理时对同名但内容不同的 Candidate Source 作出的显式选择：选定一个权威版本，并将其他版本归档或另存为不同 Skill。另存时新名称同时成为 Skill 身份与最终目录名，且不能与已有 Skill 冲突。系统按内容版本分组并提供差异依据，但不自动选择或合并不同内容；未解决所有冲突前，Consolidation Batch 不能执行。
_Avoid_: deduplication, primary-source guess, automatic merge

**Deployment**:
Source 与 Discovery Target 之间持久登记的关系总称，以 management 区分 Managed Deployment 与 Observed Subscription。Deployment ID 是这条持久关系的标识。目标缺失或异常不会让关系自动消失。
_Avoid_: Source, installation

**Managed Deployment（受管部署）**:
已授权 skill-switch 变更的 Deployment。只有它可以重新部署、取消部署或参与覆盖流程。
_Avoid_: Observed Subscription, external link

**Copy Deployment（副本部署）**:
从权威 Source 派生的独立内容快照，不是第二个权威来源。Source 或副本任一侧变化都会产生漂移；系统不自动双向同步。目标侧修改只能经确认后被权威内容覆盖，或保留为 Candidate Source 参与冲突解决。
_Avoid_: Source, synchronized replica, automatic reverse sync

**Observed Subscription（外部订阅）**:
扫描在 Discovery Target 中观察到的外部目录链接。它记录 Source 到目标的现实关系，但不授权 skill-switch 重新部署、取消部署或覆盖文件；必须显式接管后才转换为 Managed Deployment。
_Avoid_: Managed Deployment, managed link

**Adopt（接管）**:
用户对一条仍精确指向登记 Source 的 Observed Subscription 作出的显式授权。请求只提交 Deployment ID，主进程重新校验后仅转换管理权，不重建链接或修改内容。
_Avoid_: automatic import, overwrite confirmation

**Bulk Adoption（一键接管）**:
用户对所有已配置 Discovery Target 中当前登记的 Observed Subscription 作出的一次全局批量授权。执行前必须展示按工具分组的完整清单和数量；单条 Adopt 仍然保留。主进程对每条关系重新校验，有效项独立接管，失效项保持 Observed 并在结果中报告；单条失败不回滚已成功项。Bulk Adoption 不修改文件或链接，也不属于 Consolidation。
_Avoid_: current-tool action, filtered selection, consolidation

**Deployed Skill（已部署 Skill）**:
至少存在一个 Managed Deployment 的 Skill，不要求部署目标当前健康或存在；仅有 Observed Subscription 不算已部署。
_Avoid_: Healthy skill, installed skill

**Discovery Target（发现目标）**:
AI 编码工具用于发现 Skill 的已配置目录。一个 Deployment 只指向一个 Discovery Target，同一工具可以拥有多个 Discovery Target。
_Avoid_: Tool path, target root, Deployment

**Deployment Request（部署请求）**:
用户选择一个 Source、一个 Discovery Target 和期望模式后提出的派生请求。请求不包含或授权任意文件系统路径。
_Avoid_: Deployment, file operation

**Deployment Confirmation（部署确认）**:
用户对某一个完整且仍有效的 Deployment Request 风险计划所作的一次性授权，可同时包含外部内容覆盖和模式降级。
_Avoid_: Overwrite flag, reusable permission

**Path-free Mutation（无路径变更请求）**:
renderer 发起 Deployment 变更时只提交 Source ID、Discovery Target ID、Deployment ID 或 Confirmation ID；路径、平台能力、覆盖标记和备份位置均由主进程 Facade 解析。
_Avoid_: Path DTO, renderer-side deployment plan

**Recovery-required Deployment（待恢复部署）**:
部署操作中断或补偿失败后，无法安全自动判断应保留哪一侧内容的 Deployment 状态，需要用户检查、重试或从备份恢复。
_Avoid_: Drift, automatic rollback

**Source Recovery（权威来源恢复）**:
权威 Source 缺失或不可读时的显式恢复流程。相关变更先被冻结；系统收集 Source Archive、历史权威版本、Copy Deployment 和用户指定目录作为恢复候选，按内容与最后已知哈希分类，但不自动选择或反向提升任一副本。用户选定版本后恢复到原 Canonical Placement，再重新评估所有 Deployment。
_Avoid_: automatic copy promotion, deployment recovery, new placement
