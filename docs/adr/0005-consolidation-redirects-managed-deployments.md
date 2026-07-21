# 整理时原地迁移已锁定的受管部署

Consolidation Batch 在替换权威 Canonical 内容的同时，原地迁移已纳入批次的 Managed Deployment：symlink/junction 模式重定向到新权威路径，copy 模式按新权威内容重新部署。这一行为修正了 ADR 0004 中“整理与 Deployment 分离”的措辞——整理仍然不向工具创建新部署，但批次已通过 Durable Lock 独占这些目标路径，若任由受管部署继续指向被归档的旧 Candidate Source，清单（manifest 指向 canonical）与文件系统（目标指向旧 candidate）会立刻漂移，整理原子性也就失去了意义。

迁移只作用于批次已经锁定的现有 Managed Deployment 行，不创建、不删除 Deployment 记录，只把 `source_path` / `source_id` / `source_hash_at_deploy` UPDATE 到新权威 Source；Deployment Facade（ADR 0003）仍是 deploy / undeploy / redeploy 生命周期的唯一入口。Observed Subscription 属于发现关系，不在迁移范围，沿用既有“整理时从清单移除”的语义。前向迁移可补偿：symlink 模式按快照中的原始 `linkTarget` 恢复（保留相对链接为相对链接），copy 模式从批次内逐部署的 managed-backup 恢复；undo 补偿则在失败时把受管部署重建到整理完成态应指向的权威路径，避免清单存在但目标缺失的 drift。

## Consequences

- ADR 0004 “整理与 Deployment 分离”精确化为：整理不创建新部署，但原子迁移已锁定的受管部署到新权威路径；未锁定的 Observed Subscription 不受影响。
- Managed Deployment 的 `target_id` 与 `id` 在迁移中保持不变，Discovery Target 身份（ADR 0003）不被整理破坏。
- symlink/junction 迁移 = unlink 旧链接 + 重建指向新权威路径的链接；copy 迁移 = 备份旧内容到 `source_archive/<batch>/managed-backup/<deployment_id>` 后用新权威内容覆盖，供补偿回滚。
- 受管部署的 fs 迁移由 `redirectManagedDeployment(targetPath, mode, newSource)` 统一执行，整理的前向 redirect、补偿 rollback、undo restore、undo 补偿 rebuild 共用同一原语，避免四处分叉。
- 整理预检要求所有 Managed Deployment 目标存在且可访问（`pathEntryExists`），否则拒绝确认；这与 Observed Subscription 的“必须先接管或解除”一道构成整理前置条件。
- Deployment Facade 的 deploy / undeploy / redeploy / inspect 入口不感知整理迁移；用户随后通过 Facade 触发的 redeploy / undeploy 会看到已迁移到新权威路径的 Deployment，行为与普通受管部署一致。
