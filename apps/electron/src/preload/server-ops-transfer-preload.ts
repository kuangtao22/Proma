import {
  SERVER_OPS_TRANSFER_CHANNELS,
  parseServerOpsLocalFileSelection,
  parseServerOpsTransferCancelInput,
  parseServerOpsTransferListInput,
  parseServerOpsTransferOwnerInput,
  parseServerOpsTransferSnapshot,
  parseServerOpsTransferSnapshots,
  parseServerOpsTransferStartInput,
  parseServerOpsTransferDownloadSelectionInput,
  parseServerOpsTransferUploadSelectionInput,
  parseServerOpsTransferReleaseSelectionInput,
} from '@proma/shared'
import type {
  ServerOpsTransferCancelInput,
  ServerOpsTransferListInput,
  ServerOpsTransferOwnerInput,
  ServerOpsTransferSnapshot,
  ServerOpsTransferStartInput,
  ServerOpsTransferDownloadSelectionInput,
  ServerOpsTransferUploadSelectionInput,
  ServerOpsLocalFileSelection,
  ServerOpsTransferReleaseSelectionInput,
} from '@proma/shared'

/** Renderer 可见的文件传输桥接，不公开 owner、connection 或本地路径。 */
export interface ServerOpsTransferPreload {
  selectServerOpsUploadFile(input: ServerOpsTransferUploadSelectionInput): Promise<ServerOpsLocalFileSelection | null>
  selectServerOpsDownloadFile(input: ServerOpsTransferDownloadSelectionInput): Promise<ServerOpsLocalFileSelection | null>
  releaseServerOpsFileSelection(input: ServerOpsTransferReleaseSelectionInput): Promise<void>
  startServerOpsTransfer(input: ServerOpsTransferStartInput): Promise<ServerOpsTransferSnapshot>
  listServerOpsTransfers(input: ServerOpsTransferListInput): Promise<ServerOpsTransferSnapshot[]>
  cancelServerOpsTransfer(input: ServerOpsTransferCancelInput): Promise<void>
  closeServerOpsTransferOwner(input: ServerOpsTransferOwnerInput): Promise<void>
  onServerOpsTransferProgress(listener: (snapshot: ServerOpsTransferSnapshot) => void): () => void
}

/** 创建严格双向解析的传输 preload helper。 */
export function createServerOpsTransferPreload(
  invoke: (channel: string, input: unknown) => Promise<unknown>,
  subscribe?: (channel: string, listener: (value: unknown) => void) => () => void,
): ServerOpsTransferPreload {
  return {
    selectServerOpsUploadFile: async (input) => parseServerOpsLocalFileSelection(await invoke(SERVER_OPS_TRANSFER_CHANNELS.SELECT_UPLOAD, parseServerOpsTransferUploadSelectionInput(input))),
    selectServerOpsDownloadFile: async (input) => parseServerOpsLocalFileSelection(await invoke(SERVER_OPS_TRANSFER_CHANNELS.SELECT_DOWNLOAD, parseServerOpsTransferDownloadSelectionInput(input))),
    releaseServerOpsFileSelection: async (input) => assertVoid(await invoke(SERVER_OPS_TRANSFER_CHANNELS.RELEASE_SELECTION, parseServerOpsTransferReleaseSelectionInput(input))),
    startServerOpsTransfer: async (input) => parseServerOpsTransferSnapshot(await invoke(SERVER_OPS_TRANSFER_CHANNELS.START, parseServerOpsTransferStartInput(input))),
    listServerOpsTransfers: async (input) => parseServerOpsTransferSnapshots(await invoke(SERVER_OPS_TRANSFER_CHANNELS.LIST, parseServerOpsTransferListInput(input))),
    cancelServerOpsTransfer: async (input) => assertVoid(await invoke(SERVER_OPS_TRANSFER_CHANNELS.CANCEL, parseServerOpsTransferCancelInput(input))),
    closeServerOpsTransferOwner: async (input) => assertVoid(await invoke(SERVER_OPS_TRANSFER_CHANNELS.CLOSE_OWNER, parseServerOpsTransferOwnerInput(input))),
    onServerOpsTransferProgress: (listener) => {
      if (!subscribe) throw new Error('SERVER_OPS_TRANSFER_EVENTS_UNAVAILABLE')
      return subscribe(SERVER_OPS_TRANSFER_CHANNELS.PROGRESS, (value) => listener(parseServerOpsTransferSnapshot(value)))
    },
  }
}

/** 清理类 IPC 只能返回 undefined。 */
function assertVoid(value: unknown): void { if (value !== undefined) throw new Error('SERVER_OPS_TRANSFER_RESULT_INVALID') }
