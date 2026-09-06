/** Electron renderer 的轻量分流入口。 */
import '@fontsource-variable/inter/index.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles/globals.css'

/** 当前窗口类型，用于在加载普通业务模块前完成轻量窗口分流。 */
const rendererWindowType = new URLSearchParams(window.location.search).get('window')

/** 路径管理窗口必须保持最小依赖，避免加载普通业务模块。 */
const isDataRootManagementWindow = rendererWindowType === 'data-root-migration'

/** 仅主窗口需要初始化完整的 Bot 状态与生产力工具偏好。 */
const isMainApplicationWindow = !rendererWindowType

/**
 * 初始化官方新增的主窗口状态。
 *
 * 普通渲染器仍保持 Bone 的模块拆分；这里仅补齐尚未迁入该模块的 Slack
 * 状态订阅与生产力工具偏好，后续可随入口重构一并下沉。
 */
async function initializeMainWindowState(): Promise<void> {
  /** 并行加载状态容器与相关 atoms，避免增加串行启动开销。 */
  const [jotaiModule, slackAtomsModule, uiPreferencesModule] = await Promise.all([
    import('jotai'),
    import('./atoms/slack-atoms'),
    import('./atoms/ui-preferences'),
  ])

  /** 默认 store 与 React 根节点使用同一份 Jotai 状态。 */
  const store = jotaiModule.getDefaultStore()

  void uiPreferencesModule.initializeUiPreferences(
    undefined,
    undefined,
    undefined,
    (settings) => store.set(uiPreferencesModule.productivityToolsAtom, settings),
  )

  void window.electronAPI.getSlackStatus()
    .then((multiState) => store.set(slackAtomsModule.slackBotStatesAtom, multiState.bots))
    .catch((error: unknown) => console.error('[SlackInitializer] 加载状态失败:', error))

  /** Slack 状态监听器在窗口生命周期内持续同步各 Bot 状态。 */
  const disposeSlackStatus = window.electronAPI.onSlackStatusChanged((state) => {
    store.set(slackAtomsModule.slackBotStatesAtom, (previous) => ({
      ...previous,
      [state.botId]: state,
    }))
  })

  /** 窗口销毁前解除主进程事件订阅。 */
  const handleBeforeUnload = (): void => {
    disposeSlackStatus()
  }
  window.addEventListener('beforeunload', handleBeforeUnload, { once: true })
}

/** 加载 Bone 拆分后的普通渲染器，并按窗口职责补齐主窗口初始化。 */
async function loadNormalRenderer(): Promise<void> {
  if (isMainApplicationWindow) {
    await initializeMainWindowState()
  }
  await import('./normal-renderer-main')
}

if (isDataRootManagementWindow) {
  import('./components/path-management/DataRootMigrationApp').then(({ DataRootMigrationApp }) => {
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <DataRootMigrationApp />
      </React.StrictMode>,
    )
  })
} else {
  void loadNormalRenderer()
}
