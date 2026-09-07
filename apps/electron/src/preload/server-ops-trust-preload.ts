import {
  SERVER_OPS_TRUST_CHANNELS, parseServerOpsTrustCancelInput, parseServerOpsTrustCandidate,
  parseServerOpsTrustCommitInput, parseServerOpsTrustInput, parseServerOpsTrustPrepareInput,
  parseServerOpsTrustResult, parseServerOpsTrustSnapshot,
} from '@proma/shared'
import type {
  ServerOpsTrustCancelInput, ServerOpsTrustCandidate, ServerOpsTrustCommitInput, ServerOpsTrustInput,
  ServerOpsTrustPrepareInput, ServerOpsTrustResult, ServerOpsTrustSnapshot,
} from '@proma/shared'

/** Renderer 可使用的信任管理桥接；所有操作由主进程验证窗口身份。 */
export interface ServerOpsTrustPreload {
  getServerOpsTrust(input: ServerOpsTrustInput): Promise<ServerOpsTrustSnapshot>
  prepareServerOpsTrust(input: ServerOpsTrustPrepareInput): Promise<ServerOpsTrustCandidate>
  commitServerOpsTrust(input: ServerOpsTrustCommitInput): Promise<ServerOpsTrustResult>
  cancelServerOpsTrust(input: ServerOpsTrustCancelInput): Promise<void>
}

/** 组合严格双向解析的信任 API，不通过 Renderer 传递任意指纹或 owner。 */
export function createServerOpsTrustPreload(invoke: (channel: string, input: unknown) => Promise<unknown>): ServerOpsTrustPreload {
  return {
    getServerOpsTrust: async (input) => parseServerOpsTrustSnapshot(await invoke(SERVER_OPS_TRUST_CHANNELS.GET, parseServerOpsTrustInput(input))),
    prepareServerOpsTrust: async (input) => parseServerOpsTrustCandidate(await invoke(SERVER_OPS_TRUST_CHANNELS.PREPARE, parseServerOpsTrustPrepareInput(input))),
    commitServerOpsTrust: async (input) => parseServerOpsTrustResult(await invoke(SERVER_OPS_TRUST_CHANNELS.COMMIT, parseServerOpsTrustCommitInput(input))),
    cancelServerOpsTrust: async (input) => {
      const result = await invoke(SERVER_OPS_TRUST_CHANNELS.CANCEL, parseServerOpsTrustCancelInput(input))
      if (result !== undefined) throw new Error('SERVER_OPS_TRUST_RESULT_INVALID')
    },
  }
}
