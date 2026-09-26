import * as React from 'react'
import { useAtom, useStore } from 'jotai'
import { AppShell } from './components/app-shell/AppShell'
import { OnboardingView } from './components/onboarding/OnboardingView'
import { EnvironmentCheckDialog } from './components/environment/EnvironmentCheckDialog'
import { TooltipProvider } from './components/ui/tooltip'
import { ShortcutGuideDialog } from './components/shortcuts/ShortcutGuideDialog'
import { FaqDialog } from './components/shortcuts/FaqDialog'
import { WindowControls } from './components/WindowControls'
import { detectIsWindows } from './lib/platform'
import { getWindowTitlebarContentInsetClass } from './lib/window-titlebar-layout'
import { cn } from './lib/utils'
import { PlanningReminderRail } from './components/planning/PlanningReminderRail'
import { environmentCheckDialogOpenAtom } from './atoms/environment'
import { onboardingReplayRequestedAtom } from './atoms/onboarding'
import { settingsOpenAtom, settingsTabAtom } from './atoms/settings-tab'
import { hasCompletedCurrentOnboarding } from '../types'
import dutydeckIcon from './assets/brand/dutydeck-icon.png'

export default function App(): React.ReactElement {
  // 应用级初始化状态。

  const store = useStore()
  const [isLoading, setIsLoading] = React.useState(true)
  const [showOnboarding, setShowOnboarding] = React.useState(false)
  const [onboardingReplayRequested, setOnboardingReplayRequested] = useAtom(onboardingReplayRequestedAtom)
  const [isReplayingOnboarding, setIsReplayingOnboarding] = React.useState(false)
  const isWindows = React.useMemo(() => detectIsWindows(), [])

  // 初始化：检查是否需要显示 Onboarding
  // macOS/Linux 上 SDK 自带 claude native binary 不依赖宿主 Node/Git；
  // Windows 上仍需 Git Bash/WSL，由 Onboarding Step 2 与聊天错误卡片引导用户安装。
  React.useEffect(() => {
    const initialize = async () => {
      try {
        const settings = await window.electronAPI.getSettings()
        if (!hasCompletedCurrentOnboarding(settings)) {
          setShowOnboarding(true)
        }
      } catch (error) {
        console.error('[App] 初始化失败:', error)
      } finally {
        setIsLoading(false)
      }
    }

    initialize()
  }, [])

  // 设置页请求重放时跳过欢迎页，但保留完整的后续 Onboarding 流程。
  React.useEffect(() => {
    if (!onboardingReplayRequested || isLoading) return

    setIsReplayingOnboarding(true)
    setShowOnboarding(true)
    setOnboardingReplayRequested(false)
  }, [isLoading, onboardingReplayRequested, setOnboardingReplayRequested])

  // 完成 onboarding 回调：重放时回到设置页，首次完成直接进入主界面
  const handleOnboardingComplete = () => {
    const replayingOnboarding = isReplayingOnboarding
    setShowOnboarding(false)
    setIsReplayingOnboarding(false)

    if (replayingOnboarding) {
      store.set(settingsTabAtom, 'onboarding')
      store.set(settingsOpenAtom, true)
    }
  }

  // 加载中状态
  if (isLoading) {
    return <StartupLoadingScreen />
  }

  // 显示 onboarding 界面
  if (showOnboarding) {
    return (
      <TooltipProvider delayDuration={200} disableHoverableContent>
        <div className={cn('relative h-screen w-screen overflow-hidden', getWindowTitlebarContentInsetClass(isWindows))}>
          <WindowControls />
          <OnboardingView
            initialStep={isReplayingOnboarding ? 'guide' : 'welcome'}
            onComplete={handleOnboardingComplete}
          />
        </div>
      </TooltipProvider>
    )
  }

  // 显示主界面
  return (
    <TooltipProvider delayDuration={200} disableHoverableContent>
      <AppShell />
      <PlanningReminderRail />
      <ShortcutGuideDialog />
      <FaqDialog />
      <GlobalEnvironmentCheckDialog />
    </TooltipProvider>
  )
}

/**
 * 冷启动时的应用内启动屏。
 *
 * 视觉与原生启动页（resources/startup-splash/index.html）严格对齐：同一套 ink 渐变底、
 * 同一张应用图标、同一句定位语——否则用户会连着看到两张不同品牌的启动画面。
 * 这里不再使用上游插画与绿色底（插画在部分地区的著作权仍未过期）。
 */
function StartupLoadingScreen(): React.ReactElement {
  return (
    <main
      className="relative flex h-screen items-center justify-center overflow-hidden bg-[#0b0d10] text-[#f1f5f9]"
      aria-busy="true"
      aria-live="polite"
    >
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(620px 420px at 50% 44%, rgba(255,255,255,0.07), transparent 68%), linear-gradient(168deg, #0e1418 0%, #0b0d10 58%, #0a0c0f 100%)',
        }}
      />

      <div className="relative flex w-full max-w-sm flex-col items-center px-8 text-center">
        <img
          src={dutydeckIcon}
          alt=""
          className="h-24 w-24 rounded-[22px] shadow-[0_18px_44px_rgba(0,0,0,0.55)]"
        />
        <p className="mt-7 text-3xl font-semibold tracking-[-0.01em]">DutyDeck</p>
        <p className="mt-3 max-w-xs text-sm leading-relaxed text-white/60">本地优先的工程工作台</p>
        <p className="mt-2 text-[11px] tracking-[0.26em] text-white/40">画布 · 运维 · 接口 · Agent</p>

        <div className="mt-8 h-[3px] w-32 overflow-hidden rounded-full bg-white/10">
          <div className="h-full w-2/5 animate-pulse rounded-full bg-white/90" />
        </div>
        <p className="mt-4 text-xs tracking-[0.24em] text-white/45">正在启动</p>
      </div>

      <p className="absolute bottom-7 px-6 text-center text-[10px] uppercase tracking-[0.28em] text-white/25">
        ON DUTY
      </p>
    </main>
  )
}

/**
 * 全局环境检测 Dialog，由错误卡片的 recovery action 按钮打开。
 */
function GlobalEnvironmentCheckDialog(): React.ReactElement {
  const [open, setOpen] = useAtom(environmentCheckDialogOpenAtom)
  return <EnvironmentCheckDialog open={open} onOpenChange={setOpen} />
}
