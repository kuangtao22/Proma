import '@fontsource-variable/inter/index.css'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import type {
  AudioGenerationSettingsResult,
  AudioGenerationTestInput,
  AudioGenerationTestResult,
  MediaPreloadApi,
  ReplaceAudioGenerationCatalogRequest,
} from '@proma/shared'
import {
  AudioGenerationSettings,
} from '../src/renderer/components/settings/AudioGenerationSettings'
import {
  DEFAULT_MEDIA_SETTINGS_TAB,
  MEDIA_SETTINGS_TABS,
  MediaSettingsTabsView,
} from '../src/renderer/components/settings/MediaSettings'
import type { MediaSettingsTab } from '../src/renderer/components/settings/MediaSettings'
import '../src/renderer/styles/globals.css'

type ReplaceFailure = 'conflict' | 'failed' | null

/** 可控测试请求只保存公开 requestId 与完成入口。 */
interface DeferredAudioTest {
  input: AudioGenerationTestInput
  resolve: (result: AudioGenerationTestResult) => void
}

/** Electron 进程只读取该快照，避免直接取得 fixture 的可变集合。 */
interface AudioGenerationSmokeSnapshot {
  currentTab: MediaSettingsTab
  domContainsFakeSecret: boolean
  cancelCalls: string[]
  replacePayloads: ReplaceAudioGenerationCatalogRequest[]
  testRequestIds: string[]
  currentTestState: 'loading' | 'success' | 'failed' | 'cancelled' | 'unavailable' | null
}

/** fixture 暴露的窄观察与故障注入接口，不进入生产 preload。 */
interface AudioGenerationSmokeApi {
  getSnapshot: () => AudioGenerationSmokeSnapshot
  rerender: () => void
  resolveTest: (requestId: string, state: AudioGenerationTestResult['state']) => boolean
  setNextReplaceFailure: (failure: Exclude<ReplaceFailure, null>) => void
}

declare global {
  interface Window {
    __audioGenerationSmoke: AudioGenerationSmokeApi
  }
}

/** 明显的测试凭据，只在密码输入与内存请求中短暂存在。 */
const fakeSecret = 'secret-key-audio-smoke'
/** 固定初始目录同时覆盖小米、MiniMax 与旧目录引用。 */
const initialSettings: AudioGenerationSettingsResult = {
  catalog: {
    schemaVersion: 2,
    revision: 7,
    profiles: [
      {
        id: 'xiaomi-smoke',
        name: '小米配音测试',
        provider: 'xiaomi',
        baseUrl: 'https://tts-smoke.example.com/v1',
        endpointOrigin: 'https://tts-smoke.example.com',
        models: [{ id: 'xiaomi-tts-smoke', voices: [{ id: 'xiaomi-voice-smoke', name: '小米 smoke 音色', source: 'manual' }] }],
        enabled: true,
        credentialConfigured: true,
        createdAt: 100,
        updatedAt: 100,
      },
      {
        id: 'minimax-smoke',
        name: 'MiniMax 配音测试',
        provider: 'minimax',
        baseUrl: 'https://minimax-smoke.example.com/v1',
        endpointOrigin: 'https://minimax-smoke.example.com',
        models: [{ id: 'speech-02-hd', voices: [{ id: 'minimax-voice-smoke', name: 'MiniMax smoke 音色', source: 'manual' }] }],
        groupId: 'group-smoke',
        enabled: true,
        credentialConfigured: true,
        legacyMediaProfileId: 'legacy-minimax-smoke',
        createdAt: 200,
        updatedAt: 200,
      },
    ],
  },
  legacyAudioProfiles: [{
    id: 'legacy-minimax-smoke',
    name: '旧 MiniMax Speech',
    protocol: 'minimax-speech',
    modelId: 'speech-01-turbo',
    enabled: true,
  }],
}

/** 当前内存目录，页面保存只更新该副本。 */
let settings = structuredClone(initialSettings)
/** 当前页签供 Electron 断言读取。 */
let observedTab: MediaSettingsTab = DEFAULT_MEDIA_SETTINGS_TAB
/** 取消与完整替换调用只保存于当前 Renderer 生命周期。 */
const cancelCalls: string[] = []
const replacePayloads: ReplaceAudioGenerationCatalogRequest[] = []
/** 测试 Promise 由 Electron 断言按 requestId 精确完成。 */
const deferredTests = new Map<string, DeferredAudioTest>()
/** 下一次替换的可控失败，用于真实 AlertDialog 关闭行为。 */
let nextReplaceFailure: ReplaceFailure = null
/** React 状态更新入口在 Fixture 首次渲染后赋值。 */
let requestRerender: () => void = () => undefined

/** 返回隔离的公开目录，避免组件偶然修改 fixture 权威数据。 */
function cloneSettings(): AudioGenerationSettingsResult {
  return structuredClone(settings)
}

/** 将替换请求投影为不含凭据的 Renderer 公开目录。 */
function applyReplaceRequest(request: ReplaceAudioGenerationCatalogRequest): AudioGenerationSettingsResult {
  /** 保存前目录按 ID 提供 preserve 凭据状态。 */
  const previous = new Map(settings.catalog.profiles.map((profile) => [profile.id, profile]))
  settings = {
    ...settings,
    catalog: {
      schemaVersion: 2,
      revision: settings.catalog.revision + 1,
      profiles: request.profiles.map(({ profile, credentialUpdate }) => ({
        ...structuredClone(profile),
        credentialConfigured: credentialUpdate.mode === 'replace'
          ? true
          : previous.get(profile.id)?.credentialConfigured ?? false,
        endpointOrigin: new URL(profile.baseUrl).origin,
      })),
    },
  }
  return cloneSettings()
}

