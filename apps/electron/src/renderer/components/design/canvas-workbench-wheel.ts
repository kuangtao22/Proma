/** 判断当前详情是否通过 aria-controls 拥有目标 Portal，包含嵌套菜单。 */
function ownsCanvasWorkbenchPortal(section: HTMLElement, target: Element): boolean {
  if (!target.closest('[role="dialog"], [role="listbox"], [role="menu"]')) return false
  /** 只检查当前详情及其已打开的菜单，不遍历画布节点或其他工作台。 */
  const scopes: Element[] = [section]
  /** 防止嵌套控件相互引用，保证每个菜单最多检查一次。 */
  const visited = new Set<Element>(scopes)
  for (const scope of scopes) {
    for (const trigger of scope.querySelectorAll('[aria-controls]')) {
      for (const id of (trigger.getAttribute('aria-controls') ?? '').split(/\s+/)) {
        /** Radix Portal 使用触发器明确关联的 DOM 身份，不依赖屏幕位置猜测归属。 */
        const controlled = section.ownerDocument.getElementById(id)
        if (!controlled || visited.has(controlled)) continue
        if (controlled.contains(target)) return true
        visited.add(controlled)
        scopes.push(controlled)
      }
    }
  }
  return false
}

/** 判断普通滚轮是否与详情交互冲突；滚动到边界后也继续归列表所有。 */
function hasCanvasWorkbenchWheelConflict(section: HTMLElement, target: Element): boolean {
  /** 仅沿本次命中元素的祖先向上检查，成本与画布节点数量无关。 */
  for (let element: Element | null = target; element && element !== section; element = element.parentElement) {
    if (element.matches('input, textarea, select, video, audio, iframe, [contenteditable]:not([contenteditable="false"]), [role="slider"], [role="spinbutton"], [role="scrollbar"], .nowheel')) return true
    /** Radix 自绘滚动条是 viewport 的兄弟元素，普通 wheel 仍由滚动条处理。 */
    if (element.hasAttribute('data-orientation')
      && element.parentElement?.querySelector(':scope > [data-radix-scroll-area-viewport]')) return true
    /** 先查是否存在溢出，空列表和未溢出的面板无需读取计算样式。 */
    if (element.scrollHeight <= element.clientHeight && element.scrollWidth <= element.clientWidth) continue
    /** overflow-hidden 只裁剪内容，不代表该区域拥有滚动交互。 */
    const style = section.ownerDocument.defaultView?.getComputedStyle(element)
    if (!style) continue
    if ((element.scrollHeight > element.clientHeight && /^(auto|scroll|overlay)$/.test(style.overflowY))
      || (element.scrollWidth > element.clientWidth && /^(auto|scroll|overlay)$/.test(style.overflowX))) return true
  }
  return false
}

/**
 * 安装当前详情的滚轮路由：无冲突时平移，各类区域均可用修饰滚轮或捏合缩放。
 * @param section 当前详情外壳，包含输入与列表，Portal 通过 aria-controls 关联。
 * @param isResizing 是否正在拖拽尺寸手柄，避免中途更换其冻结的缩放比例。
 * @returns 卸载原生监听器的清理函数；未挂在画布中时不接管任何事件。
 */
export function bindCanvasWorkbenchWheel(
  section: HTMLElement,
  isResizing: () => boolean,
): () => void {
  /** 转发到同一张画布的既有 XYFlow 手势入口，复用范围限制及视口提交时序。 */
  const renderer = section.closest('.react-flow__renderer')
  if (!renderer) return () => undefined

  /** 使用非 passive 原生捕获监听器，可取消页面缩放并覆盖所属 Portal 的滚动锁。 */
  const handleWheel = (event: WheelEvent): void => {
    if (!(event.target instanceof Element)) return
    /** 触控板捏合在 Chromium 中以 Ctrl wheel 表示，Command wheel 同样表示画布缩放。 */
    const zoom = event.ctrlKey || event.metaKey
    if (!section.contains(event.target) && (!zoom || !ownsCanvasWorkbenchPortal(section, event.target))) return
    if (isResizing() || event.buttons !== 0) return
    if (!zoom && hasCanvasWorkbenchWheelConflict(section, event.target)) return

    /** XYFlow 在 Mac 上给 Ctrl 捏合乘 10；Command 转换时抵消该系数，保持画布内外同速。 */
    const deltaY = event.metaKey && !event.ctrlKey
      && section.ownerDocument.defaultView?.navigator.userAgent.includes('Mac')
      ? event.deltaY / 10
      : event.deltaY
    event.preventDefault()
    event.stopImmediatePropagation()
    /** 保留原始滚轮单位和屏幕落点；重定向后不再命中详情，因此不会重复处理。 */
    renderer.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: section.ownerDocument.defaultView,
      deltaX: event.deltaX,
      deltaY,
      deltaZ: event.deltaZ,
      deltaMode: event.deltaMode,
      clientX: event.clientX,
      clientY: event.clientY,
      screenX: event.screenX,
      screenY: event.screenY,
      /** 统一缩放意图，避免编辑器聚焦时 XYFlow 的快捷键状态不接收 Command。 */
      ctrlKey: zoom,
      metaKey: event.metaKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
    }))
  }

  section.ownerDocument.addEventListener('wheel', handleWheel, { capture: true, passive: false })
  return () => section.ownerDocument.removeEventListener('wheel', handleWheel, true)
}
