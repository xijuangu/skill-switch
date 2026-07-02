# Renderer 按 app、feature 和共享 UI 分层

Renderer 将应用外壳、导航、全局刷新和通知放在 `app/`，将各页面及其专属交互放在对应 `features/` 目录，将无业务语义的视觉原语放在 `components/ui/`。这一边界避免把原有单文件仅机械拆成另一组平铺组件；当前继续使用 React state 和 hooks，只有跨页面权威数据留在 app 层，不为本次 UI 升级引入全局状态库。
