/** Canvas 图片内部允许记录的静态诊断码，禁止携带异常正文或敏感上下文。 */
export type CanvasImageDiagnosticCode =
  | 'CANVAS_IMAGE_BATCH_LISTENER_FAILED'
  | 'CANVAS_IMAGE_BATCH_CANCEL_CLEANUP_FAILED'
  | 'CANVAS_IMAGE_RUN_CANCEL_CLEANUP_FAILED'

/**
 * 尽力记录不含动态数据的 Canvas 图片诊断；日志实现故障不得影响业务结果。
 * @param code 允许公开到本地日志的封闭静态诊断码。
 * @returns 无返回值，且任何日志异常都会在内部被隔离。
 */
export function reportCanvasImageDiagnostic(code: CanvasImageDiagnosticCode): void {
  try {
    console.error(`[CanvasImageDiagnostics] ${code}`)
  } catch {
    /** 日志通道不属于业务提交边界，故障时保持静默。 */
  }
}
