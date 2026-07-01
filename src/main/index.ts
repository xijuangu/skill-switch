// 主进程入口
import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { createDatabase, type DB } from './db/database'
import { ensureCentralDir, DB_PATH } from './paths'
import { registerIpcHandlers } from './ipc'

let db: DB | undefined

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1000,
    height: 720,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
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
