import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ComfyObjectInfo, ComfyPrompt, JsonValue, MediaAssetRef } from '@proma/shared'
import type { ComfyHistoryPrompt, ComfyUploadMediaInput } from './comfyui-client'
import { MediaConfigStore } from './media-config-store'
import { MediaRunService } from './media-run-service'

/** 使用已核实的原生 Loader、保存节点与动态视频格式合同。 */
const objectInfo: ComfyObjectInfo = {
  LoadAudio: { input: { required: { audio: [['existing.wav'], { audio_upload: true }] } }, output: ['AUDIO'] },
  SaveAudio: { input: { required: { audio: ['AUDIO'], filename_prefix: ['STRING'] } }, output: ['AUDIO'], output_node: true },
  LoadVideo: { input: { required: { file: [['existing.mp4'], { video_upload: true }] } }, output: ['VIDEO'] },
  SaveVideo: { input: { required: { video: ['VIDEO'], filename_prefix: ['STRING'],
    format: ['COMFY_DYNAMICCOMBO_V3', { options: [{ key: 'mp4', inputs: { required: {
      codec: ['COMFY_DYNAMICCOMBO_V3', { options: [{ key: 'auto', inputs: { required: {} } }] }],
    } } }] }],
  } }, output: ['VIDEO'], output_node: true },
}

describe('音视频统一媒体运行', () => {
  for (const kind of ['audio', 'video'] as const) {
    for (const absent of [false, true]) {
    test(`Given ${kind} 原生工作流 When ${absent ? '成功history缺产物' : '上传改名且首次下载失败'} Then ${absent ? '保留缺项事实' : '重启只补收原产物'}而不重新生成`, async () => {
      const directory = mkdtempSync(join(tmpdir(), 'proma-media-av-run-'))
      try {
        const configuration = new MediaConfigStore(directory)
        const audio = kind === 'audio'
        const bytes = audio ? Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')]) : Buffer.from('000000186674797069736f6d', 'hex')
        const source: MediaAssetRef = { assetId: 'source', revision: 1, hash: createHash('sha256').update(bytes).digest('hex'), mediaKind: kind }
        const field = audio ? 'audio' : 'file'
        const prompt: ComfyPrompt = {
          '1': { class_type: audio ? 'LoadAudio' : 'LoadVideo', inputs: {} },
          '2': { class_type: audio ? 'SaveAudio' : 'SaveVideo', inputs: { [audio ? 'audio' : 'video']: ['1', 0], filename_prefix: 'Proma',
            ...(!audio ? { format: 'mp4', 'format.codec': 'auto' } : {}) } },
        }
        configuration.saveConnection({ id: 'gpu', name: 'GPU', driver: 'comfyui', baseUrl: 'http://localhost:8188', enabled: true, projectIds: ['project'], auth: { kind: 'none' } }, 0)
        configuration.saveWorkflow({ id: 'workflow', name: kind, projectId: 'project', definition: { schemaVersion: 1, prompt,
          bindings: [{ key: 'reference', kind, nodeId: '1', input: field, loader: audio ? 'LoadAudio' : 'LoadVideo' }],
          outputs: [{ key: 'main', nodeId: '2', outputIndex: 0, mediaType: kind }],
        } }, 1)
        configuration.saveProfile({ id: 'profile', name: kind, projectId: 'project', connectionId: 'gpu', workflowId: 'workflow', workflowRevision: 1, mediaKind: kind, enabled: true }, 2)
        let submission: { id: string; clientId: string; prompt: ComfyPrompt } | undefined
        let complete = false
        let missingOutput = absent
        let downloadFailed = true
        let submits = 0
        let uploads = 0
        let registrations = 0
        const createService = (): MediaRunService => new MediaRunService({
          configuration, getRunsDirectory: () => directory, authorize: () => undefined,
          readAsset: async () => bytes,
          registerOutput: async (_projectId, _operationId, outputBytes) => {
            expect(Buffer.from(outputBytes)).toEqual(bytes)
            registrations += 1
            return { ...source, assetId: 'output' }
          },
          createClient: () => ({
            objectInfo: async () => objectInfo,
            uploadImage: async () => { throw new Error('不能调用旧图片上传窄接口') },
            uploadMedia: async (input: ComfyUploadMediaInput) => {
              uploads += 1
              expect(Buffer.from(await input.media.arrayBuffer())).toEqual(bytes)
              expect(input.filename).toEndWith(audio ? '.wav' : '.mp4')
              return { name: audio ? 'renamed.wav' : 'renamed.mp4', subfolder: 'inputs/promoted', type: 'input' }
            },
            submitPrompt: async (compiled, options) => {
              submits += 1
              expect(compiled['1']?.inputs[field]).toBe(`inputs/promoted/renamed.${audio ? 'wav' : 'mp4'}`)
              submission = { id: options?.promptId ?? '', clientId: options?.clientId ?? '', prompt: compiled }
              return { promptId: submission.id, number: 0, nodeErrors: {} }
            },
            getQueue: async () => null,
            getHistory: async (): Promise<ComfyHistoryPrompt | null> => {
              if (!complete || !submission) return null
              return { promptId: submission.id,
                prompt: [0, submission.id, submission.prompt, { client_id: submission.clientId }, ['2']] as JsonValue,
                status: { completed: true, status_str: 'success' },
                outputs: { '2': { [audio ? 'audio' : 'images']: missingOutput ? [] : [{ filename: `result.${audio ? 'wav' : 'mp4'}`, subfolder: '', type: 'output' }] } },
              }
            },
            getOutput: async () => {
              if (downloadFailed) throw new Error('模拟下载断线')
              return { bytes, contentType: audio ? 'audio/wav' : 'video/mp4' }
            },
            cancelPrompt: async () => undefined,
          }),
        })
        const prepared = await createService().prepare({ projectId: 'project', operationId: 'intent', profileId: 'profile', profileRevision: 1,
          inputs: { reference: { kind: 'asset', asset: source } } })
        await createService().advance('project', prepared.id, prepared.revision)
        complete = true
        // 成功history缺输出必须报告收集失败，不能再次提交生成。
        const partial = await createService().reconcile('project', prepared.id)
        expect(partial.phase).toBe('collection-failed')
        expect(registrations).toBe(0)
        expect(submits).toBe(1)
        expect(uploads).toBe(1)
        missingOutput = false
        downloadFailed = false
        const resumed = await createService().reconcile('project', prepared.id)
        if (absent) {
          // 已固化的不完整history不能被远端迟到不同内容悄悄替换。
          expect(resumed.phase).toBe('collection-failed')
        } else {
          expect(resumed.phase).toBe('succeeded')
          expect(resumed.outputs).toEqual([{ outputKey: 'main', index: 0, asset: { ...source, assetId: 'output' } }])
          expect(registrations).toBe(1)
        }
        expect(submits).toBe(1)
      } finally { rmSync(directory, { recursive: true, force: true }) }
    })
    }
  }
})
