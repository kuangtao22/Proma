import '@fontsource-variable/inter/index.css'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import type { MediaRemoteWorkflow, MediaResourceQuery, MediaSettingsSnapshot } from '@proma/shared'
import { MediaSettings } from '../src/renderer/components/settings/MediaSettings'
import '../src/renderer/styles/globals.css'

/** 隔离页面的完整工作流样例，不连接真实服务。 */
const workflow: MediaRemoteWorkflow = {
  descriptor: { connectionId: 'fixture', instanceGeneration: 'generation', remoteUser: '', source: 'user-data', id: 'ui', workflowPath: 'ui.json' },
  format: 'ui',
  definition: {
    nodes: Array.from({ length: 1000 }, (_, index) => ({ id: index, type: 'LoadImage', widgets_values: [`image-${index}.png`] })),
    links: [[1, 0, 0, 1, 0, 'IMAGE']],
    extra: { lastField: '完整末尾内容 <script>fixture</script>' },
  },
  analysis: { format: 'ui', convertible: false, definition: null, nodes: [], inputs: [], outputs: [], issues: [
    { code: 'UI_WIDGET_UNMAPPED', nodeId: '5', input: 'image', message: '输入控件映射不明确，无法确认执行参数' },
  ] },
}
/** 提供完整 API 格式，验证预览后的显式导入链路。 */
const apiWorkflow: MediaRemoteWorkflow = {
  descriptor: { ...workflow.descriptor, id: 'api', workflowPath: 'api.json' },
  format: 'api',
  definition: { '1': { class_type: 'SaveImage', inputs: {} } },
}
/** 已通过转换的 UI 定义用于验证同一详情入口直接建立草稿。 */
const convertedWorkflow: MediaRemoteWorkflow = {
  ...workflow, descriptor: { ...workflow.descriptor, id: 'converted', workflowPath: 'converted.json' },
  analysis: { format: 'ui', convertible: true, issues: [], nodes: [], inputs: [], outputs: [], definition: {
    schemaVersion: 1,
    prompt: { '1': { class_type: 'SaveImage', inputs: { filename_prefix: 'Proma' } } },
    bindings: [], outputs: [{ key: 'result', nodeId: '1', outputIndex: 0, mediaType: 'image' }],
  } },
}
/** 设置页的已保存连接，禁止 fixture 触发实际保存。 */
const settings: MediaSettingsSnapshot = {
  schemaVersion: 2, revision: 1, profiles: [], workflows: [],
  connections: [{ id: 'fixture', name: '测试服务', baseUrl: 'http://127.0.0.1:8188', driver: 'comfyui', enabled: true, auth: { kind: 'none' }, revision: 1, instanceGeneration: 'generation', updatedAt: 1, credentialConfigured: false }],
}
/** 自动化测试可切换延迟/失败，并检查读取、复制和真实编辑器文档。 */
const smoke = {
  readMode: 'normal' as 'normal' | 'deferred' | 'fail',
  readCount: 0,
  copied: '',
  expected: JSON.stringify(workflow.definition, null, 2),
  release: () => {},
  getEditor: () => {
    /** 从实际 CodeMirror DOM 查询实例，而非以测试替身冒充编辑器。 */
    const element = document.querySelector('.cm-editor')
    return element ? EditorView.findFromDOM(element as HTMLElement) : null
  },
}
Object.assign(window, {
  __mediaWorkflowSmoke: smoke,
  electronAPI: {
    mediaGetSettings: async () => settings,
    listMediaApiModelProfiles: async () => ({ revision: 1, entries: [] }),
    listImageModelProfiles: async () => ({ channelOptions: [] }),
    onImageModelProfilesChanged: () => () => {},
    mediaListResources: async (query: MediaResourceQuery) => ({
      connectionId: 'fixture', snapshotId: 'snapshot', checkedAt: 1, total: 3, nextOffset: null,
      items: query.kind === 'workflows' ? [workflow, apiWorkflow, convertedWorkflow].map((remote) => ({
        id: remote.descriptor.id, name: `${remote.descriptor.id}.json`, category: '', supported: false, descriptor: remote.descriptor,
      })) : [],
    }),
    mediaReadRemoteWorkflow: async (descriptor: MediaRemoteWorkflow['descriptor']) => {
      smoke.readCount += 1
      if (smoke.readMode === 'fail') throw new Error('测试读取失败')
      /** 返回与点击文件一致的正文。 */
      const remote = descriptor.id === 'api' ? apiWorkflow : descriptor.id === 'converted' ? convertedWorkflow : workflow
      if (smoke.readMode === 'deferred') await new Promise<void>((resolve) => { smoke.release = resolve })
      return remote
    },
    writeClipboardText: async (text: string) => { smoke.copied = text },
  },
})
/** 使用 query 控制独立页面主题，不写入真实客户端偏好。 */
const theme = new URLSearchParams(location.search).get('theme') ?? 'dark'
document.documentElement.classList.toggle('dark', theme === 'dark')
createRoot(document.getElementById('root')!).render(<main className="h-screen overflow-auto bg-background p-4 text-foreground"><MediaSettings /></main>)
