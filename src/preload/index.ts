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
  setBackupRetention: (n: number) => ipcRenderer.invoke('setBackupRetention', n),
  listBackups: () => ipcRenderer.invoke('listBackups'),
  restoreBackup: (backupId: string) => ipcRenderer.invoke('restoreBackup', backupId),
  deleteBackup: (backupId: string) => ipcRenderer.invoke('deleteBackup', backupId),
  // Deploy(#6 + #9 junction fallback)
  deploy: (skillId: number, targetTool: string, mode: 'copy' | 'symlink' | 'junction', sourcePath: string) =>
    ipcRenderer.invoke('deploy', skillId, targetTool, mode, sourcePath),
  undeploy: (skillId: number, targetTool: string) =>
    ipcRenderer.invoke('undeploy', skillId, targetTool),
  getTools: () => ipcRenderer.invoke('getTools'),
  // Drift + Remove from Registry(#8)
  removeFromManifest: (skillId: number, targetTool: string) =>
    ipcRenderer.invoke('removeFromManifest', skillId, targetTool),
  getDeploymentsForSkill: (skillId: number) =>
    ipcRenderer.invoke('getDeploymentsForSkill', skillId),
  viewSkillMd: (skillId: number, sourcePath?: string) =>
    ipcRenderer.invoke('viewSkillMd', skillId, sourcePath),
  removeFromRegistry: (skillId: number) =>
    ipcRenderer.invoke('removeFromRegistry', skillId),
  // Install(#7)
  installFromGitHub: (url: string) => ipcRenderer.invoke('installFromGitHub', url),
  installFromZip: (zipPath: string) => ipcRenderer.invoke('installFromZip', zipPath),
  installFromLocalDir: (localPath: string) => ipcRenderer.invoke('installFromLocalDir', localPath),
  selectZipFile: () => ipcRenderer.invoke('selectZipFile'),
  selectLocalDir: () => ipcRenderer.invoke('selectLocalDir')
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
