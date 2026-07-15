# MVP 手工验收清单

## 技能

- 扫描后，技能行显示 source 类型、source 数量和已部署工具。
- Discovery Target 中未受 manifest 管理、且指向有效 Skill 目录的软链接会导入为 observed symlink Deployment；Source 路径必须是 `realpath` 后的权威目录，link path 不得成为 Source。两个 Target 的 alias 指向同一目录时应显示一个 Source、两个订阅，且均可独立取消；copy / symlink / junction managed target 均不反向登记为 Source，broken link 与文件 link 被安全跳过且不中断整次扫描。
- 展开 Source 后，“发现时间”按当前系统本地时区显示，不直接展示 UTC `Z` 字符串。
- “安装”默认打开 GitHub 安装；“添加本地”直接打开本地目录页。
- 在“设置 → 权威源码库”登记一个包含多层目录和多个 `SKILL.md` 的 Root；系统递归发现每个真实 Skill，但不向任何工具自动写入文件。
- 对同一个 Root 重新扫描可发现新增 Skill；解除登记只删除注册元数据，Root 和 Skill 文件仍保留在磁盘。
- 从 Root 发现两个 Skill 后，只部署其中一个到选定 Discovery Target；未选择的 Skill 不应出现在该工具，取消单个订阅不删除 Source 或其他 Target 的订阅。
- 多 source 冲突时，部署和查看 SKILL.md 都要求选择具体 source。
- 多版本冲突时，详情列来源按 hash 分组渲染（版本 A / 版本 B 标题 + 来源数 + hash 短码），单版本保持平铺。
- 部署弹窗在冲突 skill 上显示当前所选 Source 所属版本组（组内来源数、hash 短码）与其他版本数量。
- 切换筛选时左侧 nav 固定不动；Skills 页只有列表区与详情区两个独立滚动条，无嵌套或页面整体滚动。

## 部署与工具

- 多路径工具的部署框以稳定 Discovery Target 分项展示，不把路径作为 mutation 参数回传。
- external 内容、已修改目标和模式降级在同一个中文确认框中聚合展示；取消后磁盘不变。
- 请求 symlink/junction 但只能使用 copy 时必须确认，不能静默降级。
- 同一 Discovery Target 快速重复操作时后到请求提示“目标正在执行其他部署操作”，其他 Target 不受影响。
- 模拟中断遗留 marker/staging/rollback 时显示“需要人工恢复”，不自动选择旧内容或新内容。
- 删除目标后点击“重新部署”会恢复目标。
- 修改 copy 目标、替换链接、删除 Source 时显示对应异常状态；Skills 与 Tools 页结果一致。
- 禁用工具不出现在“工具”页，但仍可在“设置”页重新启用。

## 备份

- 恢复已有目标前创建 safety-net。
- 保留数设为 1 时仍能完成恢复。
- 删除和恢复只作用于列表中的备份。

## 构建

- `npm run verify` 通过。
- `npm run dev` 能启动应用。
- 当前平台的 `npm run package:*` 能生成安装产物。
