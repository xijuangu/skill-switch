// preload:用 contextBridge 暴露最小化安全 API 给渲染进程
import { contextBridge, ipcRenderer } from 'electron'

const api = {
  scan: () => ipcRenderer.invoke('scan'),
  getSkills: () => ipcRenderer.invoke('getSkills'),
  getSettings: () => ipcRenderer.invoke('getSettings'),
  getDeployTargets: (sourceId: number) =>
    ipcRenderer.invoke('getDeployTargets', sourceId),
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
  deploymentDeploy: (request: { sourceId: number; targetId: string; requestedMode: 'copy' | 'symlink' | 'junction' }) =>
    ipcRenderer.invoke('deployment:deploy', request),
  deploymentConfirm: (confirmationId: string) =>
    ipcRenderer.invoke('deployment:confirm', confirmationId),
  // issue #22:漂移重新部署,target_path / source_path 由主进程从清单读取,
  // renderer 不传任何路径。
  redeploy: (deploymentId: number) => ipcRenderer.invoke('redeploy', deploymentId),
  undeploy: (deploymentId: number) => ipcRenderer.invoke('undeploy', deploymentId),
  getTools: () => ipcRenderer.invoke('getTools'),
  // Drift + Remove from Registry(#8)
  removeFromManifest: (deploymentId: number) =>
    ipcRenderer.invoke('removeFromManifest', deploymentId),
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
