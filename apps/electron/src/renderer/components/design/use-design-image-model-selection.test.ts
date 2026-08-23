import { describe, expect, test } from 'bun:test'
import type { DesignImageModelSelection, ImageGenerationModelOption } from '@proma/shared'
import { createInitialDesignProjectState } from '@/atoms/design-atoms'
import type { DesignProjectState } from '@/atoms/design-atoms'
import type { DesignAdapter } from '@/lib/design-adapter'
import { createDesignImageModelSelectionController } from './use-design-image-model-selection'

/** 创建公开生图模型选项。 */
function option(profileId: string): ImageGenerationModelOption {
  return {
    profileId,
    name: `模型 ${profileId}`,
    executor: 'nano-banana',
    modelId: `model-${profileId}`,
    available: true,
  }
}

/** 创建项目权威选择响应。 */
function selection(projectId: string, profileId: string): DesignImageModelSelection {
  return { projectId, options: [option('profile-a'), option('profile-b')], selectedProfileId: profileId }
}

/** 创建可精确控制异步与广播的 controller fixture。 */
function createFixture(initialSelections: Record<string, DesignImageModelSelection>) {
  /** 按项目保存与 Jotai 同形的测试状态。 */
  const states = new Map<string, DesignProjectState>()
  /** 主进程当前权威结果。 */
  const authoritative = new Map(Object.entries(initialSelections))
  /** 测试订阅的目录变化监听器。 */
  const profileListeners = new Set<() => void>()
  /** 测试订阅的项目选择变化监听器。 */
  const selectionListeners = new Set<(event: { projectId: string }) => void>()
  /** 失败后展示给用户的错误文本。 */
  const errors: string[] = []
  let setError: Error | null = null
  let getError: Error | null = null
  let getCalls = 0
  const adapter: Pick<DesignAdapter,
    'getImageModelSelection' | 'setImageModelSelection'
    | 'onImageModelProfilesChanged' | 'onImageModelSelectionChanged'> = {
    getImageModelSelection: async (projectId) => {
      getCalls += 1
      if (getError) throw getError
      const result = authoritative.get(projectId)
      if (!result) throw new Error(`缺少项目选择: ${projectId}`)
      return structuredClone(result)
    },
    setImageModelSelection: async ({ projectId, imageModelProfileId }) => {
      if (setError) throw setError
      const result = selection(projectId, imageModelProfileId)
      authoritative.set(projectId, result)
      return structuredClone(result)
    },
    onImageModelProfilesChanged: (listener) => {
      profileListeners.add(listener)
      return () => profileListeners.delete(listener)
    },
    onImageModelSelectionChanged: (listener) => {
      selectionListeners.add(listener)
      return () => selectionListeners.delete(listener)
    },
  }
  /** 返回指定项目的最新状态，并为首次访问创建独立初始值。 */
  const state = (projectId: string): DesignProjectState => {
    const current = states.get(projectId) ?? createInitialDesignProjectState()
    if (!states.has(projectId)) states.set(projectId, current)
    return current
  }
  /** 创建绑定单项目的 controller。 */
  const controller = (projectId: string) => createDesignImageModelSelectionController({
    projectId,
    adapter,
    updateState: (update) => {
      const current = state(projectId)
      states.set(projectId, { ...current, ...(typeof update === 'function' ? update(current) : update) })
    },
    onError: (message) => errors.push(message),
  })
  return {
    state,
    controller,
    errors,
    getCalls: () => getCalls,
    setGetError: (error: Error | null) => { getError = error },
    setError: (error: Error | null) => { setError = error },
    setAuthoritative: (projectId: string, value: DesignImageModelSelection) => authoritative.set(projectId, value),
    emitProfilesChanged: () => { for (const listener of profileListeners) listener() },
    emitSelectionChanged: (projectId: string) => {
      for (const listener of selectionListeners) listener({ projectId })
    },
  }
}

