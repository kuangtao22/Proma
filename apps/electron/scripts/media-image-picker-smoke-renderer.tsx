import '@fontsource-variable/inter/index.css'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import type { MediaAssetRecord, MediaAssetRef, MediaPreloadApi } from '@proma/shared'
import { CanvasMediaWorkflowForm, type CanvasMediaWorkflowInputDraft } from '../src/renderer/components/design/CanvasMediaWorkbench'
import '../src/renderer/styles/globals.css'

/** 使用仓库自带的真实图片字节作为缩略图 fixture，不连接媒体服务器。 */
const imageBytes = new Uint8Array(await (await fetch(new URL('../resources/proma-logos/proma-emerald.png', import.meta.url))).arrayBuffer())
/** 百张目录验证只读取可视范围，重名条目仍使用不同素材身份。 */
const assets: MediaAssetRecord[] = Array.from({ length: 100 }, (_, index) => ({
  id: `image-${index}`, revision: 1, hash: index.toString(16).padStart(64, '0'), mediaKind: 'image',
  filename: index === 0 ? '参考图.png' : index === 1 ? '参考图.png' : `构图-${index.toString().padStart(3, '0')}-e2ab4619-9a42-418b-9ba6-73b53f31978f.png`,
  byteSize: imageBytes.length, mediaType: 'image/png', metadata: { width: 1024, height: 768 }, createdAt: 1,
}))
/** 只暴露隔离交互测试所需的状态与控制入口。 */
const smoke = {
  calls: [] as { projectId: string; asset: MediaAssetRef }[],
  urls: new Set<string>(),
  deferred: false,
  fail: false,
  pending: [] as (() => void)[],
  input: null as CanvasMediaWorkflowInputDraft | null,
  setProject: (_projectId: string): void => {},
  setEmpty: (_empty: boolean): void => {},
  unmount: (): void => {},
}
/** 计数 Blob 所有权，验证关闭和迟到响应不会泄漏地址。 */
const createUrl = URL.createObjectURL.bind(URL)
const revokeUrl = URL.revokeObjectURL.bind(URL)
URL.createObjectURL = (blob) => { const url = createUrl(blob); smoke.urls.add(url); return url }
URL.revokeObjectURL = (url) => { smoke.urls.delete(url); revokeUrl(url) }
/** fixture 仅模拟该只读缩略图接口。 */
const api: Pick<MediaPreloadApi, 'mediaReadAssetThumbnail'> = {
  async mediaReadAssetThumbnail(projectId, asset) {
    smoke.calls.push({ projectId, asset })
    if (smoke.deferred) await new Promise<void>((resolve) => { smoke.pending.push(resolve) })
    if (smoke.fail) throw new Error('THUMBNAIL_UNAVAILABLE')
    return { bytes: imageBytes, contentType: 'image/png' }
  },
}
Object.assign(window, { electronAPI: api, __mediaImagePickerSmoke: smoke })
/** 单个生产表单挂载后由真实 React 状态接管草稿。 */
function Fixture(): React.ReactElement {
  const [projectId, setProject] = React.useState('project-a')
  const [empty, setEmpty] = React.useState(false)
  const [input, setInput] = React.useState<CanvasMediaWorkflowInputDraft>({
    key: '137.image', kind: 'image', label: '参考图', controlType: 'image', required: true,
    sourceType: 'literal', value: 'image-0', asset: { assetId: 'image-0', revision: 1, hash: assets[0]!.hash, mediaKind: 'image' },
    bindingNodeId: '137', bindingInput: 'image', sourceNodeId: '', outputKey: '',
  })
  smoke.input = input
  smoke.setProject = setProject
  smoke.setEmpty = setEmpty
  return <main className="mx-auto max-w-[920px] p-6">
    <h1 className="mb-5 text-base font-medium">视频工作流</h1>
    <CanvasMediaWorkflowForm key={projectId} projectId={projectId} inputs={[input]} assets={empty ? [] : assets}
      writable busy={false} allowCanvasOutput onInputChange={(_index, next) => setInput(next)} />
  </main>
}
document.documentElement.classList.toggle('dark', new URLSearchParams(location.search).get('theme') !== 'light')
/** 独立根可显式卸载以检查所有预览资源释放。 */
const root = createRoot(document.getElementById('root')!)
smoke.unmount = () => root.unmount()
root.render(<Fixture />)
