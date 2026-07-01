// preload:用 contextBridge 暴露最小化安全 API 给渲染进程
import { contextBridge, ipcRenderer } from 'electron'

const api = {
  scan: () => ipcRenderer.invoke('scan'),
  getSkills: () => ipcRenderer.invoke('getSkills'),
  getSettings: () => ipcRenderer.invoke('getSettings'),
  setPresetEnabled: (key: string, enabled: boolean) =>
    ipcRenderer.invoke('setPresetEnabled', key, enabled),
  setPresetPaths: (key: string, paths: string[]) =>
    ipcRenderer.invoke('setPresetPaths', key, paths),
  addCustomTool: (tool: { key: string; displayName: string; paths: string[] }) =>
    ipcRenderer.invoke('addCustomTool', tool),
  removeCustomTool: (key: string) => ipcRenderer.invoke('removeCustomTool', key),
  setBackupRetention: (n: number) => ipcRenderer.invoke('setBackupRetention', n)
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