/** 仅注入音频设置页实际读取的四个 IPC 方法。 */
const fixtureApi: Pick<
  MediaPreloadApi,
  | 'mediaGetAudioGenerationSettings'
  | 'mediaReplaceAudioGenerationCatalog'
  | 'mediaTestAudioGeneration'
  | 'mediaFetchAudioGenerationCatalog'
  | 'mediaCancelAudioGenerationTest'
> = {
  mediaGetAudioGenerationSettings: async () => cloneSettings(),
  mediaReplaceAudioGenerationCatalog: async (request) => {
    replacePayloads.push(structuredClone(request))
    const failure = nextReplaceFailure
    nextReplaceFailure = null
    if (failure === 'conflict') throw new Error('AUDIO_GENERATION_CONFIG_CONFLICT')
    if (failure === 'failed') throw new Error('AUDIO_GENERATION_CONFIG_WRITE_FAILED')
    return applyReplaceRequest(request)
  },
  mediaTestAudioGeneration: (input) => new Promise<AudioGenerationTestResult>((resolve) => {
    deferredTests.set(input.requestId, { input: structuredClone(input), resolve })
  }),
  mediaCancelAudioGenerationTest: async (requestId) => {
    cancelCalls.push(requestId)
  },
  /** 固定回放供应商目录，覆盖模型列表与远端音色两条路径。 */
  mediaFetchAudioGenerationCatalog: async (input) => ({
    requestId: input.requestId,
    state: 'success' as const,
    message: '已从供应商获取可用模型与音色',
    /** 主进程已过滤掉对话模型，这里回放的是语音模型清单。 */
    models: ['mimo-v2.5-tts', 'mimo-v2.5-tts-voiceclone'],
    voices: [{ id: 'remote-voice-smoke', name: '远端 smoke 音色', source: 'remote' as const }],
  }),
}

Object.assign(window, { electronAPI: fixtureApi })

/** 从真实可见文案读取当前测试状态，不访问 Controller 内部实现。 */
function readCurrentTestState(): AudioGenerationSmokeSnapshot['currentTestState'] {
  /** 页面当前公开文本。 */
  const text = document.body.textContent ?? ''
  if (text.includes('正在测试')) return 'loading'
  if (text.includes('测试成功')) return 'success'
  if (text.includes('测试失败')) return 'failed'
  if (text.includes('测试已取消')) return 'cancelled'
  if (text.includes('暂不可测试')) return 'unavailable'
  return null
}

/** 冻结顶层接口，所有集合均通过结构化副本只读观察。 */
window.__audioGenerationSmoke = Object.freeze({
  getSnapshot: (): AudioGenerationSmokeSnapshot => ({
    currentTab: observedTab,
    domContainsFakeSecret: document.documentElement.outerHTML.includes(fakeSecret)
      || (document.body.textContent ?? '').includes(fakeSecret),
    cancelCalls: [...cancelCalls],
    replacePayloads: structuredClone(replacePayloads),
    testRequestIds: [...deferredTests.keys()],
    currentTestState: readCurrentTestState(),
  }),
  rerender: () => requestRerender(),
  resolveTest: (requestId, state) => {
    const deferred = deferredTests.get(requestId)
    if (!deferred) return false
    deferred.resolve({ requestId, state, message: `fixture-${state}` })
    return true
  },
  setNextReplaceFailure: (failure) => { nextReplaceFailure = failure },
})

/** 在四个真实页签间切换，音频页挂载真实生产组件。 */
function Fixture(): React.ReactElement {
  const [activeTab, setActiveTab] = React.useState<MediaSettingsTab>(DEFAULT_MEDIA_SETTINGS_TAB)
  const [focusActiveTab, setFocusActiveTab] = React.useState(false)
  const [, setRenderGeneration] = React.useState(0)
  observedTab = activeTab
  requestRerender = () => setRenderGeneration((value) => value + 1)
  React.useEffect(() => {
    if (!focusActiveTab) return
    /** 焦点已由 active trigger 接管后关闭一次性 autoFocus。 */
    const frame = requestAnimationFrame(() => setFocusActiveTab(false))
    return () => cancelAnimationFrame(frame)
  }, [activeTab, focusActiveTab])

  /** 与生产父页一致：用户切页才为新活动页签恢复焦点。 */
  const navigation = <MediaSettingsTabsView
    activeTab={activeTab}
    focusActiveTab={focusActiveTab}
    onTabChange={(tab) => {
      setFocusActiveTab(true)
      setActiveTab(tab)
    }}
  />
  if (activeTab === 'audio-generation') {
    return <main data-smoke-shell className="min-h-screen min-w-0 overflow-x-hidden bg-background p-6 text-foreground">
      <div className="mx-auto w-full max-w-5xl"><AudioGenerationSettings navigation={navigation} /></div>
    </main>
  }
  /** 其它页只保留真实一级导航，避免 fixture 注入无关媒体 API。 */
  const title = MEDIA_SETTINGS_TABS.find((tab) => tab.value === activeTab)?.label ?? ''
  return <main data-smoke-shell className="min-h-screen min-w-0 overflow-x-hidden bg-background p-6 text-foreground">
    <section className="mx-auto w-full max-w-5xl space-y-6">
      {navigation}
      <div className="border border-border bg-card p-5 text-card-foreground">
        <h1 className="text-lg font-semibold">{title}</h1>
      </div>
    </section>
  </main>
}

document.documentElement.classList.toggle('dark', new URLSearchParams(location.search).get('theme') === 'dark')
const root = createRoot(document.getElementById('root')!)
root.render(<Fixture />)
