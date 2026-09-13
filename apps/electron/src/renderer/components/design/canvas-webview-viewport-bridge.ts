/** 父页面向 iframe 私有初始化通道发送的唯一消息类型。 */
export const CANVAS_WEBVIEW_VIEWPORT_INIT_MESSAGE_TYPE = 'proma:canvas-webview-viewport-init'

/** iframe 私有端口允许发送的唯一视口消息类型。 */
export const CANVAS_WEBVIEW_VIEWPORT_MESSAGE_TYPE = 'proma:canvas-webview-viewport-wheel'

/** iframe 缩放手势通过私有端口传给父页面的最小滚轮数据。 */
interface CanvasWebviewViewportWheelMessage {
  type: typeof CANVAS_WEBVIEW_VIEWPORT_MESSAGE_TYPE
  deltaX: number
  deltaY: number
  deltaZ: number
  deltaMode: number
  clientX: number
  clientY: number
  ctrlKey: boolean
  metaKey: boolean
}

/** 父页面换算坐标所需的 iframe 当前几何数据。 */
export interface CanvasWebviewViewportFrameMetrics {
  left: number
  top: number
  width: number
  height: number
  contentWidth: number
  contentHeight: number
}

/**
 * 注入 sandbox iframe 的私有缩放桥。
 * 脚本先捕获原生能力再注册监听，后续不可信正文无法通过覆写 prototype 窃取端口或伪造输入。
 */
export const CANVAS_WEBVIEW_VIEWPORT_BRIDGE_SCRIPT = `<script>(()=>{
  const expectedParent=window.parent
  const apply=Reflect.apply
  const descriptor=Object.getOwnPropertyDescriptor
  const sourceGetter=descriptor(MessageEvent.prototype,'source')?.get
  const dataGetter=descriptor(MessageEvent.prototype,'data')?.get
  const portsGetter=descriptor(MessageEvent.prototype,'ports')?.get
  const ctrlKeyGetter=descriptor(MouseEvent.prototype,'ctrlKey')?.get
  const metaKeyGetter=descriptor(MouseEvent.prototype,'metaKey')?.get
  const clientXGetter=descriptor(MouseEvent.prototype,'clientX')?.get
  const clientYGetter=descriptor(MouseEvent.prototype,'clientY')?.get
  const deltaXGetter=descriptor(WheelEvent.prototype,'deltaX')?.get
  const deltaYGetter=descriptor(WheelEvent.prototype,'deltaY')?.get
  const deltaZGetter=descriptor(WheelEvent.prototype,'deltaZ')?.get
  const deltaModeGetter=descriptor(WheelEvent.prototype,'deltaMode')?.get
  const addEventListener=EventTarget.prototype.addEventListener
  const preventDefault=Event.prototype.preventDefault
  const stopImmediatePropagation=Event.prototype.stopImmediatePropagation
  const postMessage=MessagePort.prototype.postMessage
  const closePort=MessagePort.prototype.close
  if (!sourceGetter||!dataGetter||!portsGetter||!ctrlKeyGetter||!metaKeyGetter||!clientXGetter||!clientYGetter||!deltaXGetter||!deltaYGetter||!deltaZGetter||!deltaModeGetter) return
  const getIsTrusted=(event)=>event.isTrusted
  const getSource=(event)=>apply(sourceGetter,event,[])
  const getData=(event)=>apply(dataGetter,event,[])
  const getPorts=(event)=>apply(portsGetter,event,[])
  const getCtrlKey=(event)=>apply(ctrlKeyGetter,event,[])
  const getMetaKey=(event)=>apply(metaKeyGetter,event,[])
  const getClientX=(event)=>apply(clientXGetter,event,[])
  const getClientY=(event)=>apply(clientYGetter,event,[])
  const getDeltaX=(event)=>apply(deltaXGetter,event,[])
  const getDeltaY=(event)=>apply(deltaYGetter,event,[])
  const getDeltaZ=(event)=>apply(deltaZGetter,event,[])
  const getDeltaMode=(event)=>apply(deltaModeGetter,event,[])
  const listen=(target,type,listener,options)=>apply(addEventListener,target,[type,listener,options])
  const cancelDefault=(event)=>apply(preventDefault,event,[])
  const stopNow=(event)=>apply(stopImmediatePropagation,event,[])
  const postPortMessage=(port,message)=>apply(postMessage,port,[message])
  const closeViewportPort=(port)=>apply(closePort,port,[])
  let viewportPort=null
  listen(window,'message',(event)=>{
    if (!getIsTrusted(event) || getSource(event) !== expectedParent) return
    const data=getData(event)
    if (!data || data.type!=='${CANVAS_WEBVIEW_VIEWPORT_INIT_MESSAGE_TYPE}') return
    const ports=getPorts(event)
    if (ports.length!==1) return
    stopNow(event)
    if (viewportPort) closeViewportPort(viewportPort)
    viewportPort=ports[0]
  },true)
  listen(window,'wheel',(event)=>{
    if (!getIsTrusted(event) || (!getCtrlKey(event) && !getMetaKey(event))) return
    if (!viewportPort) return
    cancelDefault(event)
    stopNow(event)
    postPortMessage(viewportPort,{
      type:'${CANVAS_WEBVIEW_VIEWPORT_MESSAGE_TYPE}',
      deltaX:getDeltaX(event),
      deltaY:getDeltaY(event),
      deltaZ:getDeltaZ(event),
      deltaMode:getDeltaMode(event),
      clientX:getClientX(event),
      clientY:getClientY(event),
      ctrlKey:getCtrlKey(event),
      metaKey:getMetaKey(event)
    })
  },{capture:true,passive:false})
})()</script>`

