import {
  SERVER_OPS_PROJECT_CHANNELS,
  parseServerOpsConnectionMoveInput,
  parseServerOpsConnectionMoveResult,
  parseServerOpsProjectCreateInput,
  parseServerOpsProjectDeleteInput,
  parseServerOpsProjectListInput,
  parseServerOpsProjectListResult,
  parseServerOpsProjectRenameInput,
  parseServerOpsProjectResult,
} from '@proma/shared'
import type {
  ServerOpsProjectCreateInput,
  ServerOpsConnectionMoveInput,
  ServerOpsConnectionMoveResult,
  ServerOpsProjectDeleteInput,
  ServerOpsProjectListInput,
  ServerOpsProjectListResult,
  ServerOpsProjectRenameInput,
  ServerOpsProjectResult,
} from '@proma/shared'

/** 项目 preload 调用主进程所需的最小接口。 */
export type ServerOpsProjectInvoke = (channel: string, input: unknown) => Promise<unknown>

/** Renderer 可使用的项目严格桥接。 */
export interface ServerOpsProjectPreload {
  listServerOpsProjects(input: ServerOpsProjectListInput): Promise<ServerOpsProjectListResult>
  createServerOpsProject(input: ServerOpsProjectCreateInput): Promise<ServerOpsProjectResult>
  renameServerOpsProject(input: ServerOpsProjectRenameInput): Promise<ServerOpsProjectResult>
  deleteServerOpsProject(input: ServerOpsProjectDeleteInput): Promise<void>
  moveServerOpsConnection(input: ServerOpsConnectionMoveInput): Promise<ServerOpsConnectionMoveResult>
}

/** 组合项目 API，并在 IPC 两侧都使用 exact-key parser。 */
export function createServerOpsProjectPreload(invoke: ServerOpsProjectInvoke): ServerOpsProjectPreload {
  return {
    listServerOpsProjects: async (input) => parseServerOpsProjectListResult(
      await invoke(SERVER_OPS_PROJECT_CHANNELS.LIST, parseServerOpsProjectListInput(input)),
    ),
    createServerOpsProject: async (input) => parseServerOpsProjectResult(
      await invoke(SERVER_OPS_PROJECT_CHANNELS.CREATE, parseServerOpsProjectCreateInput(input)),
    ),
    renameServerOpsProject: async (input) => parseServerOpsProjectResult(
      await invoke(SERVER_OPS_PROJECT_CHANNELS.RENAME, parseServerOpsProjectRenameInput(input)),
    ),
    deleteServerOpsProject: async (input) => {
      /** 删除只接受空回执，携带结果说明协议被破坏。 */
      const result = await invoke(SERVER_OPS_PROJECT_CHANNELS.DELETE, parseServerOpsProjectDeleteInput(input))
      if (result !== undefined) throw new Error('SERVER_OPS_PROJECT_DELETE_RESULT_INVALID')
    },
    moveServerOpsConnection: async (input) => parseServerOpsConnectionMoveResult(
      await invoke(SERVER_OPS_PROJECT_CHANNELS.MOVE_CONNECTION, parseServerOpsConnectionMoveInput(input)),
    ),
  }
}
