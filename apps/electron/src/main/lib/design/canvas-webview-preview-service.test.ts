import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CanvasWebviewPreviewTarget } from '@proma/shared'
import {
  createCanvasWebviewPreviewService,
  resolveCanvasWebviewViewport,
} from './canvas-webview-preview-service'

/** 创建固定目标，覆盖完整缓存身份。 */
function createTarget(overrides: Partial<CanvasWebviewPreviewTarget> = {}): CanvasWebviewPreviewTarget {
  return {
    projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'webview-1',
    prototypeId: 'prototype-1', contentRevision: 2, devicePreset: 'desktop',
    ...overrides,
  }
}

describe('CanvasWebviewPreviewService', () => {
  test('Given 原型已保存为 v1 When 主进程组装预览正文 Then 先读不可变版本库且仅让 v0 回退节点目录', () => {
    /** 该测试锁定 IPC 组合根，避免预览重新绕过已测试的 revision store。 */
    const ipcSource = readFileSync(join(import.meta.dir, '../../ipc.ts'), 'utf8')
    /** 只检查正文读取 helper，避免其它 Canvas 组装代码影响断言。 */
    const helperSource = ipcSource.slice(
      ipcSource.indexOf('const readCommittedCanvasContent'),
      ipcSource.indexOf('const canvasImageInputResolver'),
    )

    expect(helperSource).toContain('if (authoritativeNode.contentRevision > 0)')
    expect(helperSource).toContain('canvasArtifactRevisionStore.read')
    expect(helperSource.indexOf('canvasArtifactRevisionStore.read'))
      .toBeLessThan(helperSource.indexOf("openSingleChildDirectory('nodes')"))
    expect(helperSource).toContain('meta.revision !== 0')
  })

  test('Given 网页与手机设备 When 解析截图视口 Then 使用设计规格固定尺寸', () => {
    expect(resolveCanvasWebviewViewport('desktop')).toEqual({ width: 1440, height: 900 })
    expect(resolveCanvasWebviewViewport('mobile')).toEqual({ width: 390, height: 844 })
  })

  test('Given 相同完整目标并发请求 When 生成预览 Then 合并请求且只渲染一次', async () => {
    let renderCount = 0
    const service = createCanvasWebviewPreviewService({
      readCache: async () => null,
      writeCacheAtomic: async () => undefined,
      render: async () => {
        renderCount += 1
        return Buffer.from('webp')
      },
      registerPreview: () => 'proma-file://preview-1',
    })
    const target = createTarget()

    const [first, second] = await Promise.all([
      service.load(target, '<main>首页</main>'),
      service.load(target, '<main>首页</main>'),
    ])

    expect(first).toEqual(second)
    expect(renderCount).toBe(1)
  })

  test('Given 不同内容修订与设备 When 生成预览 Then 缓存身份不同且任务严格串行', async () => {
    let active = 0
    let maxActive = 0
    const rendered: string[] = []
    const service = createCanvasWebviewPreviewService({
      readCache: async () => null,
      writeCacheAtomic: async () => undefined,
      render: async ({ target }) => {
        active += 1
        maxActive = Math.max(maxActive, active)
        rendered.push(`${target.contentRevision}:${target.devicePreset}`)
        await Promise.resolve()
        active -= 1
        return Buffer.from('webp')
      },
      registerPreview: (cachePath) => `proma-file://${cachePath}`,
    })

    await Promise.all([
      service.load(createTarget(), '<main>desktop</main>'),
      service.load(createTarget({ contentRevision: 3 }), '<main>new</main>'),
      service.load(createTarget({ devicePreset: 'mobile' }), '<main>mobile</main>'),
    ])

    expect(maxActive).toBe(1)
    expect(rendered).toEqual(['2:desktop', '3:desktop', '2:mobile'])
  })

  test('Given 磁盘缓存命中 When 请求预览 Then 不启动渲染并注册缓存文件', async () => {
    let renderCount = 0
    const service = createCanvasWebviewPreviewService({
      readCache: async () => Buffer.from('cached-webp'),
      writeCacheAtomic: async () => undefined,
      render: async () => {
        renderCount += 1
        return Buffer.from('new-webp')
      },
      registerPreview: (cachePath, content) => `${cachePath}:${content.toString('utf8')}`,
    })

    const snapshot = await service.load(createTarget({ devicePreset: 'mobile' }), '<main>ignored</main>')

    expect(renderCount).toBe(0)
    expect(snapshot.previewUrl).toContain('cached-webp')
    expect(snapshot).toMatchObject({ width: 390, height: 844 })
  })
})
