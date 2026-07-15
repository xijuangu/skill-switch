# Deployment 生命周期收归一个深模块

Deployment 的资格判断、确认、模式降级、目标互斥、文件系统补偿、清单更新和单个 Deployment 漂移规则统一收归主进程中的深模块；IPC/preload 只作为传输适配器，renderer 只提交 Source、Discovery Target、Deployment 等语义 ID 并呈现结构化结果。模块采用面向当前 GUI 的 Facade（deploy、confirm、redeploy、undeploy、inspect），而不采用通用 command bus 或一次替换多个订阅的声明式 Engine，因为命名入口让常见调用最直接，同时避免在尚无需求时引入多目标锁与跨目标补偿。

## Consequences

- Discovery Target 获得稳定 ID，Deployment 以 Source ID 和 Discovery Target ID 保存权威关系；路径只保留为内部解析结果和迁移证据。
- 外部覆盖与模式降级合并为一次限时、单次 Deployment Confirmation，确认后执行前必须重新校验计划。
- 同一 Discovery Target 上的 mutation 互斥，不同目标可以并行；进程内失败执行补偿，崩溃后只报告 Recovery-required Deployment，不自动猜测恢复方向。
- 预期业务分支返回结构化结果，只有数据库损坏、未知文件系统错误或不变量破坏等非预期故障才抛异常。
- Contract 阶段删除旧 `prepareDeploy`、路径型 deploy/redeploy/undeploy/drift 接口和 IPC confirmation map；底层文件系统执行器只接受 Facade 已解析、已确认的计划，renderer 的 deploy/confirm/redeploy/undeploy 只提交语义 ID。
- Source ID 与 Discovery Target ID 必须成对解析；未能精确迁移的旧 Deployment 保持成对为空并显示 `unresolved`，禁止半解析状态。
- 身份索引与 trigger 必须在旧表补列/重建后安装；删除已引用 Source 时 Deployment 原子回到成对 `unresolved`，避免扫描清理被约束阻断。
- redeploy、undeploy、单个 inspect 和删除 Skill 时的级联取消部署均经过同一 Facade，不允许 registry 或读取流程绕过生命周期规则。
