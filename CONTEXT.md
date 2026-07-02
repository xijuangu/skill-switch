# Skill Management

skill-switch 管理 skill 的内容来源，以及这些内容被派生到各 AI 编码工具后的部署关系。

## Language

**Skill**:
以名称识别的可管理内容单元，可以有一个或多个 Source，以及零个或多个 Deployment。

**Source**:
Skill 内容的权威来源位置，Deployment 从 Source 派生。
_Avoid_: Deployment target, deployed copy

**Deployment**:
Skill 从某个 Source 派生到工具目标位置的已登记关系。目标缺失或异常不会让这段关系自动消失。
_Avoid_: Source, installation

**Deployed Skill（已部署 Skill）**:
至少存在一个 Deployment 的 Skill，不要求部署目标当前健康或存在。
_Avoid_: Healthy skill, installed skill
