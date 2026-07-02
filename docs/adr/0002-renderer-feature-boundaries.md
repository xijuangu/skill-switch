# Renderer 按 app、feature 和共享 UI 分层

Renderer 将应用外壳、导航、全局刷新和通知放在 `app/`，将各页面及其专属交互放在对应 `features/` 目录，将无业务语义的视觉原语放在 `shared/components/`。这一边界避免把原有单文件仅机械拆成另一组平铺组件；当前继续使用 React state 和 hooks，只有跨页面权威数据留在 app 层，不为本次 UI 升级引入全局状态库。

## 决定记录

- **共享视觉原语路径**：采用 `src/renderer/src/shared/components/` 而非 `components/ui/`。`shared` 语义更明确地表达「跨 feature 共享层」，且与 `shared/index.ts` 桶导出一致。原 ADR 草稿的 `components/ui/` 路径在实现时调整为 `shared/components/`。
- **通知系统归位**：Toast（`ToastProvider`/`useToast`/`ToastContainer`）是通知系统而非无业务语义的视觉原语，归 `src/renderer/src/app/Toast.tsx`，不归 `shared/components/`。feature 页通过 `useToast` 消费 app 层提供的通知能力。
