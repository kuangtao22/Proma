import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PATH_MANAGEMENT_IPC_CHANNELS } from '@proma/shared'
import type { DataRootRecoverySelection, PathManagementState } from '@proma/shared'
import { DataRootLocator } from './data-root-locator'
import * as dataRootMarker from './data-root-marker'
import * as startupCheck from './data-root-startup-check'
import { registerPathManagementIpcHandlers } from './path-management-ipc'

/** 仅清理本文件创建的临时 home。 */
const temporaryHomes: string[] = []
afterEach(() => { for (const home of temporaryHomes.splice(0)) rmSync(home, { recursive: true, force: true }) })

/** 创建隔离恢复窗口和真实磁盘目录；返回 IPC 动作及副作用记录。 */
function createRecoveryHarness() {
  /** 隔离 home 与旧数据根，绝不触碰真实用户数据。 */
  const homeDir = mkdtempSync(join(tmpdir(), 'proma-recovery-selection-'))
  temporaryHomes.push(homeDir)
  /** 旧根中保留的原始内容用于验证恢复不会改写用户数据。 */
  const oldRoot = join(homeDir, 'old')
  mkdirSync(oldRoot)
  writeFileSync(join(oldRoot, 'settings.json'), '{"theme":"dark"}')
  writeFileSync(join(oldRoot, 'server-ops'), '用户原始文件')
  new DataRootLocator({ homeDir }).write({ version: 1, activeRoot: oldRoot })
  /** 模拟系统选择器当前返回的路径或取消。 */
  let selectedRoot: string | null = null
  /** 当前恢复窗口唯一允许的 IPC sender。 */
  const sender = { send: () => undefined }
  /** 收集注册的真实 IPC handler。 */
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  /** 仅成功提交后允许出现的重启动作。 */
  const calls: string[] = []
  registerPathManagementIpcHandlers({
    mode: 'data-root-recovery', homeDir,
    ipc: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: () => undefined },
    app: { relaunch: () => { calls.push('relaunch') }, quit: () => { calls.push('quit') } },
    dialog: { showOpenDialog: async () => ({ canceled: selectedRoot === null, filePaths: selectedRoot ? [selectedRoot] : [] }) },
    getExpectedWebContents: () => sender,
  })
  /** 使用真实 handler 模拟专用 preload invoke。 */
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({ sender }, ...args)
  return {
    homeDir, oldRoot, calls, invoke,
    select: (root: string | null) => { selectedRoot = root },
    pick: async () => await invoke(PATH_MANAGEMENT_IPC_CHANNELS.PICK_DATA_ROOT) as DataRootRecoverySelection | null,
    recover: (input: unknown) => invoke(PATH_MANAGEMENT_IPC_CHANNELS.RECOVER_DATA_ROOT, input),
    state: async () => await invoke(PATH_MANAGEMENT_IPC_CHANNELS.GET_STATE) as PathManagementState,
    locator: () => new DataRootLocator({ homeDir }).inspect().locatorFile,
  }
}

