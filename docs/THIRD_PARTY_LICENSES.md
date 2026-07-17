# 第三方许可证通知 / Third-Party License Notices

skill-switch 的发布产物包含以下第三方组件。本仓库自身代码以 [MIT](../LICENSE) 协议发布。下表列出实际参与发布的依赖及其许可证；开发依赖（仅用于构建与测试，不进入安装包）不在此列，完整依赖清单见 `package.json` 与 `package-lock.json`。

## 随包分发的运行时依赖

这些依赖会随 electron-builder 安装包的 `node_modules` 一并分发：

| 组件 | 许可证 | `package.json` 声明范围 |
| --- | --- | --- |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | MIT | `^11.5.0` |
| [adm-zip](https://github.com/cthackers/adm-zip) | MIT | `^0.5.18` |
| [gray-matter](https://github.com/jonschlinkert/gray-matter) | MIT | `^4.0.3` |

## 经 Vite 打包进入产物的库

以下库虽声明为 `devDependencies`，但其代码经 electron-vite 打包后进入 `out/` 产物，因此随应用分发：

| 组件 | 许可证 | `package.json` 声明范围 |
| --- | --- | --- |
| [react](https://react.dev/) | MIT | `^18.2.0` |
| [react-dom](https://react.dev/) | MIT | `^18.2.0` |
| [lucide-react](https://lucide.dev/) | ISC | `^1.23.0` |

## 应用框架

| 组件 | 许可证 | `package.json` 声明范围 |
| --- | --- | --- |
| [Electron](https://www.electronjs.org/) | MIT | `^28.2.0` |

各库的完整许可证文本保留在各自的 npm 包（`node_modules/<name>/LICENSE`）中。MIT 与 ISC 许可证均要求在分发时保留版权与许可声明；本通知即满足该要求。

## Inter 字体（SIL Open Font License 1.1）

skill-switch 在渲染层内嵌 Inter 可变字体的 `Inter-Variable.woff2`，用于界面排版。Inter 字体由 Rasmus Andersson 设计，以 **SIL Open Font License 1.1**（OFL）发布。

- 随包分发的字体文件：`src/renderer/src/assets/fonts/Inter-Variable.woff2`
- OFL 1.1 完整许可文本：[`src/renderer/src/assets/fonts/OFL.txt`](../src/renderer/src/assets/fonts/OFL.txt)

OFL 允许在满足其条款的前提下使用、学习、修改与重新分发字体，但不允许单独出售字体本身。skill-switch 对 Inter 的使用（嵌入应用界面）符合 OFL 条款。Inter 字体的版权属于其作者，不在本仓库 MIT 许可范围之内。
