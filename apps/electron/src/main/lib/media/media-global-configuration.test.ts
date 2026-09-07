import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MediaConfigStore } from './media-config-store'
import { writeJsonFileAtomicSecure } from '../safe-file'

/** 用例独享配置根，禁止接触用户业务数据。 */
let directory = ''
/** 模拟系统密文边界，允许验证旧任务保留认证版本。 */
const encryption = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'keychain',
  encryptString: (value: string) => Buffer.from(`cipher:${value}`),
  decryptString: (value: Buffer) => value.toString().slice(7),
}
/** 不含项目白名单的全局连接保存输入。 */
const connection = { id: 'gpu', name: '远程 ComfyUI', driver: 'comfyui', baseUrl: 'https://gpu.example/comfy/', enabled: true, auth: { kind: 'bearer' }, credential: 'first-secret' }
/** 含真实媒体入口与输出的公共工作流输入。 */
const definition = {
  schemaVersion: 1,
  prompt: { '1': { class_type: 'LoadImage', inputs: { image: 'project-private.png' } }, '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'Proma' } } },
  bindings: [{ key: 'reference', kind: 'image', nodeId: '1', input: 'image', loader: 'LoadImage' }],
  outputs: [{ key: 'image', nodeId: '2', outputIndex: 0, mediaType: 'image' }],
}
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'proma-media-global-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

describe('全局媒体配置与旧任务隔离', () => {
  test('Given v1 配置 When 首次修改并再次保存 Then 原始配置只备份一次且迁移幂等', () => {
    const store = new MediaConfigStore(directory, encryption)
    const initial = store.saveConnection(connection, 0)
    const legacy = { ...initial, schemaVersion: 1, connections: initial.connections.map((item) => ({ ...item, projectIds: ['old-project'] })) }
    writeJsonFileAtomicSecure(join(directory, 'media', 'config.json'), legacy)
    store.saveConnection({ ...connection, credential: undefined, name: '新版' }, 1)
    expect(JSON.parse(readFileSync(join(directory, 'media', 'config.v1.backup.json'), 'utf8'))).toEqual(legacy)
    store.saveConnection({ ...connection, credential: undefined, name: '再次改名' }, 2)
    expect(JSON.parse(readFileSync(join(directory, 'media', 'config.v1.backup.json'), 'utf8'))).toEqual(legacy)
    expect(store.read().schemaVersion).toBe(2)
    expect(store.resolveConnection('gpu', 'new-project').connection.name).toBe('再次改名')
  })
  test('Given 无项目配置 When 保存连接 Then 各项目和设置都能发现同一实例且不保存白名单', () => {
    const store = new MediaConfigStore(directory, encryption)
    store.saveConnection(connection, 0)
    expect(store.resolveConnection('gpu', 'project-b').connection.id).toBe('gpu')
    expect(store.listProject('project-c').connections).toHaveLength(1)
    expect(readFileSync(join(directory, 'media', 'config.json'), 'utf8')).not.toContain('projectIds')
  })

  test('Given 公共图绑定本地媒体名 When 发布 Then 清除临时值并让两个项目取得同一版本', () => {
    const store = new MediaConfigStore(directory, encryption)
    store.saveWorkflow({ id: 'workflow', name: '参考图', projectId: null, definition }, 0)
    expect(store.getWorkflow('workflow', 1, 'project-a').projectId).toBeNull()
    expect(store.getWorkflow('workflow', 1, 'project-b').definition.prompt['1']!.inputs.image).toBe('')
    expect(store.listProject('project-b').workflows).toHaveLength(1)
  })

  test('Given 未声明的媒体入口 When 发布公共模板 Then 拒绝携带项目文件引用', () => {
    const store = new MediaConfigStore(directory, encryption)
    expect(() => store.saveWorkflow({ id: 'workflow', name: '图', projectId: null, definition: { ...definition, bindings: [] } }, 0)).toThrow('MEDIA_WORKFLOW_RESOURCE_BINDING_REQUIRED')
  })

  test('Given 任务已准备 When 连接改地址和凭据后停用 Then 新任务不可选且旧版本仍解析原认证', () => {
    const store = new MediaConfigStore(directory, encryption)
    const first = store.saveConnection(connection, 0).connections[0]!
    store.saveConnection({ ...connection, baseUrl: 'https://new.example/', credential: 'next-secret' }, 1)
    store.saveConnection({ ...connection, baseUrl: 'https://new.example/', credential: undefined, enabled: false }, 2)
    expect(() => store.resolveConnection('gpu', 'project-a')).toThrow('MEDIA_CONNECTION_DISABLED')
    const historical = store.resolveConnectionVersion('gpu', first.instanceGeneration)
    expect(historical.connection.baseUrl).toBe('https://gpu.example/comfy/')
    expect(historical.headers.Authorization).toBe('Bearer first-secret')
  })

  test('Given 连接仅停用或改名 When 保存 Then 不改变实例代次而 comfy-user 改变须隔离身份', () => {
    const store = new MediaConfigStore(directory, encryption)
    const first = store.saveConnection(connection, 0).connections[0]!
    const disabled = store.saveConnection({ ...connection, credential: undefined, enabled: false }, 1).connections[0]!
    expect(disabled.instanceGeneration).toBe(first.instanceGeneration)
    const changed = store.saveConnection({ ...connection, credential: undefined, comfyUser: 'user-b' }, 2).connections[0]!
    expect(changed.instanceGeneration).not.toBe(first.instanceGeneration)
    expect(store.resolveConnection('gpu', 'project-a').headers['comfy-user']).toBe('user-b')
  })

  test('Given 公共模板有两个版本 When 归档 Then 从新目录消失且历史版本可解析', () => {
    const store = new MediaConfigStore(directory, encryption)
    store.saveWorkflow({ id: 'workflow', name: '图', projectId: null, definition }, 0)
    store.saveWorkflow({ id: 'workflow', name: '图新版', projectId: null, definition }, 1)
    store.archive({ kind: 'workflow', id: 'workflow' }, 2)
    expect(store.listProject('project-a').workflows).toHaveLength(0)
    expect(store.getWorkflow('workflow', 1, 'project-a').revision).toBe(1)
    expect(() => store.archive({ kind: 'workflow', id: 'workflow' }, 1)).toThrow('MEDIA_CONFIG_CONFLICT')
  })
})