describe('启动目录恢复与选择', () => {
  test('Given server-ops 同名文件 When 查询和重新检测 Then 显示具体原因且不重启', async () => {
    const harness = createRecoveryHarness()
    expect((await harness.state()).startupIssue?.path).toBe(join(harness.oldRoot, 'server-ops'))
    harness.recover({ action: 'recheck' })
    expect(harness.calls).toEqual([])
    expect(readFileSync(join(harness.oldRoot, 'server-ops'), 'utf8')).toBe('用户原始文件')
    rmSync(join(harness.oldRoot, 'server-ops'))
    harness.recover({ action: 'recheck' })
    expect(existsSync(join(harness.oldRoot, 'server-ops'))).toBe(true)
    expect(harness.calls).toEqual(['relaunch', 'quit'])
  })

  test('Given 空目录 When 选择但未确认 Then 不写 marker 或 locator；确认后保留旧数据并重启', async () => {
    const harness = createRecoveryHarness()
    const candidate = join(harness.homeDir, 'new')
    mkdirSync(candidate)
    harness.select(candidate)
    const selection = await harness.pick()
    expect(selection).toMatchObject({ targetRoot: candidate, kind: 'empty' })
    expect(readdirSync(candidate)).toEqual([])
    expect(harness.locator()?.activeRoot).toBe(harness.oldRoot)
    expect(() => harness.recover({ action: 'relocate', selectedRoot: candidate, selectionId: selection?.selectionId })).toThrow('确认')
    harness.recover({ action: 'relocate', selectedRoot: candidate, selectionId: selection?.selectionId, initializeEmpty: true })
    expect(harness.locator()).toMatchObject({ activeRoot: candidate, previousRoot: harness.oldRoot })
    expect(existsSync(join(candidate, 'server-ops'))).toBe(true)
    expect(readFileSync(join(harness.oldRoot, 'server-ops'), 'utf8')).toBe('用户原始文件')
    expect(harness.calls).toEqual(['relaunch', 'quit'])
  })

  test('Given 已有 Proma 数据 When 选择并确认 Then 保留目标配置原文而不复制旧根', async () => {
    const harness = createRecoveryHarness()
    const candidate = join(harness.homeDir, 'existing')
    mkdirSync(candidate)
    writeFileSync(join(candidate, 'settings.json'), '{"theme":"light"}\n')
    harness.select(candidate)
    const selection = await harness.pick()
    expect(selection?.kind).toBe('existing')
    harness.recover({ action: 'relocate', selectedRoot: candidate, selectionId: selection?.selectionId })
    expect(readFileSync(join(candidate, 'settings.json'), 'utf8')).toBe('{"theme":"light"}\n')
    expect(harness.locator()?.previousRoot).toBe(harness.oldRoot)
  })

  test('Given 取消或伪造选择 When 恢复 Then 拒绝且旧数据根保持不变', async () => {
    const harness = createRecoveryHarness()
    const candidate = join(harness.homeDir, 'new')
    mkdirSync(candidate)
    harness.select(candidate)
    const selection = await harness.pick()
    expect(() => harness.recover({ action: 'relocate', selectedRoot: harness.homeDir, selectionId: selection?.selectionId, initializeEmpty: true })).toThrow()
    harness.select(null)
    expect(await harness.pick()).toBeNull()
    expect(() => harness.recover({ action: 'relocate', selectedRoot: candidate, selectionId: selection?.selectionId, initializeEmpty: true })).toThrow()
    expect(readdirSync(candidate)).toEqual([])
    expect(harness.locator()?.activeRoot).toBe(harness.oldRoot)
    expect(harness.calls).toEqual([])
  })

  test('Given 候选含文件冲突或链接 When 选择 Then 拒绝且不写入候选', async () => {
    const harness = createRecoveryHarness()
    const candidate = join(harness.homeDir, 'existing')
    mkdirSync(candidate)
    writeFileSync(join(candidate, 'settings.json'), '{"theme":"light"}')
    writeFileSync(join(candidate, 'server-ops'), '保留')
    harness.select(candidate)
    await expect(harness.pick()).rejects.toThrow()
    rmSync(join(candidate, 'server-ops'))
    symlinkSync(harness.oldRoot, join(candidate, 'server-ops'), 'junction')
    await expect(harness.pick()).rejects.toThrow()
    expect(harness.locator()?.activeRoot).toBe(harness.oldRoot)
    expect(existsSync(join(candidate, '.proma-data-root.json'))).toBe(false)
  })

  test('Given 选择后空目录变成非空 When 确认 Then 不初始化、不切换', async () => {
    const harness = createRecoveryHarness()
    const candidate = join(harness.homeDir, 'new')
    mkdirSync(candidate)
    harness.select(candidate)
    const selection = await harness.pick()
    writeFileSync(join(candidate, 'notes.txt'), '用户内容')
    expect(() => harness.recover({ action: 'relocate', selectedRoot: candidate, selectionId: selection?.selectionId, initializeEmpty: true })).toThrow()
    expect(readdirSync(candidate)).toEqual(['notes.txt'])
    expect(harness.locator()?.activeRoot).toBe(harness.oldRoot)
  })

  test('Given 选择后目录被替换 When 确认 Then 拒绝对不同目录应用旧确认', async () => {
    const harness = createRecoveryHarness()
    const candidate = join(harness.homeDir, 'new')
    mkdirSync(candidate)
    harness.select(candidate)
    const selection = await harness.pick()
    renameSync(candidate, join(harness.homeDir, 'saved'))
    mkdirSync(candidate)
    expect(() => harness.recover({ action: 'relocate', selectedRoot: candidate, selectionId: selection?.selectionId, initializeEmpty: true })).toThrow()
    expect(readdirSync(candidate)).toEqual([])
    expect(harness.calls).toEqual([])
  })
  test('Given 普通非空目录 When 选择 Then 不把用户目录初始化成应用数据区', async () => {
    /** 普通项目即使可写也不能作为新数据区直接占用。 */
    const harness = createRecoveryHarness()
    const candidate = join(harness.homeDir, 'project')
    mkdirSync(candidate)
    writeFileSync(join(candidate, 'notes.txt'), '原文件')
    harness.select(candidate)
    await expect(harness.pick()).rejects.toThrow('不是空目录')
    expect(readdirSync(candidate)).toEqual(['notes.txt'])
    expect(harness.locator()?.activeRoot).toBe(harness.oldRoot)
  })

  test('Given 旧备份存在 server-ops 冲突 When 切回 Then 保留定位文件和两边原数据', () => {
    /** restore-previous 也必须复用关键子目录检查，不能绕过选择器校验。 */
    const harness = createRecoveryHarness()
    const previous = join(harness.homeDir, 'previous')
    mkdirSync(previous)
    writeFileSync(join(previous, 'settings.json'), '{"theme":"light"}')
    writeFileSync(join(previous, 'server-ops'), '旧备份冲突')
    new DataRootLocator({ homeDir: harness.homeDir }).write({ version: 1, activeRoot: harness.oldRoot, previousRoot: previous })
    expect(() => harness.recover({ action: 'restore-previous' })).toThrow()
    expect(harness.locator()?.activeRoot).toBe(harness.oldRoot)
    expect(readFileSync(join(previous, 'server-ops'), 'utf8')).toBe('旧备份冲突')
    expect(harness.calls).toEqual([])
  })

  test('Given 面板取消已选目录 When 重复取消或提交旧授权 Then 取消幂等且旧授权无效', async () => {
    const harness = createRecoveryHarness()
    const candidate = join(harness.homeDir, 'new')
    mkdirSync(candidate)
    harness.select(candidate)
    const selection = await harness.pick()
    harness.recover({ action: 'cancel-selection', selectionId: selection?.selectionId })
    harness.recover({ action: 'cancel-selection', selectionId: selection?.selectionId })
    expect(() => harness.recover({ action: 'relocate', selectedRoot: candidate, selectionId: selection?.selectionId, initializeEmpty: true })).toThrow()
    expect(readdirSync(candidate)).toEqual([])
    expect(harness.locator()?.activeRoot).toBe(harness.oldRoot)
  })

  for (const boundary of ['before-marker', 'after-marker'] as const) {
    test(`Given 确认期间在 ${boundary} 发生目录替换 When 继续恢复 Then 停止且不写替换目录`, async () => {
      const harness = createRecoveryHarness()
      const candidate = join(harness.homeDir, 'new')
      mkdirSync(candidate)
      harness.select(candidate)
      const selection = await harness.pick()
      /** 在真实 marker 写边界替换路径，证明后续操作仍绑定原选择。 */
      const initialize = dataRootMarker.initializeEmptyPromaDataRoot
      const mocked = spyOn(dataRootMarker, 'initializeEmptyPromaDataRoot').mockImplementation((...args) => {
        if (boundary === 'after-marker') initialize(...args)
        renameSync(candidate, join(harness.homeDir, 'original-selection'))
        mkdirSync(candidate)
        if (boundary === 'before-marker') initialize(...args)
      })
      try {
        expect(() => harness.recover({ action: 'relocate', selectedRoot: candidate, selectionId: selection?.selectionId, initializeEmpty: true })).toThrow()
        expect(readdirSync(candidate)).toEqual([])
        expect(harness.locator()?.activeRoot).toBe(harness.oldRoot)
        expect(harness.calls).toEqual([])
      } finally {
        mocked.mockRestore()
      }
    })
  }

  test('Given 旧取消晚于新选择 When 撤销旧授权 Then 新选择仍可确认', async () => {
    const harness = createRecoveryHarness()
    const candidate = join(harness.homeDir, 'new')
    mkdirSync(candidate)
    harness.select(candidate)
    const previousSelection = await harness.pick()
    const currentSelection = await harness.pick()
    harness.recover({ action: 'cancel-selection', selectionId: previousSelection?.selectionId })
    harness.recover({ action: 'relocate', selectedRoot: candidate, selectionId: currentSelection?.selectionId, initializeEmpty: true })
    expect(harness.locator()?.activeRoot).toBe(candidate)
  })

  test('Given 关键目录创建后在最终检查发生根替换 When 提交定位 Then 拒绝且替换目录保持空白', async () => {
    const harness = createRecoveryHarness()
    const candidate = join(harness.homeDir, 'new')
    mkdirSync(candidate)
    harness.select(candidate)
    const selection = await harness.pick()
    /** 在最后检查返回后改变路径；定位提交前仍必须复验选择身份。 */
    const inspect = startupCheck.inspectDataRootDirectories
    const mocked = spyOn(startupCheck, 'inspectDataRootDirectories').mockImplementation((root) => {
      const result = inspect(root)
      if (root === candidate && existsSync(join(root, 'server-ops'))) {
        renameSync(candidate, join(harness.homeDir, 'original-selection'))
        mkdirSync(candidate)
      }
      return result
    })
    try {
      expect(() => harness.recover({ action: 'relocate', selectedRoot: candidate, selectionId: selection?.selectionId, initializeEmpty: true })).toThrow()
      expect(readdirSync(candidate)).toEqual([])
      expect(harness.locator()?.activeRoot).toBe(harness.oldRoot)
      expect(harness.calls).toEqual([])
    } finally {
      mocked.mockRestore()
    }
  })

})
