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

  // Renderer links never become Electron windows; approved destinations open in the OS browser.
  win.webContents.setWindowOpenHandler((details) => {
    const { openExternal } = handleWindowOpenRequest(details.url)
    if (openExternal) {
      shell.openExternal(openExternal)
    }
    return { action: 'deny' }
  })

  // The SPA has no legitimate top-level navigation after its initial load.
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
