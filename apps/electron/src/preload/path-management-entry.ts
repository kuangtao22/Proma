/** 路径管理窗口专用 preload，只暴露恢复与迁移所需 API。 */
import { contextBridge, ipcRenderer } from 'electron'
import { createDedicatedPathManagementPreloadApi } from './path-management-preload'

/** BrowserWindow additionalArguments 注入的可信 mode 参数前缀。 */
const PATH_MANAGEMENT_MODE_PREFIX = '--proma-path-mode='
/** 从主进程创建窗口时注入的参数中读取专用 mode。 */
const modeArgument = process.argv.find((argument) => argument.startsWith(PATH_MANAGEMENT_MODE_PREFIX))
/** 删除固定前缀后的路径窗口 mode。 */
const mode = modeArgument?.slice(PATH_MANAGEMENT_MODE_PREFIX.length)
if (mode !== 'data-root-migration' && mode !== 'data-root-recovery') {
  throw new Error('路径管理 preload 缺少有效启动模式')
}

/** 专用桥与完整 electronAPI 隔离，缩小 recovery 模式权限面。 */
contextBridge.exposeInMainWorld(
  'pathManagementAPI',
  createDedicatedPathManagementPreloadApi(mode, ipcRenderer),
)
