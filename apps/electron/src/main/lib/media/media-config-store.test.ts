import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeJsonFileAtomic } from '../safe-file'
import { MediaConfigStore } from './media-config-store'

/** 每个用例使用独立配置目录。 */
let directory = ''
/** 最小的声明式图片工作流。 */
const workflow = {
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
})
