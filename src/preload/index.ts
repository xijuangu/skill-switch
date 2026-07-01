// preload:用 contextBridge 暴露最小化安全 API 给渲染进程
import { contextBridge, ipcRenderer } from 'electron'

const api = {
  scan: () => ipcRenderer.invoke('scan'),
  getSkills: () => ipcRenderer.invoke('getSkills')
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (非 contextIsolated 降级)
  window.api = api
}
