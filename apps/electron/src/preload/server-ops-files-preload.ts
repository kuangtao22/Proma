import {
  SERVER_OPS_FILE_CHANNELS,
  parseServerOpsFileCancelInput,
  parseServerOpsFileCandidate,
  parseServerOpsFileCommitInput,
  parseServerOpsFileListInput,
  parseServerOpsFileListResult,
  parseServerOpsFileMutationInput,
  parseServerOpsFileMutationResult,
  parseServerOpsFileOwnerInput,
  parseServerOpsFilePreviewInput,
  parseServerOpsFilePreviewResult,
} from '@proma/shared'
import type {
  ServerOpsFileCancelInput,
  ServerOpsFileCandidate,
  ServerOpsFileCommitInput,
  ServerOpsFileListInput,
  ServerOpsFileListResult,
  ServerOpsFileMutationInput,
  ServerOpsFileMutationResult,
  ServerOpsFileOwnerInput,
  ServerOpsFilePreviewInput,
  ServerOpsFilePreviewResult,
} from '@proma/shared'

export interface ServerOpsFilesPreload {
  listServerOpsFiles(input: ServerOpsFileListInput): Promise<ServerOpsFileListResult>
  previewServerOpsFile(input: ServerOpsFilePreviewInput): Promise<ServerOpsFilePreviewResult>
  prepareServerOpsFileMutation(input: ServerOpsFileMutationInput): Promise<ServerOpsFileCandidate>
  commitServerOpsFileMutation(input: ServerOpsFileCommitInput): Promise<ServerOpsFileMutationResult>
  cancelServerOpsFileMutation(input: ServerOpsFileCancelInput): Promise<void>
  closeServerOpsFilesOwner(input: ServerOpsFileOwnerInput): Promise<void>
}

/** 创建严格双向解析的文件桥接，ownerKey 与 connectionId 不进入 Renderer。 */
export function createServerOpsFilesPreload(invoke: (channel: string, input: unknown) => Promise<unknown>): ServerOpsFilesPreload {
  return {
    listServerOpsFiles: async (input) => parseServerOpsFileListResult(await invoke(SERVER_OPS_FILE_CHANNELS.LIST, parseServerOpsFileListInput(input))),
    previewServerOpsFile: async (input) => parseServerOpsFilePreviewResult(await invoke(SERVER_OPS_FILE_CHANNELS.PREVIEW, parseServerOpsFilePreviewInput(input))),
    prepareServerOpsFileMutation: async (input) => parseServerOpsFileCandidate(await invoke(SERVER_OPS_FILE_CHANNELS.PREPARE, parseServerOpsFileMutationInput(input))),
    commitServerOpsFileMutation: async (input) => parseServerOpsFileMutationResult(await invoke(SERVER_OPS_FILE_CHANNELS.COMMIT, parseServerOpsFileCommitInput(input))),
    cancelServerOpsFileMutation: async (input) => assertVoid(await invoke(SERVER_OPS_FILE_CHANNELS.CANCEL, parseServerOpsFileCancelInput(input))),
    closeServerOpsFilesOwner: async (input) => assertVoid(await invoke(SERVER_OPS_FILE_CHANNELS.CLOSE_OWNER, parseServerOpsFileOwnerInput(input))),
  }
}

/** 清理类 IPC 只能返回 undefined。 */
function assertVoid(value: unknown): void { if (value !== undefined) throw new Error('SERVER_OPS_FILES_RESULT_INVALID') }
