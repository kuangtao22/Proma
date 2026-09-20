import * as React from 'react'
import { useStore } from 'jotai'
import { browserModalCountAtom } from '@/atoms/browser-modal-atoms'

/** 共享 Dialog / Sheet 的模态语义；modal=false 的内容不遮挡原生网页。 */
export const BrowserModalContext = React.createContext(true)

/**
 * 将实际挂载的模态内容登记到浏览器避让状态，并透传调用方 ref。
 * @param forwardedRef 调用方需要接收的内容节点引用。
 * @param enabled 是否属于阻塞交互的模态弹窗。
 * @returns 交给 Radix Content 的稳定 ref；Presence 退出动画结束、DOM 卸载时才释放。
 */
export function useBrowserModalRef<T extends HTMLElement>(
  forwardedRef?: React.ForwardedRef<T>,
  enabled = true,
): React.RefCallback<T> {
  /** 与当前窗口 BrowserSlot 共用的 Jotai store。 */
  const store = useStore()
  /** 防止重复绑定或空 ref 回调导致重复计数。 */
  const registeredRef = React.useRef(false)

  return React.useCallback((element: T | null) => {
    /** 只有真正存在的模态节点才需要原生网页避让。 */
    const registered = enabled && element !== null
    if (registeredRef.current !== registered) {
      registeredRef.current = registered
      store.set(browserModalCountAtom, (count) => count + (registered ? 1 : -1))
    }
    if (typeof forwardedRef === 'function') forwardedRef(element)
    else if (forwardedRef) forwardedRef.current = element
  }, [enabled, forwardedRef, store])
}