describe('Design 项目生图模型选择 controller', () => {
  test('Given 项目 A/B 选择不同模型 When 分别进入 Inspector Then 各自恢复自己的选择', async () => {
    const fixture = createFixture({
      'project-a': selection('project-a', 'profile-a'),
      'project-b': selection('project-b', 'profile-b'),
    })
    const projectA = fixture.controller('project-a')
    const projectB = fixture.controller('project-b')

    projectA.start()
    projectB.start()
    await Promise.resolve()
    await Promise.resolve()

    expect(fixture.state('project-a').imageModelProfileId).toBe('profile-a')
    expect(fixture.state('project-b').imageModelProfileId).toBe('profile-b')
    projectA.dispose()
    projectB.dispose()
  })

  test('Given 偏好写入失败 When 用户切换 Then 回读权威选择并保留表单和画布状态', async () => {
    const fixture = createFixture({ 'project-a': selection('project-a', 'profile-a') })
    const controller = fixture.controller('project-a')
    controller.start()
    await Promise.resolve()
    await Promise.resolve()
    /** 写入前构造不可被模型状态更新清理的用户输入和本地 mutation。 */
    const state = fixture.state('project-a')
    state.generationPrompt = '保留这段描述'
    state.editPrompt = '保留编辑要求'
    state.selectedNodeIds = ['node-1']
    state.pendingMutations = [{ type: 'set-viewport', viewport: { x: 1, y: 2, zoom: 1 } }]
    fixture.setError(new Error('偏好写入失败'))

    controller.selectProfile('profile-b')
    expect(fixture.state('project-a').imageModelProfileId).toBe('profile-b')
    expect(fixture.state('project-a').imageModelLoadState).toBe('loading')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(fixture.state('project-a').imageModelProfileId).toBe('profile-a')
    expect(fixture.state('project-a').generationPrompt).toBe('保留这段描述')
    expect(fixture.state('project-a').editPrompt).toBe('保留编辑要求')
    expect(fixture.state('project-a').selectedNodeIds).toEqual(['node-1'])
    expect(fixture.state('project-a').pendingMutations).toHaveLength(1)
    expect(fixture.errors).toEqual(['偏好写入失败'])
    controller.dispose()
  })

  test('Given 当前项目已加载 When 选择新模型成功 Then 乐观值收敛为主进程权威 ready 状态', async () => {
    const fixture = createFixture({ 'project-a': selection('project-a', 'profile-a') })
    const controller = fixture.controller('project-a')
    controller.start()
    await Promise.resolve()
    await Promise.resolve()

    controller.selectProfile('profile-b')
    expect(fixture.state('project-a').imageModelProfileId).toBe('profile-b')
    expect(fixture.state('project-a').imageModelLoadState).toBe('loading')
    await Promise.resolve()
    await Promise.resolve()

    expect(fixture.state('project-a').imageModelLoadState).toBe('ready')
    expect(fixture.state('project-a').imageModelProfileId).toBe('profile-b')
    expect(fixture.state('project-a').imageModelError).toBeNull()
    expect(fixture.errors).toEqual([])
    controller.dispose()
  })

  test('Given 连续选择两个模型 When 旧选择最后失败 Then 不得回滚后续成功选择', async () => {
    /** 收集写入 resolver 与 rejecter，精确制造旧失败晚于新成功。 */
    const writes: Array<{
      resolve: (value: DesignImageModelSelection) => void
      reject: (error: Error) => void
    }> = []
    const adapter = {
      getImageModelSelection: async () => selection('project-a', 'profile-a'),
      setImageModelSelection: () => new Promise<DesignImageModelSelection>((resolve, reject) => {
        writes.push({ resolve, reject })
      }),
      onImageModelProfilesChanged: () => () => undefined,
      onImageModelSelectionChanged: () => () => undefined,
    }
    let state = createInitialDesignProjectState()
    const errors: string[] = []
    const controller = createDesignImageModelSelectionController({
      projectId: 'project-a', adapter,
      updateState: (update) => { state = { ...state, ...(typeof update === 'function' ? update(state) : update) } },
      onError: (message) => errors.push(message),
    })
    controller.start()
    await Promise.resolve()
    await Promise.resolve()

    controller.selectProfile('profile-a')
    controller.selectProfile('profile-b')
    writes[1]?.resolve(selection('project-a', 'profile-b'))
    await Promise.resolve()
    await Promise.resolve()
    writes[0]?.reject(new Error('旧选择失败'))
    await Promise.resolve()
    await Promise.resolve()

    expect(state.imageModelProfileId).toBe('profile-b')
    expect(state.imageModelLoadState).toBe('ready')
    expect(errors).toEqual([])
    controller.dispose()
  })

  test('Given 目录和其它项目选择广播 When 当前项目已进入 Then 只刷新应收敛的事件', async () => {
    const fixture = createFixture({
      'project-a': selection('project-a', 'profile-a'),
      'project-b': selection('project-b', 'profile-b'),
    })
    const controller = fixture.controller('project-a')
    controller.start()
    await Promise.resolve()
    await Promise.resolve()
    expect(fixture.getCalls()).toBe(1)

    fixture.emitSelectionChanged('project-b')
    await Promise.resolve()
    expect(fixture.getCalls()).toBe(1)

    fixture.setAuthoritative('project-a', selection('project-a', 'profile-b'))
    fixture.emitProfilesChanged()
    await Promise.resolve()
    await Promise.resolve()
    expect(fixture.getCalls()).toBe(2)
    expect(fixture.state('project-a').imageModelProfileId).toBe('profile-b')
    controller.dispose()
  })

  test('Given 广播刷新 GET 失败 When 当前项目已有选择 Then 保留现有值并可在重试后恢复', async () => {
    const fixture = createFixture({ 'project-a': selection('project-a', 'profile-a') })
    const controller = fixture.controller('project-a')
    controller.start()
    await Promise.resolve()
    await Promise.resolve()
    const options = fixture.state('project-a').imageModelOptions
    fixture.setGetError(new Error('模型目录暂时不可用'))

    fixture.emitSelectionChanged('project-a')
    await Promise.resolve()
    await Promise.resolve()

    expect(fixture.state('project-a').imageModelLoadState).toBe('failed')
    expect(fixture.state('project-a').imageModelProfileId).toBe('profile-a')
    expect(fixture.state('project-a').imageModelOptions).toBe(options)
    expect(fixture.state('project-a').imageModelError).toBe('模型目录暂时不可用')

    fixture.setGetError(null)
    controller.retryLoad()
    await Promise.resolve()
    await Promise.resolve()
    expect(fixture.state('project-a').imageModelLoadState).toBe('ready')
    expect(fixture.state('project-a').imageModelProfileId).toBe('profile-a')
    expect(fixture.state('project-a').imageModelError).toBeNull()
    controller.dispose()
  })

  test('Given controller 已释放 When 在途加载迟到 Then 不覆盖项目状态', async () => {
    /** 用可控 Promise 验证卸载代次，不依赖计时器。 */
    let resolveSelection: ((value: DesignImageModelSelection) => void) | undefined
    const adapter = {
      getImageModelSelection: () => new Promise<DesignImageModelSelection>((resolve) => { resolveSelection = resolve }),
      setImageModelSelection: async () => selection('project-a', 'profile-a'),
      onImageModelProfilesChanged: () => () => undefined,
      onImageModelSelectionChanged: () => () => undefined,
    }
    let state = createInitialDesignProjectState()
    const controller = createDesignImageModelSelectionController({
      projectId: 'project-a', adapter,
      updateState: (update) => { state = { ...state, ...(typeof update === 'function' ? update(state) : update) } },
      onError: () => undefined,
    })

    controller.start()
    controller.dispose()
    resolveSelection?.(selection('project-a', 'profile-a'))
    await Promise.resolve()
    await Promise.resolve()

    expect(state.imageModelLoadState).toBe('loading')
    expect(state.imageModelProfileId).toBeNull()
  })

  test('Given 两次加载乱序返回 When 旧请求最后完成 Then 仍保留最新权威选择', async () => {
    /** 收集两次加载的 resolver，精确制造后发先至。 */
    const resolvers: Array<(value: DesignImageModelSelection) => void> = []
    const adapter = {
      getImageModelSelection: () => new Promise<DesignImageModelSelection>((resolve) => { resolvers.push(resolve) }),
      setImageModelSelection: async () => selection('project-a', 'profile-a'),
      onImageModelProfilesChanged: () => () => undefined,
      onImageModelSelectionChanged: () => () => undefined,
    }
    let state = createInitialDesignProjectState()
    const controller = createDesignImageModelSelectionController({
      projectId: 'project-a', adapter,
      updateState: (update) => { state = { ...state, ...(typeof update === 'function' ? update(state) : update) } },
      onError: () => undefined,
    })

    controller.start()
    controller.retryLoad()
    resolvers[1]?.(selection('project-a', 'profile-b'))
    await Promise.resolve()
    await Promise.resolve()
    resolvers[0]?.(selection('project-a', 'profile-a'))
    await Promise.resolve()
    await Promise.resolve()

    expect(state.imageModelProfileId).toBe('profile-b')
    controller.dispose()
  })
})