/** 判断私有端口消息值是否为有界有限数值，避免构造异常浏览器事件。 */
function isFiniteBridgeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000
}

/** 校验私有端口消息的结构、修饰键和有限字段。 */
function parseCanvasWebviewViewportWheelMessage(data: unknown): CanvasWebviewViewportWheelMessage | null {
  if (typeof data !== 'object' || data === null) return null
  const message = data as Partial<CanvasWebviewViewportWheelMessage>
  if (message.type !== CANVAS_WEBVIEW_VIEWPORT_MESSAGE_TYPE
    || !isFiniteBridgeNumber(message.deltaX)
    || !isFiniteBridgeNumber(message.deltaY)
    || !isFiniteBridgeNumber(message.deltaZ)
    || !isFiniteBridgeNumber(message.deltaMode)
    || !isFiniteBridgeNumber(message.clientX)
    || !isFiniteBridgeNumber(message.clientY)
    || typeof message.ctrlKey !== 'boolean'
    || typeof message.metaKey !== 'boolean'
    || (!message.ctrlKey && !message.metaKey)
    || !Number.isInteger(message.deltaMode)
    || message.deltaMode < 0
    || message.deltaMode > 2) return null
  return message as CanvasWebviewViewportWheelMessage
}

/**
 * 校验私有端口数据，并将 iframe 内容坐标映射到父页面的屏幕坐标。
 * @returns 可用于派发给画布的滚轮事件参数；非法数据返回 null。
 */
export function createCanvasWebviewViewportPortWheelEventInit(
  data: unknown,
  metrics: CanvasWebviewViewportFrameMetrics,
): WheelEventInit | null {
  const message = parseCanvasWebviewViewportWheelMessage(data)
  if (!message
    || !isFiniteBridgeNumber(metrics.left)
    || !isFiniteBridgeNumber(metrics.top)
    || !isFiniteBridgeNumber(metrics.width)
    || !isFiniteBridgeNumber(metrics.height)
    || !isFiniteBridgeNumber(metrics.contentWidth)
    || !isFiniteBridgeNumber(metrics.contentHeight)
    || metrics.width <= 0
    || metrics.height <= 0
    || metrics.contentWidth <= 0
    || metrics.contentHeight <= 0
    || message.clientX < 0
    || message.clientX > metrics.contentWidth
    || message.clientY < 0
    || message.clientY > metrics.contentHeight) return null

  /** iframe 可因画布或布局缩放，内容坐标需按当前矩形比例转换。 */
  const scaleX = metrics.width / metrics.contentWidth
  const scaleY = metrics.height / metrics.contentHeight
  return {
    bubbles: true,
    cancelable: true,
    composed: true,
    ctrlKey: message.ctrlKey,
    metaKey: message.metaKey,
    deltaX: message.deltaX,
    deltaY: message.deltaY,
    deltaZ: message.deltaZ,
    deltaMode: message.deltaMode,
    clientX: metrics.left + message.clientX * scaleX,
    clientY: metrics.top + message.clientY * scaleY,
  }
}
