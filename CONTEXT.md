# Skill Management

skill-switch 管理 skill 的内容来源，以及这些内容被派生到各 AI 编码工具后的部署关系。

## Language

**Skill**:
以名称识别的可管理内容单元，可以有一个或多个 Source，以及零个或多个 Deployment。

**Source**:
Skill 内容的权威来源位置，Deployment 从 Source 派生。
_Avoid_: Deployment target, deployed copy

**Deployment**:
Source 与 Discovery Target 之间持久登记的关系总称，以 management 区分 Managed Deployment 与 Observed Subscription。Deployment ID 是这条持久关系的标识。目标缺失或异常不会让关系自动消失。
_Avoid_: Source, installation

**Managed Deployment（受管部署）**:
已授权 skill-switch 变更的 Deployment。只有它可以重新部署、取消部署或参与覆盖流程。
_Avoid_: Observed Subscription, external link

**Observed Subscription（外部订阅）**:
扫描在 Discovery Target 中观察到的外部目录链接。它记录 Source 到目标的现实关系，但不授权 skill-switch 重新部署、取消部署或覆盖文件；必须显式接管后才转换为 Managed Deployment。
_Avoid_: Managed Deployment, managed link

**Adopt（接管）**:
用户对一条仍精确指向登记 Source 的 Observed Subscription 作出的显式授权。请求只提交 Deployment ID，主进程重新校验后仅转换管理权，不重建链接或修改内容。
_Avoid_: automatic import, overwrite confirmation

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
