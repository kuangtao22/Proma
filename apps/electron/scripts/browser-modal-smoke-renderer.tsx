import '@fontsource-variable/inter/index.css'
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { toast } from 'sonner'
import '../src/renderer/styles/globals.css'
import { BrowserSlot } from '../src/renderer/components/browser/BrowserSlot'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../src/renderer/components/ui/alert-dialog'
import { Button } from '../src/renderer/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../src/renderer/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '../src/renderer/components/ui/popover'
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from '../src/renderer/components/ui/sheet'
import { Toaster } from '../src/renderer/components/ui/sonner'

type SmokeTheme = 'light' | 'dark'

interface BrowserModalSmokeApi {
  /** 打开指定测试浮层。 */
  open(kind: 'alert' | 'outer' | 'inner' | 'sheet' | 'popover' | 'nonmodal'): void
  /** 关闭指定测试浮层。 */
  close(kind: 'alert' | 'outer' | 'inner' | 'sheet' | 'popover' | 'nonmodal'): void
  /** 在已有模态弹窗内动态挂载第三个 BrowserSlot。 */
  mountLateSlot(): void
  /** 显示普通 toast，验证非模态浮层不隐藏网页。 */
  showToast(): void
  /** 返回交互结果，供主进程验收原生点击。 */
  getSnapshot(): { confirmCount: number; lateSlotMounted: boolean }
  /** 切换深浅主题，不重建 BrowserSlot。 */
  setTheme(theme: SmokeTheme): void
  /** 完成 smoke 后卸载 React 根。 */
  unmount(): void
}

declare global {
  interface Window {
    __browserModalSmoke: BrowserModalSmokeApi
  }
}

