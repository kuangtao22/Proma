/** 路径管理窗口专用 preload，只暴露恢复与迁移所需 API。 */
import { contextBridge, ipcRenderer } from 'electron'
import { createPathManagementPreloadApi } from './path-management-preload'

/** 专用桥与完整 electronAPI 隔离，缩小 recovery 模式权限面。 */
contextBridge.exposeInMainWorld('pathManagementAPI', createPathManagementPreloadApi(ipcRenderer))
