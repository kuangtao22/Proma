import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'

/** 测试使用的最小 CDP 客户端，只记录连接状态。 */
class MockDebugger {
  private attached = false

  attach(): void {
    this.attached = true
  }

  detach(): void {
    this.attached = false
  }

  isAttached(): boolean {
    return this.attached
  }

  async sendCommand(): Promise<Record<string, unknown>> {
    return {}
  }
}

/** 测试使用的最小 WebContents，支持 BrowserController 的标签生命周期。 */
class MockWebContents extends EventEmitter {
  readonly debugger = new MockDebugger()
  private destroyed = false

  setWindowOpenHandler(): void {}

  isDestroyed(): boolean {
    return this.destroyed
  }

  close(): void {
    this.destroyed = true
  }

  stop(): void {}

  getURL(): string {
    return 'about:blank'
  }

  getTitle(): string {
    return '新建标签页'
  }

  isLoading(): boolean {
    return false
  }

  canGoBack(): boolean {
    return false
  }

  canGoForward(): boolean {
    return false
  }

  async loadURL(): Promise<void> {}
}

/** 测试使用的最小原生视图。 */
class MockWebContentsView {
  readonly webContents = new MockWebContents()

  setVisible(): void {}

  setBounds(): void {}
}

/** 按 partition 复用 Electron Session，贴近生产生命周期。 */
const mockSessions = new Map<string, object>()

mock.module('electron', () => ({
  app: {
    getPath: () => '/private/tmp',
    getVersion: () => '0.0.0-test',
  },
  BrowserWindow: class {},
  WebContentsView: MockWebContentsView,
  session: {
    fromPartition: (partition: string) => {
      const existing = mockSessions.get(partition)
      if (existing) return existing
      const created = {
        getUserAgent: () => 'Mozilla/5.0 Electron/0.0.0',
        setUserAgent: () => undefined,
        setPermissionRequestHandler: () => undefined,
        setCertificateVerifyProc: () => undefined,
        webRequest: { onBeforeRequest: () => undefined },
        protocol: { handle: () => undefined },
        on: () => undefined,
      }
      mockSessions.set(partition, created)
      return created
    },
  },
}))

mock.module('./settings-service', () => ({
  getSettings: () => ({ browserRiskDisclaimerVersion: 1 }),
}))

/** BrowserController 在 Electron mock 安装后再加载。 */
let BrowserController: typeof import('./browser-controller').BrowserController
const originalDateNow = Date.now
let clock = 0

beforeAll(async () => {
  ;({ BrowserController } = await import('./browser-controller'))
})

beforeEach(() => {
  mockSessions.clear()
  clock = 0
  Date.now = () => ++clock
})

afterEach(() => {
  Date.now = originalDateNow
})

/** 创建具备原生 View 容器能力的 controller。 */
function createController(): InstanceType<typeof BrowserController> {
  const controller = new BrowserController()
  controller.setOwnerWindow({
    isDestroyed: () => false,
    isVisible: () => true,
    webContents: {
      send: () => undefined,
      getZoomFactor: () => 1,
    },
    contentView: {
      addChildView: () => undefined,
      removeChildView: () => undefined,
    },
  } as unknown as Electron.BrowserWindow)
  return controller
}

/** 创建超过后台保留上限的会话，用公开 API 触发真实 LRU 回收。 */
async function createBackgroundSessions(controller: InstanceType<typeof BrowserController>): Promise<void> {
  for (let index = 0; index < 9; index += 1) {
    await controller.createNewTab(`background-${index}`)
  }
}

const hiddenBounds = { x: 0, y: 0, width: 0, height: 0 }

describe('浏览器模态遮挡期间的会话保留', () => {
  test('Given 双 Slot 都被模态遮挡 When 一个 Slot 卸载且另一个收到旧 revision Then 会话仍受保护直到最后 Slot 解除', async () => {
    const controller = createController()
    const firstState = await controller.createNewTab('target')
    const secondState = await controller.createNewTab('target')
    const firstTabId = firstState.activeTabId
    const secondTabId = secondState.activeTabId
    await createBackgroundSessions(controller)

    controller.setLayout({ sessionId: 'target', tabId: firstTabId, revision: 10, visible: false, preserveSessionOnHide: true, bounds: hiddenBounds })
    controller.setLayout({ sessionId: 'target', tabId: secondTabId, revision: 20, visible: false, preserveSessionOnHide: true, bounds: hiddenBounds })
    controller.setLayout({ sessionId: 'target', tabId: firstTabId, revision: 11, visible: false, preserveSessionOnHide: false, bounds: hiddenBounds })
    controller.setLayout({ sessionId: 'target', tabId: secondTabId, revision: 19, visible: false, preserveSessionOnHide: false, bounds: hiddenBounds })

    controller.minimize('background-8')
    expect(controller.getState('target')).not.toBeNull()

    controller.setLayout({ sessionId: 'target', tabId: secondTabId, revision: 21, visible: false, preserveSessionOnHide: false, bounds: hiddenBounds })
    controller.minimize('background-8')
    expect(controller.getState('target')).toBeNull()
  })

  test('Given 双 Slot 都声明遮挡保护 When 用户主动最小化 Then 清除所有 Slot 保护并允许 LRU 回收', async () => {
    const controller = createController()
    const firstState = await controller.createNewTab('target')
    const secondState = await controller.createNewTab('target')
    await createBackgroundSessions(controller)

    controller.setLayout({ sessionId: 'target', tabId: firstState.activeTabId, revision: 10, visible: false, preserveSessionOnHide: true, bounds: hiddenBounds })
    controller.setLayout({ sessionId: 'target', tabId: secondState.activeTabId, revision: 20, visible: false, preserveSessionOnHide: true, bounds: hiddenBounds })

    controller.minimize('target')
    expect(controller.getState('target')).not.toBeNull()

    for (let index = 0; index < 9; index += 1) {
      const sessionId = `background-${index}`
      if (controller.getState(sessionId)) controller.minimize(sessionId)
    }
    await controller.createNewTab('background-9')
    controller.minimize('background-9')
    expect(controller.getState('target')).toBeNull()
  })

  test('Given 仅一个 Tab 声明遮挡保护 When 关闭该 Tab Then 保护随 Tab 释放并允许 LRU 回收', async () => {
    const controller = createController()
    const protectedState = await controller.createNewTab('target')
    await controller.createNewTab('target')
    await createBackgroundSessions(controller)

    controller.setLayout({ sessionId: 'target', tabId: protectedState.activeTabId, revision: 10, visible: false, preserveSessionOnHide: true, bounds: hiddenBounds })
    await controller.closeTab('target', protectedState.activeTabId)

    controller.minimize('background-8')
    expect(controller.getState('target')).toBeNull()
  })
})