/** 渲染两个真实 BrowserSlot 与生产 Radix 浮层，覆盖原生视图遮挡边界。 */
function BrowserModalFixture(): React.ReactElement {
  /** 当前主题用于同时驱动 DOM class 与 Toaster。 */
  const [theme, setTheme] = React.useState<SmokeTheme>('light')
  /** 回退确认弹窗的受控状态。 */
  const [alertOpen, setAlertOpen] = React.useState(false)
  /** 外层 Dialog 的受控状态。 */
  const [outerOpen, setOuterOpen] = React.useState(false)
  /** 嵌套 AlertDialog 的受控状态。 */
  const [innerOpen, setInnerOpen] = React.useState(false)
  /** Sheet 的受控状态。 */
  const [sheetOpen, setSheetOpen] = React.useState(false)
  /** 普通 Popover 的受控状态。 */
  const [popoverOpen, setPopoverOpen] = React.useState(false)
  /** modal=false Dialog 的受控状态，用作不应避让原生网页的反例。 */
  const [nonmodalOpen, setNonmodalOpen] = React.useState(false)
  /** 是否在模态弹窗期间挂载第三个 BrowserSlot。 */
  const [lateSlotMounted, setLateSlotMounted] = React.useState(false)
  /** 原生鼠标命中确认按钮的累计次数。 */
  const [confirmCount, setConfirmCount] = React.useState(0)
  /** 让命令 API 读取最新交互状态，避免闭包快照过期。 */
  const snapshotRef = React.useRef({ confirmCount, lateSlotMounted })

  snapshotRef.current = { confirmCount, lateSlotMounted }

  React.useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])

  React.useEffect(() => {
    /** fixture 命令面只改变本地 React 状态，不触发任何真实回退或业务动作。 */
    const api: BrowserModalSmokeApi = {
      open(kind) {
        if (kind === 'alert') setAlertOpen(true)
        if (kind === 'outer') setOuterOpen(true)
        if (kind === 'inner') setInnerOpen(true)
        if (kind === 'sheet') setSheetOpen(true)
        if (kind === 'popover') setPopoverOpen(true)
        if (kind === 'nonmodal') setNonmodalOpen(true)
      },
      close(kind) {
        if (kind === 'alert') setAlertOpen(false)
        if (kind === 'outer') setOuterOpen(false)
        if (kind === 'inner') setInnerOpen(false)
        if (kind === 'sheet') setSheetOpen(false)
        if (kind === 'popover') setPopoverOpen(false)
        if (kind === 'nonmodal') setNonmodalOpen(false)
      },
      mountLateSlot() { setLateSlotMounted(true) },
      showToast() { toast('普通通知不会遮挡网页', { id: 'browser-modal-smoke-toast' }) },
      getSnapshot() { return snapshotRef.current },
      setTheme(nextTheme) { setTheme(nextTheme) },
      unmount() { root.unmount() },
    }
    window.__browserModalSmoke = api
  }, [])

  return (
    <main className="overflow-hidden bg-background text-foreground" style={{ height: '100vh' }}>
      <header className="flex h-14 items-center justify-between border-b px-5">
        <div>
          <p className="text-sm font-semibold">原生浏览器模态避让回归</p>
          <p className="text-xs text-muted-foreground">隔离 fixture，不执行真实回退</p>
        </div>
        <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
          <PopoverTrigger asChild><Button data-testid="popover-trigger" variant="outline">普通 Popover</Button></PopoverTrigger>
          <PopoverContent data-testid="popover-content">这个浮层不应隐藏浏览器。</PopoverContent>
        </Popover>
      </header>

      <section style={{ display: 'grid', gridTemplateColumns: '36% 64%', height: 'calc(100vh - 3.5rem)' }}>
        <div className="space-y-3 border-r p-5">
          <h1 className="text-xl font-semibold">确认回退</h1>
          <p className="text-sm text-muted-foreground">弹窗横跨网页左边界，按钮区域落在原生网页之上。</p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setAlertOpen(true)}>打开确认回退</Button>
            <Button variant="outline" onClick={() => setOuterOpen(true)}>打开嵌套弹窗</Button>
            <Button variant="outline" onClick={() => setSheetOpen(true)}>打开 Sheet</Button>
          </div>
        </div>
        <div className="min-w-0 bg-muted/30 p-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div style={{ display: 'flex', minHeight: 0 }}><BrowserSlot sessionId="modal-smoke" tabId="left-tab" /></div>
          <div style={{ display: 'flex', minHeight: 0 }}><BrowserSlot sessionId="modal-smoke" tabId="right-tab" /></div>
          {lateSlotMounted && (
            <div className="absolute bottom-4 right-4 border bg-background p-1" style={{ display: 'flex', flexDirection: 'column', width: 288, height: 176 }}>
              <BrowserSlot sessionId="modal-smoke" tabId="late-tab" />
            </div>
          )}
        </div>
      </section>

      <AlertDialog open={alertOpen} onOpenChange={setAlertOpen}>
        <AlertDialogContent data-testid="rollback-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>确认回退</AlertDialogTitle>
            <AlertDialogDescription>回退将截断该消息之后的所有对话，并恢复文件到该时点。可撤销，确定要回退吗？</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="rollback-cancel">取消</AlertDialogCancel>
            <AlertDialogAction data-testid="rollback-confirm" onClick={() => setConfirmCount((count) => count + 1)}>确认回退</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={outerOpen} onOpenChange={setOuterOpen}>
        <DialogContent data-testid="outer-dialog" hideClose>
          <DialogTitle>外层弹窗</DialogTitle>
          <DialogDescription>关闭内层后，外层仍应继续遮挡原生网页。</DialogDescription>
          <div className="flex justify-end gap-2">
            <Button data-testid="open-inner" onClick={() => setInnerOpen(true)}>打开内层</Button>
            <DialogClose asChild><Button data-testid="close-outer" variant="outline">关闭外层</Button></DialogClose>
          </div>
          <AlertDialog open={innerOpen} onOpenChange={setInnerOpen}>
            <AlertDialogContent data-testid="inner-dialog">
              <AlertDialogHeader><AlertDialogTitle>内层确认</AlertDialogTitle></AlertDialogHeader>
              <AlertDialogFooter><AlertDialogCancel data-testid="close-inner">关闭内层</AlertDialogCancel></AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </DialogContent>
      </Dialog>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent data-testid="test-sheet" side="right" hideClose>
          <SheetTitle>右侧设置</SheetTitle>
          <SheetDescription>Sheet 关闭动画结束前，网页不能提前出现。</SheetDescription>
          <SheetClose asChild><Button data-testid="close-sheet" className="mt-6">关闭 Sheet</Button></SheetClose>
        </SheetContent>
      </Sheet>
      <Dialog modal={false} open={nonmodalOpen} onOpenChange={setNonmodalOpen}>
        <DialogContent data-testid="nonmodal-dialog" hideClose>
          <DialogTitle>非模态检查器</DialogTitle>
          <DialogDescription>modal=false 的 Dialog 不应隐藏原生网页。</DialogDescription>
        </DialogContent>
      </Dialog>
      <Toaster />
    </main>
  )
}

/** React 根保存在模块级，供隔离 smoke 完成后显式卸载。 */
const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('找不到 browser modal smoke 根节点')
const root: Root = createRoot(rootElement)
root.render(
  <React.StrictMode>
    <BrowserModalFixture />
  </React.StrictMode>,
)
