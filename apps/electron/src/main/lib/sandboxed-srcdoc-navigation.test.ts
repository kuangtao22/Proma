import { describe, expect, test } from 'bun:test'
import { shouldBlockSandboxedSrcdocNavigation } from './sandboxed-srcdoc-navigation'

describe('受限 srcdoc 子 frame 导航', () => {
  test('Given Canvas srcdoc 脚本、刷新或链接请求外部地址 When 子 frame 导航 Then 全部阻断', () => {
    /** 三种页面内导航最终都会进入同一个 Electron will-frame-navigate 边界。 */
    const externalTargets = [
      'https://example.com/script',
      'https://example.com/refresh',
      'https://example.com/link',
    ]

    for (const url of externalTargets) {
      expect(shouldBlockSandboxedSrcdocNavigation({
        url,
        isMainFrame: false,
        frameUrl: 'about:srcdoc',
        initiatorUrl: 'about:srcdoc',
      })).toBe(true)
    }
  })

  test('Given 主 frame 或非 srcdoc 子 frame When 导航 Then 不改变既有窗口策略', () => {
    expect(shouldBlockSandboxedSrcdocNavigation({
      url: 'https://example.com',
      isMainFrame: true,
      frameUrl: 'http://127.0.0.1:5174/',
      initiatorUrl: 'http://127.0.0.1:5174/',
    })).toBe(false)
    expect(shouldBlockSandboxedSrcdocNavigation({
      url: 'https://example.com',
      isMainFrame: false,
      frameUrl: 'https://trusted.example/frame',
      initiatorUrl: 'http://127.0.0.1:5174/',
    })).toBe(false)
  })
})
