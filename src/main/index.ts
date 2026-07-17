// 主进程入口
import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { createDatabase, type DB } from './db/database'
import { ensureCentralDir, DB_PATH } from './paths'
import { registerIpcHandlers, runStartupSequence } from './ipc'
import { createSecureWebPreferences, handleWindowOpenRequest } from './external-link-policy'

let db: DB | undefined

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    webPreferences: createSecureWebPreferences(join(__dirname, '../preload/index.js'))
  })

  win.on('ready-to-show', () => win.show())

  // issue #117:所有新窗口请求一律拒绝(不新建任何 Electron 窗口)。仅当 url 通过外链
  // 策略(HTTPS + 受信 GitHub 主机)时,转交给系统浏览器;非 https、file:/javascript:/
  // data:/自定义协议、解析失败或不可信主机的目标被安全拒绝(既不打开,也不新建窗口)。
  win.webContents.setWindowOpenHandler((details) => {
    const { openExternal } = handleWindowOpenRequest(details.url)
    if (openExternal) {
      shell.openExternal(openExternal)
    }
    return { action: 'deny' }
  })

  // issue #117:主窗口是 SPA,永远不应发生顶层导航。拒绝任何 will-navigate,
  // 防止 renderer 被诱导跳转到外部或 file: 页面。初始 loadURL/loadFile 不触发此事件。
  win.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })

  // electron-vite dev 模式走 URL,生产模式走打包文件
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  ensureCentralDir()
  db = createDatabase(DB_PATH)
  runStartupSequence(db)
  registerIpcHandlers(db)

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  db?.close()
  db = undefined
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
