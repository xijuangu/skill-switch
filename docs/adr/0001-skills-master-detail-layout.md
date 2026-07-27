# Skills 页采用 master–detail 布局

## Status

Accepted

## Context

Skills 页需要展示当前选中 skill 的来源、部署和详情，并在 skill 数量和元数据增长后仍能保持列表位置稳定、控制信息密度。

## Decision

Skills 页使用紧凑的可搜索、可筛选列表作为 master，并在固定 detail 区展示当前选中 skill 的来源、部署和详情。相比允许多行同时展开的 accordion，这一结构在 skill 数量和元数据增长后仍能保持列表位置稳定、控制信息密度；代价是需要为桌面窗口保留足够的横向空间。应用窗口因此限制为最小 `900×600`，不为更窄窗口增加单栏折叠分支。

## Consequences

- 应用窗口最小尺寸固定为 `900×600`，不为更窄窗口增加单栏折叠分支。
- 需要为桌面窗口保留足够的横向空间以容纳 master 与 detail 双栏。
