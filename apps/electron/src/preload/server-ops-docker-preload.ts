import {
  SERVER_OPS_DOCKER_CHANNELS,
  parseServerOpsDockerActionCancelInput,
  parseServerOpsDockerActionCandidate,
  parseServerOpsDockerActionCommitInput,
  parseServerOpsDockerActionPrepareInput,
  parseServerOpsDockerActionResult,
  parseServerOpsDockerContainerDetailInput,
  parseServerOpsDockerContainerDetailResult,
  parseServerOpsDockerResourcesInput,
  parseServerOpsDockerResourcesResult,
} from '@proma/shared'
import type {
  ServerOpsDockerActionCancelInput,
  ServerOpsDockerActionCandidate,
  ServerOpsDockerActionCommitInput,
  ServerOpsDockerActionPrepareInput,
  ServerOpsDockerActionResult,
  ServerOpsDockerContainerDetailInput,
  ServerOpsDockerContainerDetailResult,
  ServerOpsDockerResourcesInput,
  ServerOpsDockerResourcesResult,
} from '@proma/shared'

/** Docker preload 调用主进程所需的最小接口。 */
export type ServerOpsDockerInvoke = (channel: string, input: unknown) => Promise<unknown>

/** Renderer 可使用的 Docker 严格桥接。 */
export interface ServerOpsDockerPreload {
  listServerOpsDockerResources(input: ServerOpsDockerResourcesInput): Promise<ServerOpsDockerResourcesResult>
  getServerOpsDockerContainerDetail(input: ServerOpsDockerContainerDetailInput): Promise<ServerOpsDockerContainerDetailResult>
  prepareServerOpsDockerAction(input: ServerOpsDockerActionPrepareInput): Promise<ServerOpsDockerActionCandidate>
  commitServerOpsDockerAction(input: ServerOpsDockerActionCommitInput): Promise<ServerOpsDockerActionResult>
  cancelServerOpsDockerAction(input: ServerOpsDockerActionCancelInput): Promise<void>
}

/** 组合 Docker API，并在 IPC 两侧都使用 exact-key parser。 */
export function createServerOpsDockerPreload(invoke: ServerOpsDockerInvoke): ServerOpsDockerPreload {
  return {
    listServerOpsDockerResources: async (input) => parseServerOpsDockerResourcesResult(
      await invoke(SERVER_OPS_DOCKER_CHANNELS.LIST_RESOURCES, parseServerOpsDockerResourcesInput(input)),
    ),
    getServerOpsDockerContainerDetail: async (input) => parseServerOpsDockerContainerDetailResult(
      await invoke(SERVER_OPS_DOCKER_CHANNELS.GET_CONTAINER_DETAIL, parseServerOpsDockerContainerDetailInput(input)),
    ),
    prepareServerOpsDockerAction: async (input) => parseServerOpsDockerActionCandidate(
      await invoke(SERVER_OPS_DOCKER_CHANNELS.PREPARE_ACTION, parseServerOpsDockerActionPrepareInput(input)),
    ),
    commitServerOpsDockerAction: async (input) => parseServerOpsDockerActionResult(
      await invoke(SERVER_OPS_DOCKER_CHANNELS.COMMIT_ACTION, parseServerOpsDockerActionCommitInput(input)),
    ),
    cancelServerOpsDockerAction: async (input) => {
      const result = await invoke(SERVER_OPS_DOCKER_CHANNELS.CANCEL_ACTION, parseServerOpsDockerActionCancelInput(input))
      if (result !== undefined) throw new Error('SERVER_OPS_DOCKER_ACTION_CANCEL_RESULT_INVALID')
    },
  }
}
