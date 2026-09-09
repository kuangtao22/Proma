import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MediaAuthorizationMode, MediaRemoteDescriptor, MediaWorkflowDefinition } from '@proma/shared'
import { writeJsonFileAtomic } from '../safe-file'
import { MediaConfigStore } from './media-config-store'

/** 每个用例使用独立配置目录。 */
let directory = ''
/** 最小的声明式图片工作流。 */
const workflow: MediaWorkflowDefinition = {
  schemaVersion: 1,
  prompt: { '1': { class_type: 'SaveImage', inputs: { filename_prefix: 'Proma' } } },
  bindings: [],
  outputs: [{ key: 'image.main', nodeId: '1', outputIndex: 0, mediaType: 'image' }],
}
/** 模拟可用的系统加密器，确保只把密文交给持久化层。 */
const encryption = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret' as const,
  encryptString: (value: string) => Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`),
  decryptString: (value: Buffer) => Buffer.from(value.toString().slice(10), 'base64').toString(),
}
/** 创建可以在测试之间模拟重启的 store。 */
function store(): MediaConfigStore { return new MediaConfigStore(directory, encryption) }
/** 连接写入命令，不以 URL 中的用户名或查询参数承载认证。 */
function connection() {
  return { id: 'gpu', name: '远程 GPU', driver: 'comfyui', baseUrl: 'https://gpu.example/comfy', enabled: true, projectIds: ['project-a'], auth: { kind: 'bearer' }, credential: 'secret-token' }
}
/** 构造绑定当前连接身份的远端工作流描述符。 */
function remoteDescriptor(instanceGeneration: string, workflowPath = 'workflows/example.json'): MediaRemoteDescriptor {
  return { connectionId: 'gpu', instanceGeneration, remoteUser: '', source: 'user-data', id: workflowPath, workflowPath }
}

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'proma-media-config-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

describe('媒体连接配置', () => {
  test('Given 新目录 When 保存并重启 Then 返回公开配置且秘密只在主进程解密', () => {
    const saved = store().saveConnection(connection(), 0)
    expect(saved.revision).toBe(1)
    expect(saved.connections[0]?.baseUrl).toBe('https://gpu.example/comfy/')
    expect(JSON.stringify(saved)).not.toContain('secret-token')
    expect(readFileSync(join(directory, 'media', 'config.json'), 'utf8')).not.toContain('secret-token')
    expect(statSync(join(directory, 'media', 'credentials', `${saved.connections[0]!.credentialRef}.json`)).mode & 0o777).toBe(0o600)
    const route = store().resolveConnection('gpu', 'project-a')
    expect(route.headers).toEqual({ Authorization: 'Bearer secret-token' })
    expect(route.connection.revision).toBe(1)
  })

  test('Given 旧连接带项目白名单 When 新目录解析 Then 连接全局共享而任务权限由 Host 保留', () => {
    store().saveConnection(connection(), 0)
    expect(store().resolveConnection('gpu', 'project-b').connection.projectIds).toBeUndefined()
  })

  test('Given 已有配置 When 旧窗口携带过期 revision 写入 Then 保留已保存事实', () => {
    store().saveConnection(connection(), 0)
    expect(() => store().saveConnection({ ...connection(), name: '过期值' }, 0)).toThrow('MEDIA_CONFIG_CONFLICT')
    expect(store().read().connections[0]?.name).toBe('远程 GPU')
  })

  test('Given 系统安全存储不可用 When 保存认证连接 Then 不降级明文且不保存配置', () => {
    const unavailable = new MediaConfigStore(directory, { ...encryption, isEncryptionAvailable: () => false })
    expect(() => unavailable.saveConnection(connection(), 0)).toThrow('MEDIA_SECURE_STORAGE_UNAVAILABLE')
    expect(store().read().connections).toHaveLength(0)
  })

  test('Given URL 内嵌秘密或非法协议 When 保存 Then 提前拒绝', () => {
    for (const baseUrl of ['file:///tmp/a', 'https://user:secret@gpu.example', 'https://gpu.example?key=secret', 'https://gpu.example/#secret']) {
      expect(() => store().saveConnection({ ...connection(), baseUrl }, 0)).toThrow('MEDIA_CONNECTION_URL_INVALID')
    }
  })

  test('Given 连接停用 When 准备新任务 Then 拒绝而实例身份继续供旧任务恢复', () => {
    const first = store().saveConnection(connection(), 0).connections[0]!
    const second = store().saveConnection({ ...connection(), enabled: false, credential: undefined }, 1).connections[0]!
    expect(second.revision).toBe(2)
    expect(second.instanceGeneration).toBe(first.instanceGeneration)
    expect(() => store().resolveConnection('gpu', 'project-a')).toThrow('MEDIA_CONNECTION_DISABLED')
  })

  test('Given 活跃连接 When 只改名称或项目排序 Then 保留任务实例身份而地址变化必须失效', () => {
    const first = store().saveConnection({ ...connection(), projectIds: ['project-a', 'project-b'] }, 0).connections[0]!
    const renamed = store().saveConnection({ ...connection(), credential: undefined, name: '新名称',
      projectIds: ['project-b', 'project-a'] }, 1).connections[0]!
    expect(renamed.revision).toBe(2)
    expect(renamed.instanceGeneration).toBe(first.instanceGeneration)
    const moved = store().saveConnection({ ...connection(), credential: undefined,
      projectIds: ['project-a', 'project-b'], baseUrl: 'https://other.example/comfy/' }, 2).connections[0]!
    expect(moved.instanceGeneration).not.toBe(first.instanceGeneration)
  })

  test('Given 文件损坏 When 读取或保存 Then 报错而非覆盖为空目录', () => {
    mkdirSync(join(directory, 'media'), { recursive: true })
    writeJsonFileAtomic(join(directory, 'media', 'config.json'), { schemaVersion: 999 })
    expect(() => store().read()).toThrow('MEDIA_CONFIG_INVALID')
    expect(() => store().saveConnection(connection(), 0)).toThrow('MEDIA_CONFIG_INVALID')
  })

  test('Given 其它进程持有目录写锁 When 修改 Then 不并发覆盖', () => {
    mkdirSync(join(directory, 'media', 'config.lock'), { recursive: true })
    expect(() => store().saveConnection(connection(), 0)).toThrow('MEDIA_CONFIG_BUSY')
  })

  test('Given 无认证方式 When 附带秘密保存 Then 明确拒绝而非丢弃', () => {
    expect(() => store().saveConnection({ ...connection(), auth: { kind: 'none' } }, 0)).toThrow('MEDIA_CREDENTIAL_UNEXPECTED')
  })

  test('Given 密文超预算 When 保存 Then 拒绝且不会保存无法再次解密的连接', () => {
    const oversized = new MediaConfigStore(directory, { ...encryption, encryptString: () => Buffer.alloc(40 * 1024) })
    expect(() => oversized.saveConnection(connection(), 0)).toThrow('MEDIA_CREDENTIAL_SIZE_LIMIT')
    expect(store().read().revision).toBe(0)
  })

  test('Given 轮换凭据 When 配置提交 Then 新任务取得新秘密且旧任务的密文继续可达', () => {
    const saved = store().saveConnection(connection(), 0)
    const path = join(directory, 'media', 'credentials', `${saved.connections[0]!.credentialRef}.json`)
    store().saveConnection({ ...connection(), credential: 'rotated-token' }, 1)
    expect(existsSync(path)).toBe(true)
    expect(store().resolveConnection('gpu', 'project-a').headers.Authorization).toBe('Bearer rotated-token')
  })

  test('Given 配置为符号链接 When 读取 Then 不追随其它文件', () => {
    mkdirSync(join(directory, 'media'), { recursive: true })
    writeJsonFileAtomic(join(directory, 'foreign.json'), { schemaVersion: 1, revision: 0, connections: [], workflows: [], profiles: [] })
    symlinkSync(join(directory, 'foreign.json'), join(directory, 'media', 'config.json'))
    expect(() => store().read()).toThrow('MEDIA_CONFIG_INVALID')
  })
})

describe('媒体生成授权模式', () => {
  test('Given 旧配置未保存授权模式 When 读取 Then 统一归一为每次询问', () => {
    mkdirSync(join(directory, 'media'), { recursive: true })
    writeJsonFileAtomic(join(directory, 'media', 'config.json'), {
      schemaVersion: 1, revision: 7, connections: [], workflows: [], profiles: [],
    })

    expect(store().read().authorizationMode).toBe('ask')
  })

  test('Given 当前配置 revision When 保存自动授权 Then 原子持久化并可在重启后读取', () => {
    const saved = store().saveAuthorizationMode('automatic', 0)

    expect(saved).toMatchObject({ revision: 1, authorizationMode: 'automatic' })
    expect(store().read()).toMatchObject({ revision: 1, authorizationMode: 'automatic' })
  })

  test('Given 非法授权模式 When 保存 Then 拒绝且不推进 revision', () => {
    const invalidMode = 'always' as unknown as MediaAuthorizationMode

    expect(() => store().saveAuthorizationMode(invalidMode, 0)).toThrow('MEDIA_AUTHORIZATION_MODE_INVALID')
    expect(store().read()).toMatchObject({ revision: 0, authorizationMode: 'ask' })
  })

  test('Given 旧窗口 revision When 修改授权模式 Then 保留已保存模式', () => {
    store().saveAuthorizationMode('automatic', 0)

    expect(() => store().saveAuthorizationMode('ask', 0)).toThrow('MEDIA_CONFIG_CONFLICT')
    expect(store().read()).toMatchObject({ revision: 1, authorizationMode: 'automatic' })
  })

  test('Given 授权模式订阅 When 保存变化、幂等、失败和退订 Then 仅持久化变化后通知', () => {
    const configurationStore = store()
    const observed: string[] = []
    const unsubscribe = configurationStore.subscribeAuthorizationMode(() => {
      const configuration = configurationStore.read()
      observed.push(`${configuration.revision}:${configuration.authorizationMode}`)
    })

    expect(configurationStore.saveAuthorizationMode('ask', 0).revision).toBe(0)
    expect(observed).toEqual([])
    expect(configurationStore.saveAuthorizationMode('automatic', 0).revision).toBe(1)
    expect(observed).toEqual(['1:automatic'])
    expect(configurationStore.saveAuthorizationMode('automatic', 1).revision).toBe(1)
    expect(() => configurationStore.saveAuthorizationMode('ask', 0)).toThrow('MEDIA_CONFIG_CONFLICT')
    expect(() => configurationStore.saveAuthorizationMode('invalid' as unknown as MediaAuthorizationMode, 1)).toThrow('MEDIA_AUTHORIZATION_MODE_INVALID')
    expect(observed).toEqual(['1:automatic'])

    unsubscribe()
    configurationStore.saveAuthorizationMode('ask', 1)
    expect(observed).toEqual(['1:automatic'])
  })
})

describe('媒体工作流与预设版本', () => {
  test('Given 项目模板已发布 When 保存新版本 Then 历史版本可按精确 revision 解析', () => {
    store().saveConnection(connection(), 0)
    store().saveWorkflow({ id: 'wf', name: '图生图', projectId: 'project-a', definition: workflow }, 1)
    store().saveWorkflow({ id: 'wf', name: '图生图 v2', projectId: 'project-a', definition: { ...workflow, prompt: { '1': { class_type: 'SaveImage', inputs: { filename_prefix: 'new' } } } } }, 2)
    expect(store().getWorkflow('wf', 1, 'project-a').name).toBe('图生图')
    expect(store().getWorkflow('wf', 2, 'project-a').name).toBe('图生图 v2')
    expect(() => store().getWorkflow('wf', 1, 'project-b')).toThrow('MEDIA_WORKFLOW_NOT_AUTHORIZED')
    const catalog = JSON.stringify(store().listProject('project-a'))
    expect(catalog).not.toContain('definition')
    expect(catalog).not.toContain('credentialRef')
    expect(catalog).not.toContain('gpu.example')
    expect(store().listProject('project-b').workflows).toHaveLength(0)
  })

  test('Given 精确工作流版本 When 保存图片预设 Then 固定版本且对错误媒体类型拒绝', () => {
    store().saveConnection(connection(), 0)
    store().saveWorkflow({ id: 'wf', name: '模板', projectId: 'project-a', definition: workflow }, 1)
    const profile = { id: 'preset', name: '工作室图片', connectionId: 'gpu', workflowId: 'wf', workflowRevision: 1, mediaKind: 'image', projectId: 'project-a', enabled: true }
    store().saveProfile(profile, 2)
    expect(store().resolveProfile('preset', 1, 'project-a').workflow.revision).toBe(1)
    expect(() => store().saveProfile({ ...profile, mediaKind: 'video' }, 3)).toThrow('MEDIA_PROFILE_OUTPUT_MISMATCH')
    store().saveProfile({ ...profile, enabled: false }, 3)
    const config = store().read()
    config.profiles.reverse()
    writeJsonFileAtomic(join(directory, 'media', 'config.json'), config)
    expect(() => store().resolveProfile('preset', 1, 'project-a')).toThrow('MEDIA_PROFILE_DISABLED')
  })

  test('Given 远端工作流首次缓存 When 重启读取 Then 保留来源身份且项目目录可读取真实标记', () => {
    const savedConnection = store().saveConnection(connection(), 0).connections[0]!
    const snapshot = store().cacheRemoteWorkflow({
      projectId: 'project-a',
      name: '服务器工作流',
      descriptor: remoteDescriptor(savedConnection.instanceGeneration),
      contentHash: 'a'.repeat(64),
      definition: workflow,
    })

    expect(snapshot.projectId).toBe('project-a')
    expect(snapshot.revision).toBe(1)
    expect(snapshot.remoteSource).toEqual({
      descriptor: remoteDescriptor(savedConnection.instanceGeneration),
      contentHash: 'a'.repeat(64),
    })
    expect(store().getWorkflow(snapshot.id, snapshot.revision, 'project-a').remoteSource).toEqual(snapshot.remoteSource)
    expect(store().listProject('project-a').workflows[0]?.remoteSource).toEqual(snapshot.remoteSource)
  })

  test('Given 相同远端正文已经缓存 When 再次使用 Then 复用版本且不推进配置 revision', () => {
    const savedConnection = store().saveConnection(connection(), 0).connections[0]!
    const input = {
      projectId: 'project-a',
      name: '服务器工作流',
      descriptor: remoteDescriptor(savedConnection.instanceGeneration),
      contentHash: 'b'.repeat(64),
      definition: workflow,
    }
    const first = store().cacheRemoteWorkflow(input)
    const revision = store().read().revision
    const second = store().cacheRemoteWorkflow(input)

    expect(second).toEqual(first)
    expect(store().read().revision).toBe(revision)
    expect(store().read().workflows).toHaveLength(1)
  })

  test('Given 同一路径远端正文变化 When 再次缓存 Then 创建新快照且旧引用继续可取', () => {
    const savedConnection = store().saveConnection(connection(), 0).connections[0]!
    const descriptor = remoteDescriptor(savedConnection.instanceGeneration)
    const first = store().cacheRemoteWorkflow({ projectId: 'project-a', name: '第一版', descriptor,
      contentHash: 'c'.repeat(64), definition: workflow })
    const changedDefinition = { ...workflow, prompt: { '1': { class_type: 'SaveImage', inputs: { filename_prefix: 'changed' } } } }
    const second = store().cacheRemoteWorkflow({ projectId: 'project-a', name: '第二版', descriptor,
      contentHash: 'd'.repeat(64), definition: changedDefinition })

    expect(second.id).not.toBe(first.id)
    expect(second.revision).toBe(1)
    expect(store().getWorkflow(first.id, 1, 'project-a').name).toBe('第一版')
    expect(store().getWorkflow(second.id, 1, 'project-a').name).toBe('第二版')
  })

  test('Given 相同远端正文用于不同项目 When 缓存 Then 身份和读取范围不串用', () => {
    const savedConnection = store().saveConnection(connection(), 0).connections[0]!
    const input = { name: '服务器工作流', descriptor: remoteDescriptor(savedConnection.instanceGeneration),
      contentHash: 'e'.repeat(64), definition: workflow }
    const projectA = store().cacheRemoteWorkflow({ ...input, projectId: 'project-a' })
    const projectB = store().cacheRemoteWorkflow({ ...input, projectId: 'project-b' })

    expect(projectB.id).not.toBe(projectA.id)
    expect(() => store().getWorkflow(projectA.id, 1, 'project-b')).toThrow('MEDIA_WORKFLOW_NOT_AUTHORIZED')
    expect(store().getWorkflow(projectB.id, 1, 'project-b').projectId).toBe('project-b')
  })

  test('Given 描述符身份过期或路径非法 When 缓存 Then 不创建远端快照', () => {
    const savedConnection = store().saveConnection(connection(), 0).connections[0]!
    const base = { projectId: 'project-a', name: '服务器工作流', contentHash: 'f'.repeat(64), definition: workflow }
    expect(() => store().cacheRemoteWorkflow({ ...base,
      descriptor: { ...remoteDescriptor(savedConnection.instanceGeneration), instanceGeneration: 'stale' } })).toThrow('MEDIA_REMOTE_RESOURCE_STALE')
    expect(() => store().cacheRemoteWorkflow({ ...base,
      descriptor: { ...remoteDescriptor(savedConnection.instanceGeneration), remoteUser: 'other-user' } })).toThrow('MEDIA_REMOTE_RESOURCE_STALE')
    expect(() => store().cacheRemoteWorkflow({ ...base,
      descriptor: { ...remoteDescriptor(savedConnection.instanceGeneration), source: 'assets-api', assetId: 'asset-1' } })).toThrow('MEDIA_REMOTE_RESOURCE_INVALID')
    expect(() => store().cacheRemoteWorkflow({ ...base,
      descriptor: remoteDescriptor(savedConnection.instanceGeneration, '../private.json') })).toThrow('MEDIA_REMOTE_RESOURCE_INVALID')
    expect(store().read().workflows).toHaveLength(0)
  })

  test('Given 远端快照已经缓存 When 普通保存使用相同 ID Then 禁止覆盖内部快照', () => {
    const savedConnection = store().saveConnection(connection(), 0).connections[0]!
    const snapshot = store().cacheRemoteWorkflow({ projectId: 'project-a', name: '服务器工作流',
      descriptor: remoteDescriptor(savedConnection.instanceGeneration), contentHash: '1'.repeat(64), definition: workflow })

    expect(() => store().saveWorkflow({ id: snapshot.id, name: '手工覆盖', projectId: 'project-a', definition: workflow }, store().read().revision))
      .toThrow('MEDIA_WORKFLOW_REMOTE_SNAPSHOT_IMMUTABLE')
  })

  test('Given 落盘远端来源被篡改为 Assets 描述符 When 重启读取 Then 拒绝损坏配置', () => {
    const savedConnection = store().saveConnection(connection(), 0).connections[0]!
    store().cacheRemoteWorkflow({ projectId: 'project-a', name: '服务器工作流',
      descriptor: remoteDescriptor(savedConnection.instanceGeneration), contentHash: '2'.repeat(64), definition: workflow })
    const config = store().read()
    config.workflows[0]!.remoteSource!.descriptor = {
      connectionId: 'gpu', instanceGeneration: savedConnection.instanceGeneration, remoteUser: '',
      source: 'assets-api', id: 'asset-1', assetId: 'asset-1',
    }
    writeJsonFileAtomic(join(directory, 'media', 'config.json'), config)

    expect(() => store().read()).toThrow('MEDIA_CONFIG_INVALID')
  })
})
